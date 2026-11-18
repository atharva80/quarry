/**
 * Smart search: query embedding → int8 brute-force cosine (WASM) ∥ D1 FTS5 BM25 → weighted reciprocal rank fusion
 * (2:1) → personal score with reasons. A bge-reranker stage exists but is off: it measured worse (eval 2). Every stage degrades: no Workers AI → keyword only;
 * no D1 → vector only; nothing → empty with mode "unavailable" (the client keeps its in-browser keyword results).
 */
import { type CatalogProgram, excludedBy, type Profile, scoreProgram } from "../../ranking/score";
import { ftsSearch, getMatrix, type ProgramRow, programDoc, programsByIds, toCatalog } from "./data";
import { quantiseQuery, topK } from "./vectors";

export const EMBED_MODEL = "@cf/google/embeddinggemma-2";
export const RERANK_MODEL = "@cf/baai/bge-reranker-base";
const RRF_K = 60;

export interface SearchOptions {
  k?: number;
  profile?: Profile | null;
  liveOnly?: boolean;
  rerank?: boolean;
  /** program ids to leave out (agent's "already shown") */
  exclude?: Set<string>;
  filters?: { platforms?: string[]; categories?: string[]; bountyOnly?: boolean; minUsd?: number };
}

export interface SearchHit {
  id: string;
  score: number;
  reasons: string[];
  relevance: number;
  personal?: number;
  row: ProgramRow;
}

export async function embedQuery(env: Env, q: string): Promise<number[]> {
  // biome-ignore lint/suspicious/noExplicitAny: model typings lag the catalog
  const r: any = await env.AI.run(
    EMBED_MODEL as any,
    { input: [`task: search result | query: ${q}`], dimensions: 256 } as any,
  );
  return r.data[0].embedding as number[];
}

/** Weighted reciprocal rank fusion. Weights picked on the dev queries (evals/results/search.json): vector 2, keyword 1. */
export function rrf(lists: { id: string }[][], weights: number[] = [2, 1], k = RRF_K): Map<string, number> {
  const s = new Map<string, number>();
  lists.forEach((list, li) => {
    const w = weights[li] ?? 1;
    list.forEach((x, i) => {
      s.set(x.id, (s.get(x.id) ?? 0) + w / (k + i + 1));
    });
  });
  return s;
}

function passesFilters(p: ProgramRow, o: SearchOptions): boolean {
  if (o.liveOnly !== false && !p.live) return false;
  const f = o.filters;
  if (!f) return true;
  if (f.platforms?.length && !f.platforms.includes(p.platform)) return false;
  if (f.bountyOnly && !p.bounty) return false;
  if (f.minUsd && p.max_usd > 0 && p.max_usd < f.minUsd) return false;
  if (f.categories?.length) {
    const cats = p.categories.split(" ");
    if (!f.categories.some((c) => cats.includes(c))) return false;
  }
  return true;
}

export async function search(
  env: Env,
  q: string,
  o: SearchOptions = {},
): Promise<{
  mode: "hybrid" | "keyword" | "vector" | "unavailable";
  results: SearchHit[];
  timings: Record<string, number>;
}> {
  const k = Math.min(o.k ?? 10, 30);
  const t: Record<string, number> = {};
  const t0 = Date.now();
  const query = q.trim().slice(0, 300);

  const vecP = (async () => {
    const [emb, { m, k: kernel }] = await Promise.all([embedQuery(env, query), getMatrix(env)]);
    t.embed_ms = Date.now() - t0;
    return topK(m, quantiseQuery(emb), 80, undefined, kernel).map((h) => ({ id: m.ids[h.i], cos: h.score }));
  })().catch((e) => {
    console.error("vector search failed", String(e).slice(0, 200));
    return null;
  });
  const ftsP = ftsSearch(env, query, 80).catch((e) => {
    console.error("fts failed", String(e).slice(0, 200));
    return null;
  });
  const [vec, fts] = await Promise.all([vecP, ftsP]);
  t.retrieve_ms = Date.now() - t0;
  const mode = vec && fts ? "hybrid" : vec ? "vector" : fts ? "keyword" : "unavailable";
  if (mode === "unavailable") return { mode, results: [], timings: t };

  const fused = rrf([vec ?? [], fts ?? []]);
  const order = [...fused.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  const rows = await programsByIds(env, order.slice(0, 90));
  t.d1_ms = Date.now() - t0;
  const candidates: { id: string; fused: number; row: ProgramRow }[] = [];
  for (const id of order) {
    const row = rows.get(id);
    if (!row || !passesFilters(row, o) || o.exclude?.has(id)) continue;
    candidates.push({ id, fused: fused.get(id) ?? 0, row });
    if (candidates.length >= 30) break;
  }

  // rerank the top 30 (cheap: ~283 neurons per M tokens)
  let relevance = new Map<string, number>();
  const maxFused = Math.max(...candidates.map((c) => c.fused), 1e-9);
  for (const c of candidates) relevance.set(c.id, c.fused / maxFused);
  // Off by default: on the dev queries bge-reranker-base lowered nDCG@10 (see evals/results/search.json).
  if (o.rerank === true && candidates.length > 1) {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: model typings lag the catalog
      const rr: any = await env.AI.run(
        RERANK_MODEL as any,
        {
          query,
          contexts: candidates.map((c) => ({ text: programDoc(c.row) })),
          top_k: candidates.length,
        } as any,
      );
      const scores: { id: number; score: number }[] = rr?.response ?? [];
      if (scores.length) {
        const mx = Math.max(...scores.map((s) => s.score));
        const mn = Math.min(...scores.map((s) => s.score));
        const next = new Map<string, number>();
        for (const s of scores) {
          const c = candidates[s.id];
          // blend: reranker dominates, fused rank keeps keyword-exact hits from sinking
          if (c) next.set(c.id, 0.7 * ((s.score - mn) / (mx - mn || 1)) + 0.3 * (c.fused / maxFused));
        }
        relevance = next;
      }
      t.rerank_ms = Date.now() - t0;
    } catch (e) {
      console.error("rerank failed", String(e).slice(0, 200));
    }
  }

  const now = Date.now() / 1000;
  const out: SearchHit[] = [];
  for (const c of candidates) {
    const rel = relevance.get(c.id) ?? 0;
    const cat = toCatalog(c.row, now) as CatalogProgram;
    let score = rel;
    let reasons: string[] = [];
    let personal: number | undefined;
    if (o.profile) {
      if (excludedBy(cat, o.profile)) continue; // hard constraints
      const s = scoreProgram(cat, o.profile, now);
      personal = s.score;
      score = 0.65 * rel + 0.35 * s.score;
      reasons = s.reasons;
    } else {
      reasons = scoreProgram(cat, {}, now).reasons.filter((r) => !r.startsWith("fits"));
    }
    out.push({ id: c.id, score: Math.round(score * 1000) / 1000, relevance: rel, personal, reasons, row: c.row });
  }
  out.sort((a, b) => b.score - a.score);
  t.total_ms = Date.now() - t0;
  return { mode, results: out.slice(0, k), timings: t };
}
