"""Re-score hard-constraint violations from saved agent transcripts (no new model calls).

The first scoring checked every turn against constraints the user only states later in the conversation
("only intigriti" in turn 2 can't apply to turn 1). Constraints are now checked on each conversation's final turn,
when all of them have been stated. Both numbers are kept in the results file.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def main(tier: str) -> None:
    items = json.loads((ROOT / f"evals/results/items/agent_{tier}.json").read_text())
    res_path = ROOT / f"evals/results/agent_{tier}.json"
    res = json.loads(res_path.read_text())
    final_viol = []
    for c in items["conversations"]:
        last = c["turns"][-1]
        final_viol += [f"{c['id']}: {v}" for v in last["hard_violations"]]
    res["hard_constraint_violations_all_turns_v1_scoring"] = res.pop("hard_constraint_violations_v1_scoring", res.get("hard_constraint_violations"))
    res["hard_constraint_violations"] = len(final_viol)
    res["hard_constraint_violations_detail"] = final_viol
    res["hard_constraint_scoring"] = "final turn of each conversation (all constraints stated); see agent_rescore.py"
    res_path.write_text(json.dumps(res, indent=2) + "\n")
    print(json.dumps({k: res[k] for k in ("hard_constraint_violations", "hard_constraint_violations_all_turns_v1_scoring", "hard_constraint_violations_detail")}, indent=1))


if __name__ == "__main__":
    main(sys.argv[1])
