"""Eval 2: search quality. Systems are re-implemented offline exactly as the Worker runs them:

  keyword       SQLite FTS5 BM25 over the same program text, same query builder, same column weights
  emb_f768      EmbeddingGemma-2 at 768 dims, float cosine
  emb_f256      EmbeddingGemma-2 at 256 dims, float cosine
  emb_i8_256    the shipped int8 matrix (256 dims, per-row scales), as in worker/src/vectors.ts
  hybrid        RRF(emb_i8_256 top 80, keyword top 80), k = 60
  hybrid_rerank hybrid top 30 reranked by bge-reranker-base, blended 0.7 rerank + 0.3 fused (as in search.ts)

    python -m quarry_evals.search_eval pool     # run all systems, write the pools to judge
    python -m quarry_evals.search_eval score    # nDCG@10 / recall@20 from judgments -> evals/results/search.json
"""

from __future__ import annotations

import json
import re
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

import httpx
import numpy as np

from quarry_pipeline import embed
from quarry_pipeline.llm import ACCOUNT_ID, Embedder, cf_token
from quarry_pipeline.normalize import LABELS, load_state, normalise, search_text

ROOT = Path(__file__).resolve().parents[3]
DATA = ROOT / "evals" / "data" / "search"
CACHE = ROOT / ".cache" / "eval" / "search"
RESULTS = ROOT / "evals" / "results"
STOP = {"the", "and", "for", "with", "programs", "program", "bounty", "bug", "that", "find", "show", "me", "any", "are", "on", "in", "of", "to", "a"}
SYSTEMS = ["keyword", "emb_f768", "emb_f256", "emb_i8_256", "hybrid", "hybrid_rerank"]


def fts_query(text: str) -> str:
    toks = [t for t in re.findall(r"[^\W_]+", text.lower()) if len(t) > 1][:12]
    kept = [t for t in toks if t not in STOP] or toks
    return " OR ".join(f'"{t}"' + ("*" if i == len(kept) - 1 and len(t) > 2 else "") for i, t in enumerate(kept))


def program_doc(p: dict) -> str:
    """Same text the Worker reranks on (data.ts programDoc)."""
    reward = (f"pays up to {p['reward_max']}" if p["reward_max"] else "bug bounty") if p["bounty"] else "VDP, no bounty"
    return f"{p['name']} — {LABELS.get(p['platform'], p['platform'])}, {p['state']}, {reward}. Assets: {' '.join(p['categories']) or 'unknown'}. Tags: {', '.join(p['tags'])}"


def judge_doc(p: dict) -> str:
    idents = [a["i"] for a in p["assets"] if a["in"]][:12]
    return (f"{p['name']} ({LABELS.get(p['platform'], p['platform'])}; {'bounty up to ' + p['reward_max'] if p['bounty'] and p['reward_max'] else 'bounty' if p['bounty'] else 'VDP'}; "
            f"{'contest' if p['contest'] else 'program'}) | categories: {', '.join(p['categories'])} | tags: {', '.join(p['tags'][:6])} | scope: {'; '.join(i[:80] for i in idents)}")


def corpus() -> list[dict]:
    st = ROOT / ".cache" / "bbwatch"
    progs = normalise(load_state(str(st / "state.json.gz")), json.loads((st / "targets.json").read_text()), time.time())
    return [p for p in progs if p["live"]]


class Systems:
    def __init__(self, progs: list[dict]):
        self.progs = progs
        self.ids = [p["id"] for p in progs]
        self.by_id = {p["id"]: p for p in progs}
        self.db = sqlite3.connect(":memory:")
        self.db.execute("CREATE VIRTUAL TABLE f USING fts5(id UNINDEXED, name, body, tokenize = 'unicode61 remove_diacritics 2')")
        self.db.executemany("INSERT INTO f VALUES (?, ?, ?)", [(p["id"], p["name"], search_text(p)[:20000]) for p in progs])
        CACHE.mkdir(parents=True, exist_ok=True)
        self.e256 = self._doc_emb(256)
        self.e768 = self._doc_emb(768)
        q, scales = embed.quantise(self.e256)
        self.i8 = q.astype(np.int32)
        self.i8_scales = scales
        self.http = httpx.Client(timeout=60)

    def _doc_emb(self, dims: int) -> np.ndarray:
        f = CACHE / f"docs_{dims}.npz"
        from quarry_pipeline.normalize import embed_text
        texts = [embed_text(p) for p in self.progs]
        key = str(hash(tuple(texts)) & 0xFFFFFFFF)
        if f.exists():
            z = np.load(f, allow_pickle=True)
            if str(z["key"]) == key:
                return z["m"]
        m = np.asarray(Embedder(dims).embed(texts, "document"), dtype=np.float32)
        np.savez(f, m=m, key=key)
        return m

    def query_emb(self, qs: list[str], dims: int) -> np.ndarray:
        f = CACHE / f"queries_{dims}.json"
        cache = json.loads(f.read_text()) if f.exists() else {}
        todo = [q for q in qs if q not in cache]
        if todo:
            for q, v in zip(todo, Embedder(dims).embed(todo, "query"), strict=True):
                cache[q] = v
            f.write_text(json.dumps(cache))
        return np.asarray([cache[q] for q in qs], dtype=np.float32)

    def keyword(self, q: str, k: int = 80) -> list[str]:
        expr = fts_query(q)
        if not expr:
            return []
        rows = self.db.execute("SELECT id FROM f WHERE f MATCH ? ORDER BY bm25(f, 0.0, 4.0, 1.0) LIMIT ?", (expr, k)).fetchall()
        return [r[0] for r in rows]

    @staticmethod
    def _cos_rank(mat: np.ndarray, qv: np.ndarray, ids: list[str], k: int) -> list[str]:
        m = mat / np.linalg.norm(mat, axis=1, keepdims=True)
        s = m @ (qv / np.linalg.norm(qv))
        return [ids[i] for i in np.argsort(-s)[:k]]

    def emb_f(self, qv: np.ndarray, dims: int, k: int = 80) -> list[str]:
        return self._cos_rank(self.e768 if dims == 768 else self.e256, qv, self.ids, k)

    def emb_i8(self, qv: np.ndarray, k: int = 80) -> list[str]:
        qn = qv / np.linalg.norm(qv)
        mx = np.abs(qn).max()
        qq = np.round(qn / mx * 127).astype(np.int32)
        s = (self.i8 @ qq) * self.i8_scales
        return [self.ids[i] for i in np.argsort(-s)[:k]]

    @staticmethod
    def rrf(lists: list[list[str]], k: int = 60) -> dict[str, float]:
        out: dict[str, float] = {}
        for lst in lists:
            for i, pid in enumerate(lst):
                out[pid] = out.get(pid, 0.0) + 1 / (k + i + 1)
        return out

    def rerank(self, q: str, cands: list[str], fused: dict[str, float]) -> list[str]:
        url = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/@cf/baai/bge-reranker-base"
        body = {"query": q, "contexts": [{"text": program_doc(self.by_id[c])} for c in cands], "top_k": len(cands)}
        for attempt in range(4):
            r = self.http.post(url, headers={"Authorization": f"Bearer {cf_token()}"}, json=body)
            if r.status_code == 200:
                break
            time.sleep(2 ** attempt)
        r.raise_for_status()
        scores = r.json()["result"]["response"]
        mx, mn = max(s["score"] for s in scores), min(s["score"] for s in scores)
        fmax = max(fused[c] for c in cands)
        blend = {cands[s["id"]]: 0.7 * ((s["score"] - mn) / ((mx - mn) or 1)) + 0.3 * (fused[cands[s["id"]]] / fmax) for s in scores}
        return sorted(cands, key=lambda c: -blend.get(c, 0))

    def run_all(self, queries: list[dict]) -> dict[str, dict[str, list[str]]]:
        qs = [x["q"] for x in queries]
        q256, q768 = self.query_emb(qs, 256), self.query_emb(qs, 768)
        out: dict[str, dict[str, list[str]]] = {s: {} for s in SYSTEMS}
        for i, x in enumerate(queries):
            kw = self.keyword(x["q"])
            i8 = self.emb_i8(q256[i])
            fused = self.rrf([i8, kw])
            hyb = sorted(fused, key=lambda c: -fused[c])
            out["keyword"][x["id"]] = kw[:30]
            out["emb_f768"][x["id"]] = self.emb_f(q768[i], 768)[:30]
            out["emb_f256"][x["id"]] = self.emb_f(q256[i], 256)[:30]
            out["emb_i8_256"][x["id"]] = i8[:30]
            out["hybrid"][x["id"]] = hyb[:30]
            out["hybrid_rerank"][x["id"]] = self.rerank(x["q"], hyb[:30], fused) if len(hyb) > 1 else hyb[:30]
        return out


def pool(depth: int = 10) -> None:
    queries = json.loads((DATA / "queries.json").read_text())["queries"]
    progs = corpus()
    sysm = Systems(progs)
    runs = sysm.run_all(queries)
    (CACHE / "runs.json").write_text(json.dumps(runs))
    pools = []
    for x in queries:
        ids = []
        for s in SYSTEMS:
            for pid in runs[s][x["id"]][:depth]:
                if pid not in ids:
                    ids.append(pid)
        pools.append({"qid": x["id"], "q": x["q"], "docs": [{"id": pid, "doc": judge_doc(sysm.by_id[pid])} for pid in ids]})
    (CACHE / "pools.json").write_text(json.dumps(pools, ensure_ascii=False, indent=0))
    print(f"{len(pools)} queries, {sum(len(p['docs']) for p in pools)} pairs to judge; corpus {len(progs)} open programs")


def ndcg(ranked: list[str], rel: dict[str, int], k: int = 10) -> float:
    dcg = sum((2 ** rel.get(pid, 0) - 1) / np.log2(i + 2) for i, pid in enumerate(ranked[:k]))
    ideal = sorted(rel.values(), reverse=True)[:k]
    idcg = sum((2 ** g - 1) / np.log2(i + 2) for i, g in enumerate(ideal))
    return float(dcg / idcg) if idcg > 0 else 0.0


def recall(ranked: list[str], rel: dict[str, int], k: int = 20, min_grade: int = 2) -> float | None:
    relevant = {p for p, g in rel.items() if g >= min_grade}
    if not relevant:
        return None
    return len(relevant & set(ranked[:k])) / len(relevant)


def score() -> None:
    runs = json.loads((CACHE / "runs.json").read_text())
    judg = json.loads((DATA / "judgments.json").read_text())
    rel = judg["judgments"]
    queries = json.loads((DATA / "queries.json").read_text())["queries"]
    test_ids = [x["id"] for x in queries if int(x["id"][1:]) > 30]
    dev_ids = [x["id"] for x in queries if int(x["id"][1:]) <= 30]
    table = {}
    for s in SYSTEMS:
        row = {}
        for name, ids in (("test", test_ids), ("dev", dev_ids), ("all", test_ids + dev_ids)):
            nd = [ndcg(runs[s][q], rel.get(q, {})) for q in ids]
            rc = [r for r in (recall(runs[s][q], rel.get(q, {})) for q in ids) if r is not None]
            row[name] = {"ndcg@10": round(float(np.mean(nd)), 4), "recall@20": round(float(np.mean(rc)), 4) if rc else None,
                         "queries": len(ids), "queries_with_relevant": len(rc)}
        table[s] = row
    commit = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    out = {"eval": "search", "date": time.strftime("%Y-%m-%dT%H:%MZ", time.gmtime()), "commit": commit,
           "corpus": "open programs at eval time", "judged_by": judg.get("judged_by"),
           "notes": "Relevance pooled from the top 10 of every system, graded 0-3 (evals/data/search/RUBRIC.md). "
                    "Unjudged documents count as 0, so recall@20 (relevant = grade >= 2) is a lower bound for every system. "
                    "q001-q030 dev, q031-q100 hold-out test (never used for tuning).",
           "systems": table}
    RESULTS.mkdir(parents=True, exist_ok=True)
    (RESULTS / "search.json").write_text(json.dumps(out, indent=2) + "\n")
    print(json.dumps(table, indent=1))


if __name__ == "__main__":
    {"pool": pool, "score": score}[sys.argv[1]]()
