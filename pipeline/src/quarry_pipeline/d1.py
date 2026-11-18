"""D1 access for the pipeline: SQL generation + `wrangler d1 execute` with rows-written accounting.

The pipeline only ever upserts rows whose content changed (see `plan_program_upserts`), because the
Free plan allows 100,000 rows written per day and every index / FTS shadow row counts.
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import time
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path

from .normalize import search_text

ROOT = Path(__file__).resolve().parents[3]
WORKER_DIR = ROOT / "worker"
RECENT_DAYS = 90
MAX_STMT = 90_000  # D1 limit is 100 KB per statement


def q(v) -> str:
    """SQL literal."""
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, int | float):
        return str(int(v)) if isinstance(v, bool) or float(v).is_integer() else repr(float(v))
    s = str(v).replace("\x00", "")
    return "'" + s.replace("'", "''") + "'"


def insert(table: str, row: dict, upsert_key: str | None = None) -> str:
    cols = ", ".join(row)
    vals = ", ".join(q(v) for v in row.values())
    verb = "INSERT OR REPLACE" if upsert_key else "INSERT"
    return f"{verb} INTO {table} ({cols}) VALUES ({vals});"


def program_row(p: dict, rules: str | None = None, rules_hash: str | None = None) -> dict:
    return {
        "id": p["id"], "platform": p["platform"], "name": p["name"], "url": p["url"], "state": p["state"],
        "live": p["live"], "bounty": p["bounty"], "contest": p["contest"], "reward_min": p["reward_min"] or None,
        "reward_max": p["reward_max"] or None, "max_usd": p["max_usd"], "listed_at": p["listed_at"] or None,
        "updated_at": p["updated_at"] or None, "scope_changed_at": p["scope_changed_at"] or None,
        "categories": " ".join(p["categories"]), "tags": json.dumps(p["tags"], ensure_ascii=False),
        "n_in_scope": p["n_in_scope"], "n_paid": p["n_paid"], "new_7d": p["new_7d"], "new_14d": p["new_14d"], "new_30d": p["new_30d"],
        "wild_new_30d": p["wild_new_30d"], "latest_added_at": p["latest_added_at"] or None, "hash": p["hash"],
        "rules": rules, "rules_hash": rules_hash,
    }


def diff_key(p: dict) -> str:
    """What decides whether a program row must be rewritten: content, plus the time-relative counters."""
    return f"{p['hash']}:{p['new_7d']}:{p['new_14d']}:{p['new_30d']}:{p['wild_new_30d']}"


@dataclass
class Plan:
    statements: list[str] = field(default_factory=list)
    upserted: list[str] = field(default_factory=list)
    deleted: list[str] = field(default_factory=list)
    fts_changed: int = 0

    def add(self, s: str) -> None:
        if len(s.encode()) > MAX_STMT:
            raise ValueError(f"statement too long ({len(s)} bytes)")
        self.statements.append(s)


def plan_program_upserts(programs: Iterable[dict], current: dict[str, tuple[str, str]], now: float) -> Plan:
    """current: id -> (hash, diff_key) as stored in D1 now (hash in col `hash`, counters in their columns).

    Only programs whose diff_key changed are written; FTS and recent_assets only when the content hash changed.
    Programs no longer in bbwatch are deleted.
    """
    plan = Plan()
    seen = set()
    cut = now - RECENT_DAYS * 86400
    for p in programs:
        seen.add(p["id"])
        old = current.get(p["id"])
        if old and old[1] == diff_key(p):
            continue
        content_changed = not old or old[0] != p["hash"]
        row = program_row(p)
        # keep rules columns as they are: rules are written by the rules step, not here
        cols = [c for c in row if c not in ("rules", "rules_hash")]
        vals = ", ".join(q(row[c]) for c in cols)
        updates = ", ".join(f"{c}=excluded.{c}" for c in cols if c != "id")
        plan.add(f"INSERT INTO programs ({', '.join(cols)}) VALUES ({vals}) ON CONFLICT(id) DO UPDATE SET {updates};")
        plan.upserted.append(p["id"])
        if content_changed:
            plan.fts_changed += 1
            if old:
                plan.add(f"DELETE FROM programs_fts WHERE id = {q(p['id'])};")
                plan.add(f"DELETE FROM recent_assets WHERE program_id = {q(p['id'])};")
            body = search_text(p)[:20000]
            plan.add(insert("programs_fts", {"id": p["id"], "name": p["name"], "body": body}))
            for a in p["assets"]:
                if a["in"] and a["at"] >= cut:
                    plan.add(insert("recent_assets", {"program_id": p["id"], "ident": a["i"][:500], "cat": a["c"],
                                                      "paid": a["paid"], "added_at": a["at"]}, upsert_key="pk"))
    for pid in set(current) - seen:
        plan.deleted.append(pid)
        for t, col in (("programs", "id"), ("programs_fts", "id"), ("recent_assets", "program_id")):
            plan.add(f"DELETE FROM {t} WHERE {col} = {q(pid)};")
    return plan


# ---------- running SQL ----------

def _wrangler(args: list[str], timeout: int = 600) -> str:
    cmd = ["npx", "--yes", "wrangler", *args]
    res = subprocess.run(cmd, cwd=WORKER_DIR, capture_output=True, text=True, timeout=timeout,
                         env={**os.environ, "WRANGLER_SEND_METRICS": "false"})
    if res.returncode != 0:
        raise RuntimeError(f"wrangler {' '.join(args[:3])} failed: {res.stderr[-2000:] or res.stdout[-2000:]}")
    return res.stdout


def _parse_json(out: str):
    start = min((i for i in (out.find("["), out.find("{")) if i >= 0), default=-1)
    return json.loads(out[start:]) if start >= 0 else None


def query(db: str, sql: str) -> list[dict]:
    out = _wrangler(["d1", "execute", db, "--remote", "--json", "--command", sql])
    data = _parse_json(out) or []
    rows = []
    for r in data if isinstance(data, list) else [data]:
        rows.extend(r.get("results") or [])
    return rows


@dataclass
class ExecResult:
    statements: int
    rows_written: int
    rows_read: int
    seconds: float


def execute(db: str, statements: list[str], chunk: int = 2000) -> ExecResult:
    """Run statements in files of `chunk` statements; sum rows_written/rows_read from D1's meta."""
    written = read = 0
    t0 = time.time()
    for i in range(0, len(statements), chunk):
        part = statements[i:i + chunk]
        with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False) as f:
            f.write("\n".join(part))
            path = f.name
        try:
            out = _wrangler(["d1", "execute", db, "--remote", "--json", "--yes", "--file", path], timeout=900)
        finally:
            os.unlink(path)
        data = _parse_json(out)
        for r in data if isinstance(data, list) else [data] if data else []:
            meta = r.get("meta") or {}
            written += int(meta.get("rows_written") or 0)
            read += int(meta.get("rows_read") or 0)
    return ExecResult(len(statements), written, read, time.time() - t0)


def current_programs(db: str) -> dict[str, tuple[str, str]]:
    rows = query(db, "SELECT id, hash, new_7d, new_14d, new_30d, wild_new_30d FROM programs")
    return {r["id"]: (r["hash"], f"{r['hash']}:{r['new_7d']}:{r['new_14d']}:{r['new_30d']}:{r['wild_new_30d']}") for r in rows}
