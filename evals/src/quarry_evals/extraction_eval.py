"""Eval 1: rule extraction against agent-labelled policies.

    python -m quarry_evals.extraction_eval --split dev|test|all [--model primary|fallback] [--limit N] [--tag NAME]

Metrics: per-field accuracy, quote faithfulness (raw model quotes found verbatim in the policy, before grounding),
wrong "scanning allowed" answers (final card says yes/limited while the label says no/unclear; target 0),
cost and latency per policy. Results → evals/results/extraction_<split>_<model>[_tag].json (+ per-item rows).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from quarry_pipeline.llm import LLM, Ledger
from quarry_pipeline.rules import extract

ROOT = Path(__file__).resolve().parents[3]
DATA = ROOT / "evals" / "data" / "extraction"
POL = ROOT / ".cache" / "eval" / "policies"
RESULTS = ROOT / "evals" / "results"
FIELDS = ["scanning", "rate_limit", "required_header", "test_accounts", "excluded_classes", "safe_harbour", "bounty_table", "disclosure"]
NONE = {"none stated", "unclear", "none", "", "n/a", "not stated"}


def labels() -> dict[str, dict]:
    out = {}
    for f in sorted((DATA / "labels").glob("*.json")):
        for x in json.loads(f.read_text()):
            out[x["program_id"]] = x
    return out


def _none(v) -> bool:
    return str(v or "").strip().lower() in NONE


def _nums(s: str) -> set[str]:
    return set(re.findall(r"\d+(?:\.\d+)?", str(s)))


def field_correct(f: str, label, pred) -> bool:
    if f in ("scanning", "safe_harbour"):
        return str(label) == str(pred)
    if f == "rate_limit":
        if _none(label):
            return _none(pred)
        return not _none(pred) and bool(_nums(label) & _nums(pred))
    if f == "required_header":
        if _none(label):
            return _none(pred)
        p = str(pred).lower()
        lab = str(label).lower()
        if _none(pred):
            return False
        if lab in ("user-agent", "user agent"):
            return "user-agent" in p or "user agent" in p or ":" not in p
        return lab.replace("-", "") in p.replace("-", "").replace(" ", "")
    if f == "test_accounts" or f == "disclosure":
        return (label in ("stated",)) == (not _none(pred))
    if f == "bounty_table":
        p = str(pred).lower()
        if label == "vdp":
            return "no bounty" in p or "vdp" in p
        if label == "unclear":
            return _none(pred)
        return not _none(pred) and "no bounty" not in p
    if f == "excluded_classes":
        return excluded_recall(label, pred) >= 0.5
    raise KeyError(f)


def _toks(s: str) -> set[str]:
    return {t for t in re.findall(r"[a-z0-9]+", s.lower()) if len(t) > 2 and t not in {"the", "and", "attacks", "issues", "vulnerabilities", "without", "missing"}}


def excluded_recall(label: list, pred: list) -> float:
    if not label:
        return 1.0 if not pred else 0.5  # listing exclusions the labeller didn't is a soft miss
    pt = [_toks(p) for p in (pred or [])]
    hit = sum(1 for lab in label if any(_toks(lab) & t for t in pt))
    return hit / len(label)


def run(split: str, model: str, limit: int | None, tag: str, workers: int = 4, cap: float = 3.0) -> dict:
    man = json.loads((DATA / "manifest.json").read_text())["items"]
    lab = labels()
    only = set(filter(None, os.environ.get("QUARRY_EVAL_IDS", "").split(",")))
    items = [m for m in man if (split == "all" or m["split"] == split) and m["program_id"] in lab
             and (not only or m["program_id"] in only)][: limit or None]
    ledger = Ledger("quarry-db")
    llm = LLM(cap_usd=cap, primary=(model == "primary"), ledger=ledger)

    def one(m):
        text = (POL / (m["program_id"].replace(":", "__").replace("/", "_") + ".md")).read_text()
        t0 = time.time()
        try:
            card, meta = extract(llm, m["program_id"], m["platform"], text)
        except Exception as e:  # noqa: BLE001
            return {"program_id": m["program_id"], "error": str(e)[:200]}
        return {"program_id": m["program_id"], "platform": m["platform"], "card": card, "meta": meta, "seconds": round(time.time() - t0, 2)}

    with ThreadPoolExecutor(max_workers=workers) as ex:
        rows = list(ex.map(one, items))
    ledger.flush(llm.usage.usd)

    per_field = {f: [] for f in FIELDS}
    faithful = [0, 0]
    wrong_allowed, wrong_allowed_ids, failures = 0, [], 0
    costs, lats = [], []
    for r in rows:
        if not r.get("card"):
            failures += 1
            continue
        L = lab[r["program_id"]]["labels"]
        for f in FIELDS:
            per_field[f].append(field_correct(f, L[f], r["card"][f]["value"]))
        for st in (r["meta"].get("grounding") or {}).values():
            if st in ("ok", "quote_not_found"):
                faithful[0] += st == "ok"
                faithful[1] += 1
        if r["card"]["scanning"]["value"] in ("yes", "limited") and L["scanning"] in ("no", "unclear"):
            wrong_allowed += 1
            wrong_allowed_ids.append(r["program_id"])
        costs.append(sum(a.get("usd", 0) for a in r["meta"]["attempts"]))
        lats.append(r["seconds"])
        r["labels"] = L
    n = len(rows) - failures
    commit = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    out = {
        "eval": "rule extraction", "split": split, "model": llm.model, "date": time.strftime("%Y-%m-%dT%H:%MZ", time.gmtime()),
        "commit": commit, "labels": "agent-labelled (Claude Sonnet 5.5, two passes); owner reviews 20 (docs/evals.md)",
        "policies": len(rows), "failed": failures,
        "accuracy": {f: round(sum(v) / len(v), 3) if v else None for f, v in per_field.items()},
        "accuracy_mean": round(statistics.mean(sum(v) / len(v) for v in per_field.values() if v), 3) if n else None,
        "quote_faithfulness": round(faithful[0] / faithful[1], 3) if faithful[1] else None,
        "quotes_checked": faithful[1],
        "wrong_scanning_allowed": wrong_allowed, "wrong_scanning_allowed_ids": wrong_allowed_ids,
        "usd_per_policy": round(statistics.mean(costs), 5) if costs else None, "usd_total": round(sum(costs), 4),
        "latency_s_p50": round(statistics.median(lats), 2) if lats else None,
        "latency_s_p95": round(sorted(lats)[int(0.95 * (len(lats) - 1))], 2) if lats else None,
        "scanning_confusion": confusion(rows),
    }
    RESULTS.mkdir(parents=True, exist_ok=True)
    name = f"extraction_{split}_{model}{'_' + tag if tag else ''}"
    (RESULTS / f"{name}.json").write_text(json.dumps(out, indent=2) + "\n")
    (RESULTS / "items").mkdir(exist_ok=True)
    (RESULTS / "items" / f"{name}.jsonl").write_text("\n".join(json.dumps({k: r.get(k) for k in ("program_id", "card", "labels", "seconds", "error")}, ensure_ascii=False) for r in rows) + "\n")
    return out


def confusion(rows) -> dict:
    c: dict[str, int] = {}
    for r in rows:
        if r.get("card") and r.get("labels"):
            k = f"label={r['labels']['scanning']} pred={r['card']['scanning']['value']}"
            c[k] = c.get(k, 0) + 1
    return dict(sorted(c.items()))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", default="dev")
    ap.add_argument("--model", default="primary")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--tag", default="")
    ap.add_argument("--cap", type=float, default=3.0)
    a = ap.parse_args()
    res = run(a.split, a.model, a.limit, a.tag, cap=a.cap)
    print(json.dumps({k: v for k, v in res.items() if k != "wrong_scanning_allowed_ids"}, indent=1))
