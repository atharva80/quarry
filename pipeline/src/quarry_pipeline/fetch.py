"""Policy refresh: which programs to (re)fetch this run, fetched one host at a time, stored in D1 + local cache.

Refetch a program's policy when: never fetched, its bbwatch content hash changed since the last fetch, or the
stored copy is older than REFRESH_DAYS (rotating, capped per run). Immunefi is one conditional feed request.
Each platform runs in its own thread, so hosts are polled in parallel but each host sees ≤ 1 request/second.
"""

from __future__ import annotations

import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import d1
from .policies import POLICY_PLATFORMS, Client, HostLimiter, Policy, fetch_immunefi_feed, fetch_one, immunefi_policy

ROOT = Path(__file__).resolve().parents[3]
CACHE = ROOT / ".cache" / "policies"
REFRESH_DAYS = 7


def load_meta(db: str) -> dict[str, dict]:
    rows = d1.query(db, "SELECT program_id, version, hash, fetched_at, program_hash, source_url FROM policies")
    return {r["program_id"]: r for r in rows}


def due(programs: list[dict], meta: dict[str, dict], now: float, per_platform_cap: int = 2000,
        rotate_cap: int = 40) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {p: [] for p in POLICY_PLATFORMS}
    rotated: dict[str, int] = {}
    for p in sorted(programs, key=lambda x: (not x["live"], -x["updated_at"])):
        plat = p["platform"]
        if plat not in POLICY_PLATFORMS or plat == "immunefi" or not p["live"]:
            continue
        m = meta.get(p["id"])
        if m and m.get("program_hash") == p["hash"] and now - (m.get("fetched_at") or 0) < REFRESH_DAYS * 86400:
            continue
        if m and m.get("program_hash") == p["hash"]:  # just old: rotate a few per run
            rotated[plat] = rotated.get(plat, 0) + 1
            if rotated[plat] > rotate_cap:
                continue
        if len(out[plat]) < per_platform_cap:
            out[plat].append(p)
    return out


def save_local(pol: Policy) -> None:
    CACHE.mkdir(parents=True, exist_ok=True)
    (CACHE / (pol.program_id.replace(":", "__").replace("/", "_") + ".json")).write_text(
        json.dumps({"program_id": pol.program_id, "source_url": pol.source_url, "version": pol.version,
                    "hash": pol.hash, "text": pol.text}, ensure_ascii=False))


def load_local(pid: str) -> dict | None:
    f = CACHE / (pid.replace(":", "__").replace("/", "_") + ".json")
    return json.loads(f.read_text()) if f.exists() else None


def run(db: str | None, programs: list[dict], now: float, immunefi_etag: str | None = None,
        per_platform_cap: int = 2000, log=print) -> dict:
    """Fetch due policies. Returns {"policies": {pid: Policy}, "stats": {...}, "immunefi_etag": str}."""
    meta = load_meta(db) if db else {}
    todo = due(programs, meta, now, per_platform_cap)
    limiter = HostLimiter()
    got: dict[str, Policy] = {}
    stats = {"requests": 0, "fetched": 0, "unchanged": 0, "failed": 0, "by_platform": {}}
    lock = threading.Lock()
    clients: list[Client] = []

    def worker(plat: str, items: list[dict]) -> None:
        c = Client(limiter)
        clients.append(c)
        ok = fail = same = 0
        for p in items:
            res = fetch_one(c, p, (meta.get(p["id"]) or {}).get("version"))
            if res == "unchanged":
                same += 1
                with lock:
                    got[p["id"]] = None  # type: ignore[assignment]  # touch fetched_at only
            elif res is None:
                fail += 1
            else:
                ok += 1
                res.program_id = p["id"]
                with lock:
                    got[p["id"]] = res
        with lock:
            stats["by_platform"][plat] = {"due": len(items), "fetched": ok, "unchanged": same, "failed": fail}

    t0 = time.time()
    with ThreadPoolExecutor(max_workers=4) as ex:
        futs = [ex.submit(worker, plat, items) for plat, items in todo.items() if items]
        # Immunefi: one conditional feed request, fanned out locally
        c = Client(limiter)
        clients.append(c)
        try:
            feed, etag = fetch_immunefi_feed(c, immunefi_etag)
        except Exception as e:  # noqa: BLE001
            feed, etag = None, immunefi_etag
            log(f"immunefi feed failed: {e}")
        n_imm = 0
        if feed:
            live = {p["handle"]: p for p in programs if p["platform"] == "immunefi" and p["live"]}
            for entry in feed:
                slug = entry.get("slug") or entry.get("id")
                prog = live.get(slug)
                if not prog:
                    continue
                pol = immunefi_policy(entry)
                old = meta.get(prog["id"])
                if pol and (not old or old.get("hash") != pol.hash):
                    got[prog["id"]] = pol
                    n_imm += 1
        stats["by_platform"]["immunefi"] = {"feed": "304 not modified" if feed is None else "200", "changed": n_imm}
        for f in futs:
            f.result()
    stats["requests"] = sum(c.requests for c in clients)
    stats["seconds"] = round(time.time() - t0, 1)
    for c in clients:
        c.close()
    stats["fetched"] = sum(1 for v in got.values() if v)
    stats["unchanged"] = sum(1 for v in got.values() if v is None)
    for pol in got.values():
        if pol:
            save_local(pol)
    # policies whose text changed since the stored copy: keep the old text for the change summary
    changed_ids = [pid for pid, pol in got.items() if pol and meta.get(pid) and meta[pid].get("hash") != pol.hash]
    changed: list[tuple[str, str, str]] = []
    if db and changed_ids:
        for i in range(0, len(changed_ids), 50):
            part = changed_ids[i:i + 50]
            rows = d1.query(db, "SELECT program_id, text FROM policies WHERE program_id IN (" + ",".join(d1.q(x) for x in part) + ")")
            for r in rows:
                changed.append((r["program_id"], r["text"], got[r["program_id"]].text))
    stats["policy_text_changed"] = len(changed)
    if db:
        by_id = {p["id"]: p for p in programs}
        stmts = []
        for pid, pol in got.items():
            ph = by_id[pid]["hash"]
            if pol is None:
                stmts.append(f"UPDATE policies SET fetched_at = {int(now)}, program_hash = {d1.q(ph)} WHERE program_id = {d1.q(pid)};")
            else:
                stmts.append(d1.insert("policies", {"program_id": pid, "source_url": pol.source_url, "fetched_at": int(now),
                                                    "version": pol.version, "hash": pol.hash, "program_hash": ph,
                                                    "text": pol.text}, upsert_key="pk"))
        if stmts:
            stats["d1"] = d1.execute(db, stmts, chunk=200).__dict__
    return {"policies": {k: v for k, v in got.items() if v}, "stats": stats, "immunefi_etag": etag, "changed": changed}
