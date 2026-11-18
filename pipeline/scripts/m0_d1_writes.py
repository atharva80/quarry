"""M0 test (c): rows written by a 1,000-program import, lean layout vs fully normalised layout.

Runs against the scratch database `quarry-db-scratch` (never the real one) and writes
evals/results/m0_d1_writes.json.
"""
import json
import random
import subprocess
import sys
import time
from pathlib import Path

from quarry_pipeline import d1
from quarry_pipeline.normalize import load_state, normalise

DB = "quarry-db-scratch"
ROOT = Path(__file__).resolve().parents[2]


def main(state_dir: str) -> None:
    state = load_state(f"{state_dir}/state.json.gz")
    targets = json.load(open(f"{state_dir}/targets.json"))
    now = time.time()
    progs = normalise(state, targets, now)
    random.Random(7).shuffle(progs)
    sample = sorted(progs[:1000], key=lambda p: p["id"])
    out = {"programs": len(sample), "in_scope_assets": sum(p["n_in_scope"] for p in sample)}

    # A. lean layout (what we ship): programs + FTS + recent_assets (90 d)
    plan = d1.plan_program_upserts(sample, {}, now)
    res = d1.execute(DB, plan.statements)
    out["lean"] = {"statements": res.statements, "rows_written": res.rows_written, "seconds": round(res.seconds, 1),
                   "recent_assets": sum(1 for s in plan.statements if s.startswith("INSERT OR REPLACE INTO recent_assets"))}

    # B. idempotent re-run: the planner should emit nothing
    cur = d1.current_programs(DB)
    plan2 = d1.plan_program_upserts(sample, cur, now)
    out["rerun_unchanged"] = {"statements": len(plan2.statements)}

    # C. fully normalised: every in-scope asset as a row, with an index on added_at
    stmts = ["CREATE TABLE IF NOT EXISTS assets_full (program_id TEXT NOT NULL, ident TEXT NOT NULL, type TEXT, cat TEXT,"
             " paid INTEGER, tier TEXT, added_at INTEGER, PRIMARY KEY (program_id, ident)) WITHOUT ROWID;",
             "CREATE INDEX IF NOT EXISTS assets_full_added ON assets_full(added_at);"]
    for p in sample:
        for a in p["assets"]:
            if a["in"]:
                stmts.append(d1.insert("assets_full", {"program_id": p["id"], "ident": a["i"][:500], "type": a["t"],
                                                      "cat": a["c"], "paid": a["paid"], "tier": a["tier"] or None,
                                                      "added_at": a["at"] or None}, upsert_key="pk"))
    res = d1.execute(DB, stmts)
    out["full_assets_table"] = {"statements": res.statements, "rows_written": res.rows_written,
                                "seconds": round(res.seconds, 1)}
    commit = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    out["commit"] = commit or "uncommitted"
    out["date"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    out["bbwatch_state_saved_at"] = state.get("saved_at")
    path = ROOT / "evals/results/m0_d1_writes.json"
    path.write_text(json.dumps(out, indent=2) + "\n")
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main(sys.argv[1])
