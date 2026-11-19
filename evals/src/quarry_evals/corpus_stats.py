"""Corpus size + a full-import write measurement on the scratch D1 database (never the live one).
Writes evals/results/corpus.json and evals/results/d1_full_import.json."""

import json
import subprocess
import time
from pathlib import Path

from quarry_pipeline import d1
from quarry_pipeline.normalize import load_state, normalise

ROOT = Path(__file__).resolve().parents[3]
SCRATCH = "quarry-db-scratch"


def main() -> None:
    st = ROOT / ".cache" / "bbwatch"
    now = time.time()
    state = load_state(str(st / "state.json.gz"))
    progs = normalise(state, json.loads((st / "targets.json").read_text()), now)
    commit = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    stamp = time.strftime("%Y-%m-%dT%H:%MZ", time.gmtime())
    corpus = {"date": stamp, "commit": commit, "bbwatch_state_saved_at": state.get("saved_at"),
              "programs": len(progs), "open": sum(p["live"] for p in progs),
              "platforms": len({p["platform"] for p in progs}),
              "in_scope_assets": sum(p["n_in_scope"] for p in progs),
              "assets_total": sum(len(p["assets"]) for p in progs)}
    (ROOT / "evals/results/corpus.json").write_text(json.dumps(corpus, indent=2) + "\n")
    # fresh scratch tables, then the same planner the build uses
    drops = ["DROP TABLE IF EXISTS programs;", "DROP TABLE IF EXISTS programs_fts;", "DROP TABLE IF EXISTS recent_assets;",
             "DROP TABLE IF EXISTS assets_full;"]
    d1.execute(SCRATCH, drops)
    d1._wrangler(["d1", "execute", SCRATCH, "--remote", "--yes", "--file", str(ROOT / "pipeline/sql/schema.sql")])
    plan = d1.plan_program_upserts(progs, {}, now)
    res = d1.execute(SCRATCH, plan.statements)
    rerun = d1.plan_program_upserts(progs, d1.current_programs(SCRATCH), now)
    out = {"date": stamp, "commit": commit, "database": SCRATCH, "programs": len(progs), "statements": res.statements,
           "rows_written": res.rows_written, "rerun_statements": len(rerun.statements),
           "layout": "programs + programs_fts + recent_assets (90 d), as shipped"}
    (ROOT / "evals/results/d1_full_import.json").write_text(json.dumps(out, indent=2) + "\n")
    print(json.dumps({"corpus": corpus, "import": out}, indent=1))


if __name__ == "__main__":
    main()
