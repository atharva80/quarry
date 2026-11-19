"""Static site build: catalog, per-program JSON, program pages, change feed, Atom feeds, sitemap.

Everything here is served as free static assets. Pages work without JavaScript; `web/` adds islands.
Output: worker/public/ (≤ 20,000 files per Workers version: ~3.4k pages + ~3.4k JSON + a few dozen others).
"""

from __future__ import annotations

import datetime as dt
import json
import re
import shutil
from pathlib import Path
from xml.sax.saxutils import escape

from jinja2 import Environment, FileSystemLoader, select_autoescape

from .normalize import DAY, LABELS

ROOT = Path(__file__).resolve().parents[3]
PUBLIC = ROOT / "worker" / "public"
TEMPLATES = ROOT / "web" / "templates"
WEB_DIST = ROOT / "web" / "dist"
SITE_URL = "https://quarry.quarry-worker.workers.dev"

LIMITS = [
    ("Workers: 10 ms CPU per request, 100k requests/day", "Precompute everything in the hourly build; only light work runs live."),
    ("Static assets: free and unlimited, 20,000 files per version", "Static-first: every program page and its JSON are files; the Worker only runs for /api/* and /mcp."),
    ("D1: 100k rows written/day, 5M read", "D1 holds only what the Worker queries (programs, FTS, recent assets); full scopes live in static JSON. Full import: 14,570 rows written."),
    ("Vectorize: 5M stored / 30M queried dimensions a month", "No Vectorize: brute-force cosine over a static 3,442 × 256 int8 matrix in WebAssembly SIMD (p50 2 ms CPU)."),
    ("Workers AI: 10,000 neurons/day", "Embeddings (154 neurons/M tokens) and reranking are nearly free; the fallback LLM is budgeted."),
    ("Durable Objects (SQLite) on Free: 100k requests/day", "One Agent DO per chatting user, hibernating between turns."),
    ("Workers Logs: 200k events/day", "Log errors plus a 1% sample; never request bodies."),
    ("GitHub Actions: free on public repos, cron can run late", "The pipeline is a site build: fetch, build, deploy hourly at :17. Freshness is measured, not assumed."),
]

SAFE_SEG = re.compile(r"[^A-Za-z0-9._-]+")


def program_path(pid: str) -> tuple[str, str]:
    """(page path, json path) for a program id. Handles become filesystem-safe segments."""
    plat, _, handle = pid.partition(":")
    seg = re.sub(r"\.{2,}", "-", SAFE_SEG.sub("-", handle)).strip("-.") or "x"
    if seg != handle:
        seg = f"{seg}-{abs(hash_str(handle)) % 100000}"
    return f"/p/{plat}/{seg}/", f"/data/p/{plat}/{seg}.json"


def hash_str(s: str) -> int:
    h = 0
    for ch in s:
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    return h


def iso(t: int | float | None) -> str:
    return dt.datetime.fromtimestamp(t, dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ") if t else ""


def rules_summary(card: dict | None) -> dict | None:
    if not card:
        return None
    scan = (card.get("scanning") or {}).get("value")
    rl = (card.get("rate_limit") or {}).get("value")
    hdr = (card.get("required_header") or {}).get("value")
    return {"scan": scan or "unclear", "rl": rl if rl and rl not in ("unclear", "none stated") else "",
            "hdr": bool(hdr and hdr not in ("unclear", "none stated"))}


def catalog_row(p: dict, rules: dict | None, now: float) -> dict:
    path, _ = program_path(p["id"])
    sample = [a["i"] for a in p["assets"] if a["in"]][:8]
    return {
        "id": p["id"], "path": path, "p": p["platform"], "pn": p["platform_name"], "n": p["name"], "u": p["url"],
        "s": p["state"], "b": int(p["bounty"]), "c": int(p["contest"]), "mx": p["reward_max"] or "", "usd": p["max_usd"],
        "L": p["listed_at"], "U": p["updated_at"], "cat": p["categories"], "t": p["tags"], "na": p["n_in_scope"],
        "np": p["n_paid"], "n7": p["new_7d"], "n14": p["new_14d"], "n30": p["new_30d"], "w30": p["wild_new_30d"],
        "la": p["latest_added_at"], "sc": sample, "rules": rules_summary(rules),
        "age": int((now - p["listed_at"]) / DAY) if p["listed_at"] else None,
    }


def map_changes(changes: dict | None, programs: list[dict], now: float, days: int = 30) -> list[dict]:
    by_url = {}
    for p in programs:
        if p["url"]:
            by_url[p["url"].rstrip("/").lower()] = p["id"]
    from .normalize import ts
    out = []
    for e in (changes or {}).get("entries") or []:
        t = ts(e.get("ts"))
        if not t or t < now - days * DAY:
            continue
        pid = by_url.get(str(e.get("url") or "").rstrip("/").lower())
        title = re.sub(r"^[^\w\[(]+", "", str(e.get("title") or "")).strip()
        out.append({"id": e.get("id"), "ts": t, "kind": e.get("kind"), "prio": e.get("prio"), "pid": pid,
                    "platform": e.get("tag"), "title": title, "body": str(e.get("body") or "")[:2000],
                    "summary": title, "url": e.get("url")})
    out.sort(key=lambda x: -x["ts"])
    return out


def write_json(path: Path, doc) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")))


def atom(title: str, self_url: str, entries: list[dict], updated: str) -> str:
    items = []
    for e in entries[:100]:
        link = SITE_URL + program_path(e["pid"])[0] if e.get("pid") else (e.get("url") or SITE_URL + "/changes/")
        items.append(
            "<entry>"
            f"<id>urn:quarry:change:{escape(str(e['id']))}</id>"
            f"<title>{escape(e['title'])}</title>"
            f"<updated>{iso(e['ts'])}</updated>"
            f'<link href="{escape(link)}"/>'
            f"<category term=\"{escape(str(e['kind']))}\"/>"
            f"<content type=\"text\">{escape(e['body'])}</content>"
            "</entry>")
    return ('<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">'
            f"<title>{escape(title)}</title><id>{escape(self_url)}</id>"
            f'<link rel="self" href="{escape(self_url)}"/><link href="{SITE_URL}/changes/"/>'
            f"<updated>{updated}</updated><author><name>Quarry</name></author>{''.join(items)}</feed>\n")


def build(programs: list[dict], changes: dict | None, status: dict | None, rules: dict[str, dict],
          rule_status: dict[str, str], policy_urls: dict[str, str], ops: dict, now: float,
          out: Path = PUBLIC, analytics_token: str = "") -> dict:
    """Write the whole static site into `out`. Returns counts for the build report."""
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    generated = iso(now)
    source_updated = (status or {}).get("updated") or ""
    rows = [catalog_row(p, rules.get(p["id"]), now) for p in programs]
    by_id = {r["id"]: r for r in rows}
    entries = map_changes(changes, programs, now)
    for e in entries:
        e["path"] = by_id[e["pid"]]["path"] if e.get("pid") in by_id else None
    per_prog: dict[str, list[dict]] = {}
    for e in entries:
        if e.get("pid"):
            per_prog.setdefault(e["pid"], []).append(e)

    # the browser's copy: no platform URL (on the program page) and a short scope sample, to keep it ~1 MB
    slim = [{**{k: v for k, v in r.items() if k != "u"}, "sc": [x[:60] for x in r["sc"][:4]]} for r in rows]
    write_json(out / "data/catalog.json", {"generated": generated, "source_updated": source_updated, "programs": slim})
    write_json(out / "data/changes.json", {"generated": generated, "entries": entries})

    env = Environment(loader=FileSystemLoader(TEMPLATES), autoescape=select_autoescape(["html", "xml"]),
                      trim_blocks=True, lstrip_blocks=True)
    env.filters["date"] = lambda t: iso(t)[:10] if t else "—"
    env.filters["ago"] = _ago(now)
    site = {"name": "Quarry", "url": SITE_URL, "generated": generated, "source_updated": source_updated,
            "analytics_token": analytics_token}

    def render(tpl: str, path: str, title: str, description: str, **ctx) -> None:
        html = env.get_template(tpl).render(site=site, page={"title": title, "description": description, "path": path,
                                                             "canonical": SITE_URL + path}, **ctx)
        target = out / path.lstrip("/") / "index.html" if path.endswith("/") else out / path.lstrip("/")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(html)

    pages = 0
    for p, row in zip(programs, rows, strict=True):
        full = {**row, "assets": p["assets"], "rules": rules.get(p["id"]), "rules_source": policy_urls.get(p["id"], ""),
                "rules_status": rule_status.get(p["id"], "not_available"), "changes": per_prog.get(p["id"], [])[:20],
                "hunter": p["hunter"], "when": p["when"], "reward_min": p["reward_min"],
                "listed_source": p["listed_source"], "listed_iso": iso(p["listed_at"]), "updated_iso": iso(p["updated_at"])}
        page_path, json_path = program_path(p["id"])
        full["json_path"] = json_path
        write_json(out / json_path.lstrip("/"), full)
        state = "accepting reports" if p["live"] else p["state"]
        desc = (f"{p['name']} on {p['platform_name']}: {p['n_in_scope']} in-scope assets, "
                f"{'pays up to ' + p['reward_max'] if p['bounty'] and p['reward_max'] else 'bounty' if p['bounty'] else 'VDP'}, {state}.")
        render("program.html", page_path, f"{p['name']} · {p['platform_name']}", desc, p=full)
        pages += 1

    open_rows = sorted((r for r in rows if r["s"] == "open"), key=lambda r: -(r["L"] or 0))
    fresh = sorted((r for r in open_rows if r["n30"]), key=lambda r: (-(r["la"] or 0), r["id"]))[:30]
    platforms = sorted(({"key": k, "name": LABELS.get(k, k), "count": sum(1 for r in open_rows if r["p"] == k)}
                        for k in {r["p"] for r in open_rows}), key=lambda x: -x["count"])
    stats = {"programs": len(rows), "open": len(open_rows), "assets": sum(p["n_in_scope"] for p in programs),
             "platforms": len({r["p"] for r in rows}), "changes_7d": sum(1 for e in entries if e["ts"] >= now - 7 * DAY)}
    cats = sorted({c for r in open_rows for c in r["cat"]})
    render("index.html", "/", "Quarry: find the bug-bounty programs worth your time today",
           "Tell Quarry what you hunt. It finds the programs worth your time today, explains why, and tells you what each program allows.",
           stats=stats, fresh=fresh)
    render("browse.html", "/browse/", "Browse open programs", f"All {len(open_rows)} open bug-bounty programs across {len(platforms)} platforms.",
           programs=open_rows, platforms=platforms, categories=cats)
    render("changes.html", "/changes/", "New and changed programs", "Scope additions, new programs and policy changes from the last 30 days.",
           entries=entries)
    render("chat.html", "/chat/", "Ask Quarry", "Chat with Quarry to find programs that fit how you hunt.")
    render("alerts.html", "/alerts/", "Alerts", "Get pinged on Telegram, Discord, Web Push or RSS when a program fits you.")
    render("about.html", "/about/", "How Quarry works (on $0)", "How Quarry runs on Cloudflare's free plan.",
           limits=[{"limit": a, "consequence": b} for a, b in LIMITS], architecture=ARCHITECTURE)
    render("privacy.html", "/privacy/", "Privacy", "What Quarry stores (almost nothing) and how to delete it.")
    render("status.html", "/status/", "Status", "Freshness, quotas and pipeline health.", status=ops)
    render("404.html", "/404.html", "Not found", "Page not found.")

    # feeds
    feeds = out / "feeds"
    feeds.mkdir(parents=True, exist_ok=True)
    (feeds / "all.xml").write_text(atom("Quarry · all program changes", f"{SITE_URL}/feeds/all.xml", entries, generated))
    for plat in sorted({e.get("platform") for e in entries if e.get("platform")}):
        sub = [e for e in entries if e.get("platform") == plat]
        (feeds / f"{plat}.xml").write_text(atom(f"Quarry · {LABELS.get(plat, plat)} changes", f"{SITE_URL}/feeds/{plat}.xml", sub, generated))

    # sitemap
    urls = ["/", "/browse/", "/changes/", "/chat/", "/alerts/", "/about/", "/privacy/", "/status/"] + [r["path"] for r in rows]
    (out / "sitemap.xml").write_text('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
                                     + "".join(f"<url><loc>{SITE_URL}{escape(u)}</loc></url>" for u in urls) + "</urlset>\n")
    write_json(out / "data/status.json", ops)

    # client bundle + PWA files
    if WEB_DIST.exists():
        shutil.copytree(WEB_DIST, out, dirs_exist_ok=True)
    (out / "robots.txt").write_text(f"User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: {SITE_URL}/sitemap.xml\n")
    nfiles = sum(1 for _ in out.rglob("*") if _.is_file())
    return {"pages": pages, "files": nfiles, "catalog_rows": len(rows), "changes": len(entries)}


def _ago(now: float):
    def f(t):
        if not t:
            return "—"
        d = (now - t) / DAY
        if d < 1:
            h = int((now - t) / 3600)
            return f"{max(h, 1)} h ago"
        if d < 60:
            return f"{int(d)} d ago"
        return iso(t)[:10]
    return f


ARCHITECTURE = """GitHub Actions (hourly at :17, Python): the site build
  bbwatch state (read-only) → diff → D1 upserts (only changed rows)
  → fetch changed policies (1 req/s/host) → extract rules (LLM, schema-validated, quotes checked)
  → embed changed programs (EmbeddingGemma-2, 256 dims) → static pages + int8 vector file → wrangler deploy

Cloudflare Worker "quarry" (TypeScript)
  static assets (free): program pages + JSON, catalog, change feed, Atom, sitemap, PWA
  /api/* (Hono): search, chat, ask, feedback, alerts, scope check      /mcp: createMcpHandler (stateless)
  QuarryAgent Durable Object (Agents SDK): one per user — chat, memory, daily digest
  Budget Durable Object: global daily LLM spend cap
  D1 quarry-db: programs, FTS5, recent assets, changes, policies, subscriptions, feedback
  Workers AI: query embeddings, reranker, fallback LLM    AI Gateway quarry: LLM routing + analytics"""
