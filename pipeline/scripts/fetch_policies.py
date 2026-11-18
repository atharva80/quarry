"""One-off/initial policy fetch for all open programs on the supported platforms (the hourly build does the same incrementally)."""
import json
import sys
import time

from quarry_pipeline import fetch
from quarry_pipeline.normalize import load_state, normalise

state_dir = sys.argv[1]
now = time.time()
P = normalise(load_state(f"{state_dir}/state.json.gz"), json.load(open(f"{state_dir}/targets.json")), now)
res = fetch.run("quarry-db", P, now)
print(json.dumps(res["stats"], indent=1))
print("immunefi_etag", res["immunefi_etag"])
