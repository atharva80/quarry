"""PR check: 20-policy extraction subset (4 per platform, dev split) with the base prompt vs the PR's prompt,
plus the Worker's grounding/tool unit tests. Writes a Markdown table for the PR comment."""
import argparse
import json
import os
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def subset_ids() -> list[str]:
    man = json.loads((ROOT / "evals/data/extraction/manifest.json").read_text())["items"]
    out, per = [], {}
    for m in man:
        if m["split"] == "dev" and per.get(m["platform"], 0) < 4:
            per[m["platform"]] = per.get(m["platform"], 0) + 1
            out.append(m["program_id"])
    return out


def run(prompt_file: str, tag: str) -> dict:
    env = {**os.environ, "QUARRY_PROMPT_FILE": prompt_file, "QUARRY_EVAL_IDS": ",".join(subset_ids())}
    subprocess.run(["uv", "run", "python", "-m", "quarry_evals.extraction_eval", "--split", "dev", "--tag", tag, "--cap", "0.2"],
                   cwd=ROOT, env=env, check=True, capture_output=True)
    return json.loads((ROOT / f"evals/results/extraction_dev_primary_{tag}.json").read_text())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--out", default="pr-eval.md")
    a = ap.parse_args()
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as f:
        f.write(subprocess.run(["git", "show", f"{a.base}:prompts/extract_rules.md"], cwd=ROOT, capture_output=True, text=True, check=True).stdout)
        base_prompt = f.name
    before = run(base_prompt, "pr_base")
    after = run(str(ROOT / "prompts/extract_rules.md"), "pr_head")
    tests = subprocess.run(["npx", "vitest", "run", "--root", "worker"], cwd=ROOT, capture_output=True, text=True)
    rows = ["| Metric | base | PR |", "|---|---|---|"]
    for k in ("accuracy_mean", "quote_faithfulness", "wrong_scanning_allowed", "usd_per_policy", "latency_s_p50"):
        rows.append(f"| {k} | {before.get(k)} | {after.get(k)} |")
    for f in before["accuracy"]:
        rows.append(f"| accuracy.{f} | {before['accuracy'][f]} | {after['accuracy'][f]} |")
    body = ("### Extraction subset (20 dev policies)\n\n" + "\n".join(rows) +
            f"\n\n### Worker unit tests (grounding, tools, scope)\n\n{'passed' if tests.returncode == 0 else 'FAILED'}\n")
    Path(a.out).write_text(body)
    print(body)


if __name__ == "__main__":
    main()
