/**
 * Data access for the Worker. The static files are the source of truth for full program detail (free to serve);
 * D1 answers queries (FTS, filters, recent assets). Nothing here parses the 1 MB catalog: under a 10 ms CPU budget,
 * the Worker only touches the rows it needs.
 */
import dotWasm from "./dot.wasm";
import { type Matrix, parseMatrix, WasmDots } from "./vectors";

export interface ProgramRow {
  id: string;
  platform: string;
  name: string;
  url: string;
  state: string;
  live: number;
  bounty: number;
  contest: number;
  reward_max: string | null;
  max_usd: number;
  listed_at: number | null;
  updated_at: number | null;
  categories: string;
  tags: string;
  n_in_scope: number;
  n_paid: number;
  new_7d: number;
  new_14d: number;
  new_30d: number;
  wild_new_30d: number;
  latest_added_at: number | null;
  rules: string | null;
}

export const PLATFORM_NAMES: Record<string, string> = {
  h1: "HackerOne",
  bugcrowd: "Bugcrowd",
  intigriti: "Intigriti",
  ywh: "YesWeHack",
  immunefi: "Immunefi",
  cantina: "Cantina",
  hackenproof: "HackenProof",
  sherlock: "Sherlock",
  code4rena: "Code4rena",
  codehawks: "CodeHawks",
  standoff: "Standoff 365",
  issuehunt: "IssueHunt",
  bugrap: "Bugrap",
  bugbase: "BugBase",
  huntr: "huntr",
};

export { programPaths } from "./paths";

import { programPaths } from "./paths";

const ORIGIN = "https://quarry.internal";

async function asset(env: Env, path: string): Promise<Response> {
  const r = await env.ASSETS.fetch(new Request(ORIGIN + path));
  return r;
}

// ---------- vectors (per isolate) ----------

let matrix: Matrix | null = null;
let matrixAt = 0;
let kernel: WasmDots | null = null;

export async function getMatrix(env: Env): Promise<{ m: Matrix; k: WasmDots }> {
  if (!matrix || Date.now() - matrixAt > 15 * 60 * 1000) {
    const [bin, ids] = await Promise.all([
      asset(env, "/data/vectors.bin").then((r) => r.arrayBuffer()),
      asset(env, "/data/vectors.ids.json").then((r) => r.json() as Promise<string[]>),
    ]);
    matrix = parseMatrix(bin, ids);
    matrixAt = Date.now();
  }
  if (!kernel) kernel = new WasmDots(dotWasm);
  return { m: matrix, k: kernel };
}

// ---------- programs ----------

// biome-ignore lint/suspicious/noExplicitAny: JSON documents
export async function getProgramJson(env: Env, id: string): Promise<any | null> {
  if (!/^[a-z0-9]+:.{1,200}$/.test(id)) return null;
  const r = await asset(env, programPaths(id).json);
  if (!r.ok) return null;
  const ct = r.headers.get("content-type") ?? "";
  if (!ct.includes("json")) return null; // not_found_handling may serve HTML
  return r.json();
}

export async function programsByIds(env: Env, ids: string[]): Promise<Map<string, ProgramRow>> {
  const out = new Map<string, ProgramRow>();
  const uniq = [...new Set(ids)].slice(0, 90);
  if (!uniq.length) return out;
  const res = await env.DB.prepare(
    `SELECT id, platform, name, url, state, live, bounty, contest, reward_max, max_usd, listed_at, updated_at, categories, tags,
            n_in_scope, n_paid, new_7d, new_14d, new_30d, wild_new_30d, latest_added_at, rules
       FROM programs WHERE id IN (${uniq.map((_, i) => `?${i + 1}`).join(",")})`,
  )
    .bind(...uniq)
    .all<ProgramRow>();
  for (const r of res.results) out.set(r.id, r);
  return out;
}

/** Find programs by (fuzzy) name: exact id, exact name, then FTS on the name column. */
export async function resolveProgram(env: Env, ref: string): Promise<ProgramRow | null> {
  const s = ref.trim();
  if (!s) return null;
  if (/^[a-z0-9]+:/.test(s)) {
    const m = await programsByIds(env, [s]);
    if (m.size) return [...m.values()][0];
  }
  const exact = await env.DB.prepare(
    "SELECT id FROM programs WHERE lower(name) = lower(?1) ORDER BY live DESC, max_usd DESC LIMIT 1",
  )
    .bind(s)
    .first<{ id: string }>();
  if (exact) return (await programsByIds(env, [exact.id])).get(exact.id) ?? null;
  const q = ftsQuery(s, "AND", "name");
  if (!q) return null;
  const hit = await env.DB.prepare(
    "SELECT f.id FROM programs_fts f JOIN programs p ON p.id = f.id WHERE programs_fts MATCH ?1 ORDER BY p.live DESC, bm25(programs_fts) LIMIT 1",
  )
    .bind(q)
    .first<{ id: string }>();
  return hit ? ((await programsByIds(env, [hit.id])).get(hit.id) ?? null) : null;
}

/** Safe FTS5 MATCH expression from user text: quoted tokens, prefix on the last one. */
export function ftsQuery(text: string, op: "OR" | "AND" = "OR", column?: "name" | "body"): string {
  const toks = (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length > 1).slice(0, 12);
  if (!toks.length) return "";
  const STOP = new Set([
    "the",
    "and",
    "for",
    "with",
    "programs",
    "program",
    "bounty",
    "bug",
    "that",
    "find",
    "show",
    "me",
    "any",
    "are",
    "on",
    "in",
    "of",
    "to",
    "a",
  ]);
  const kept = toks.filter((t) => !STOP.has(t));
  const use = kept.length ? kept : toks;
  const terms = use.map((t, i) => `"${t}"${i === use.length - 1 && t.length > 2 ? "*" : ""}`);
  const expr = terms.join(` ${op} `);
  return column ? `${column} : (${expr})` : expr;
}

export async function ftsSearch(env: Env, q: string, limit = 50): Promise<{ id: string; rank: number }[]> {
  const expr = ftsQuery(q);
  if (!expr) return [];
  const res = await env.DB.prepare(
    "SELECT id, bm25(programs_fts, 0.0, 4.0, 1.0) AS s FROM programs_fts WHERE programs_fts MATCH ?1 ORDER BY s LIMIT ?2",
  )
    .bind(expr, limit)
    .all<{ id: string; s: number }>();
  return res.results.map((r, i) => ({ id: r.id, rank: i }));
}

export function programDoc(p: ProgramRow): string {
  const reward = p.bounty ? (p.reward_max ? `pays up to ${p.reward_max}` : "bug bounty") : "VDP, no bounty";
  return `${p.name} — ${PLATFORM_NAMES[p.platform] ?? p.platform}, ${p.state}, ${reward}. Assets: ${p.categories || "unknown"}. Tags: ${(JSON.parse(p.tags || "[]") as string[]).join(", ")}`;
}

/** Catalog-shaped view of a D1 row (for ranking/score.ts). */
export function toCatalog(p: ProgramRow, now: number) {
  let rules: { scan?: string; rl?: string; hdr?: boolean } | null = null;
  if (p.rules) {
    try {
      const r = JSON.parse(p.rules);
      rules = { scan: r?.scanning?.value, rl: r?.rate_limit?.value, hdr: !!r?.required_header?.value };
    } catch {
      rules = null;
    }
  }
  return {
    id: p.id,
    p: p.platform,
    pn: PLATFORM_NAMES[p.platform] ?? p.platform,
    n: p.name,
    s: p.state,
    b: p.bounty,
    c: p.contest,
    mx: p.reward_max ?? "",
    usd: p.max_usd,
    L: p.listed_at ?? 0,
    cat: p.categories ? p.categories.split(" ") : [],
    na: p.n_in_scope,
    n7: p.new_7d,
    n14: p.new_14d ?? p.new_7d,
    n30: p.new_30d,
    w30: p.wild_new_30d,
    rules,
    age: p.listed_at ? (now - p.listed_at) / 86400 : undefined,
  };
}
