"""Pick the fusion config on DEV queries only (q001-q030); the hold-out test set is scored once, afterwards."""
import json

import numpy as np

from quarry_evals.search_eval import CACHE, DATA, Systems, corpus, ndcg, recall

queries = json.loads((DATA / "queries.json").read_text())["queries"]
rel = json.loads((DATA / "judgments.json").read_text())["judgments"]
s = Systems(corpus())
qs = [x["q"] for x in queries]
q256 = s.query_emb(qs, 256)
cands = {}
for i, x in enumerate(queries):
    cands[x["id"]] = (s.emb_i8(q256[i]), s.keyword(x["q"]))


def wrrf(vec, kw, wv, wk, k=60):
    out = {}
    for w, lst in ((wv, vec), (wk, kw)):
        for r, pid in enumerate(lst):
            out[pid] = out.get(pid, 0) + w / (k + r + 1)
    return sorted(out, key=lambda p: -out[p])


def evaluate(ids, wv, wk):
    nd = [ndcg(wrrf(*cands[q], wv, wk), rel.get(q, {})) for q in ids]
    rc = [r for r in (recall(wrrf(*cands[q], wv, wk), rel.get(q, {})) for q in ids) if r is not None]
    return round(float(np.mean(nd)), 4), round(float(np.mean(rc)), 4)


dev = [x["id"] for x in queries if int(x["id"][1:]) <= 30]
test = [x["id"] for x in queries if int(x["id"][1:]) > 30]
grid = {f"wrrf_v{wv}_k{wk}": evaluate(dev, wv, wk) for wv, wk in ((1, 1), (2, 1), (3, 1), (4, 1), (1, 0))}
print("DEV", json.dumps(grid))
best = max(grid, key=lambda g: grid[g][0] + 0.25 * grid[g][1])
wv, wk = (int(best.split("_")[1][1:]), int(best.split("_")[2][1:]))
print("chosen on dev:", best, "-> TEST", evaluate(test, wv, wk))
(CACHE / "tune.json").write_text(json.dumps({"dev_grid": grid, "chosen": best, "test": evaluate(test, wv, wk)}))
