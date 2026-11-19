"""M6 quota drills against the live Worker. Simulates exhausted budgets through the admin-only budget hook,
checks what users get, and restores the real counters afterwards. Results -> evals/results/drills.json.

Drills that can't be simulated without actually burning a shared quota (Worker 100k requests, D1 writes) are
checked structurally instead: what serves without the Worker, and that a failed build never deploys.
"""

from __future__ import annotations

import json
import os
import secrets
import subprocess
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[3]
SITE = os.environ.get("QUARRY_URL", "https://quarry.quarry-worker.workers.dev")
H = {"authorization": f"Bearer {os.environ.get('ADMIN_TOKEN', '')}", "content-type": "application/json"}


def chat(msg: str) -> dict:
    r = httpx.post(f"{SITE}/api/chat", json={"uid": secrets.token_hex(16), "message": msg}, timeout=180)
    return {"status": r.status_code, **(r.json() if r.status_code == 200 else {"error": r.text[:200]})}


def main() -> None:
    from quarry_pipeline.llm import _load_dotenv  # noqa: F401  (loads ADMIN_TOKEN from .env)
    H["authorization"] = f"Bearer {os.environ['ADMIN_TOKEN']}"
    out = {"date": time.strftime("%Y-%m-%dT%H:%MZ", time.gmtime()),
           "commit": subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip()}
    st = httpx.get(f"{SITE}/api/status", timeout=30).json()
    today = st["days"][0]
    caps = st["caps"]
    try:
        # 1. LLM budget spent -> fallback model answers
        httpx.post(f"{SITE}/api/admin/budget-sim", headers=H, json={"usd": caps["usd"], "neurons": today["neurons"]}, timeout=30)
        r = chat("Recommend two web programs on HackerOne paying over $1000.")
        out["budget_spent"] = {"status": r["status"], "tier": r.get("tier"), "limited": r.get("limited", False),
                               "expect": "tier=fallback, still answers"}
        # 2. budget and neurons spent -> friendly limit message, HTTP 200
        httpx.post(f"{SITE}/api/admin/budget-sim", headers=H, json={"usd": caps["usd"], "neurons": caps["neurons"]}, timeout=30)
        r = chat("Recommend two web programs on HackerOne.")
        out["budget_and_neurons_spent"] = {"status": r["status"], "limited": r.get("limited", False), "reply": (r.get("reply") or "")[:160],
                                           "expect": "limited=true with the daily-limit message"}
        # search keeps working (embeddings are not LLM budget)
        s = httpx.post(f"{SITE}/api/search", json={"q": "graphql api"}, timeout=30).json()
        out["search_during_budget_limit"] = {"mode": s.get("mode"), "results": len(s.get("results", []))}
    finally:
        httpx.post(f"{SITE}/api/admin/budget-sim", headers=H, json={"usd": today["usd"], "neurons": today["neurons"]}, timeout=30)
        out["restored"] = httpx.get(f"{SITE}/api/status", timeout=30).json()["days"][0]
    # 3. Worker over its request cap: static assets never invoke the Worker (run_worker_first = /api/*, /mcp only)
    cfg = (ROOT / "worker" / "wrangler.jsonc").read_text()
    out["static_without_worker"] = {"run_worker_first": [x for x in ("/api/*", "/mcp") if f'"{x}"' in cfg],
                                    "note": "pages, program JSON, catalog, feeds and the in-browser keyword search are static assets, served free and uncapped"}
    # 4. D1 writes exhausted: the build raises before `wrangler deploy`, so the previous version stays live
    out["d1_writes_exhausted"] = {"note": "cli.build(): any D1 error raises before the deploy step; verified by code path, not by burning the quota"}
    (ROOT / "evals" / "results" / "drills.json").write_text(json.dumps(out, indent=2) + "\n")
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
