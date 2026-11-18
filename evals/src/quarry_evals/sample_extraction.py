"""Pick the 150 extraction-eval policies: 30 per platform, stratified, seeded; 10 dev + 20 test per platform.

Policy texts are third-party content, so they're not committed: the manifest pins each by content hash, and the
texts live in the pipeline's cache / D1 (`policies` table).
"""
import json
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CACHE = ROOT / ".cache" / "policies"
OUT = ROOT / "evals" / "data" / "extraction" / "manifest.json"
EVAL_CACHE = ROOT / ".cache" / "eval" / "policies"


def main() -> None:
    by_plat: dict[str, list[dict]] = {}
    for f in sorted(CACHE.glob("*.json")):
        d = json.loads(f.read_text())
        if len(d["text"]) < 1500:
            continue
        by_plat.setdefault(d["program_id"].split(":")[0], []).append(d)
    rng = random.Random(20261119)
    items = []
    for plat in sorted(by_plat):
        pool = sorted(by_plat[plat], key=lambda d: d["program_id"])
        rng.shuffle(pool)
        for i, d in enumerate(pool[:30]):
            items.append({"program_id": d["program_id"], "platform": plat, "split": "dev" if i < 10 else "test",
                          "hash": d["hash"], "chars": len(d["text"]), "source_url": d["source_url"]})
            EVAL_CACHE.mkdir(parents=True, exist_ok=True)
            (EVAL_CACHE / (d["program_id"].replace(":", "__").replace("/", "_") + ".md")).write_text(d["text"])
    OUT.write_text(json.dumps({"seed": 20261119, "per_platform": 30, "dev_per_platform": 10, "items": items}, indent=1))
    print(len(items), {p: sum(1 for x in items if x["platform"] == p) for p in by_plat})


if __name__ == "__main__":
    main()
