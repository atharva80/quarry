"""Weekly full eval run (evals-full.yml): extraction hold-out, search scoring, agent eval (primary)."""
import subprocess
import sys

STEPS = [
    ["python", "-m", "quarry_evals.extraction_eval", "--split", "test", "--tag", "weekly", "--cap", "0.5"],
    ["python", "-m", "quarry_evals.search_eval", "score"],
    ["python", "-m", "quarry_evals.agent_eval", "--tier", "primary"],
]

if __name__ == "__main__":
    failed = 0
    for s in STEPS:
        r = subprocess.run(["uv", "run", *s])
        failed += r.returncode != 0
    sys.exit(1 if failed else 0)
