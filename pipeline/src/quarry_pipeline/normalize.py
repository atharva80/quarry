"""bbwatch state -> Quarry's normalised program records.

The parsing rules (asset-type categories, date parsing, reward-to-USD, placeholder hosts, test listings)
are ported from bbwatch's own `dashboard.py` / `watch.py` so both tools agree on what a program is.
bbwatch is read-only: we never import from it, we only read its public data on the `state` branch.
"""

from __future__ import annotations

import datetime as dt
import gzip
import hashlib
import json
import re
from typing import Any

LABELS = {
    "h1": "HackerOne", "bugcrowd": "Bugcrowd", "intigriti": "Intigriti", "ywh": "YesWeHack",
    "immunefi": "Immunefi", "cantina": "Cantina", "hackenproof": "HackenProof", "sherlock": "Sherlock",
    "code4rena": "Code4rena", "codehawks": "CodeHawks", "standoff": "Standoff 365", "issuehunt": "IssueHunt",
    "bugrap": "Bugrap", "bugbase": "BugBase", "huntr": "huntr",
}

TYPE_CAT = {
    "url": "web", "website": "web", "web": "web", "domain": "web", "websites_and_applications": "web",
    "web-application": "web", "web_application": "web", "web app": "web", "website testing": "web",
    "wildcard": "wildcard", "api": "api", "api testing": "api", "graphql": "api",
    "android": "android", "google_play_app_id": "android", "other_apk": "android",
    "mobile-application-android": "android", "android application": "android",
    "ios": "ios", "apple_store_app_id": "ios", "other_ipa": "ios", "testflight": "ios",
    "mobile-application-ios": "ios", "ios application": "ios",
    "mobile": "mobile", "mobile-application": "mobile", "mobile_application": "mobile",
    "smart_contract": "contract", "smart contract": "contract", "contract": "contract", "blockchain": "contract",
    "blockchain_dlt": "contract", "protocol": "contract", "smart_contracts": "contract",
    "source_code": "code", "source code": "code", "github": "code", "repository": "code",
    "cidr": "network", "iprange": "network", "ip_address": "network", "ip": "network", "network": "network",
    "executable": "desktop", "downloadable_executables": "desktop", "windows_app_store_app_id": "desktop",
    "application": "desktop", "desktop": "desktop",
    "hardware": "hardware", "device": "hardware", "iot": "hardware",
    "ai_model": "ai", "ai": "ai", "llm": "ai",
}
CATEGORIES = ["web", "wildcard", "api", "android", "ios", "mobile", "contract", "code", "network", "desktop",
              "hardware", "ai", "other"]

FX = {"$": 1, "USD": 1, "USDC": 1, "USDT": 1, "DAI": 1, "€": 1.08, "EUR": 1.08, "£": 1.27, "GBP": 1.27,
      "¥": 0.0066, "JPY": 0.0066, "₽": 0.011, "RUB": 0.011, "CHF": 1.12, "AUD": 0.65, "CAD": 0.73,
      "INR": 0.012, "SGD": 0.74}

LIVE = {"open", "active", "live"}
DEAD = {"ended", "closed", "suspended", "archived", "finished"}

PLACEHOLDER_HOST = re.compile(
    r"^(?:[a-z][a-z0-9+.-]*://)?(?:[^/@\s]*@)?(?:\*\.)?(?:localhost|[^/:\s]*\.(?:invalid|test|example|localhost|local|lab|"
    r"internal|lan|home|corp))(?::\d+)?(?:[/?#]|$)", re.I)
TEST_LISTING = re.compile(r"^\s*\[?\s*test\b", re.I)
EXPLORER = re.compile(r"(?:^|[/.])(?:[a-z-]*scan\.(?:org|io|com|xyz|net)|explorer\.[a-z0-9.-]+|"
                      r"blockscout\.[a-z0-9.-]+|snowtrace\.io|tronscan\.org)/(?:[a-z0-9-]+/)?(?:#/)?(?:address|token|contract|account|object|"
                      r"package|tx)/", re.I)
CODEHOST = re.compile(r"(?:^|//|\.)(?:github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)/[^/\s]+/[^/\s]+", re.I)
_MIN = dt.datetime(2012, 1, 1, tzinfo=dt.UTC)
DAY = 86400


def to_dt(v: Any) -> dt.datetime | None:
    if v in (None, ""):
        return None
    try:
        if isinstance(v, int | float):
            return dt.datetime.fromtimestamp(v / 1000 if v > 1e12 else v, dt.UTC)
        s = str(v).strip().split("|", 1)[0]
        if s.isdigit():
            n = int(s)
            return dt.datetime.fromtimestamp(n / 1000 if n > 1e12 else n, dt.UTC)
        if "GMT" in s:
            d = dt.datetime.strptime(s.split(" GMT", 1)[0], "%a %b %d %Y %H:%M:%S")
        else:
            try:
                d = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
            except ValueError:
                d = dt.datetime.strptime(s, "%d %b %Y")
        return d if d.tzinfo else d.replace(tzinfo=dt.UTC)
    except (ValueError, OverflowError, OSError):
        return None


def ts(v: Any, now: float | None = None) -> int:
    """Unix seconds for a believable date (2012 .. ~a year ahead), else 0."""
    d = to_dt(v)
    limit = dt.datetime.fromtimestamp(now, dt.UTC) if now else dt.datetime.now(dt.UTC)
    if d and _MIN <= d <= limit + dt.timedelta(days=400):
        return int(d.timestamp())
    return 0


def usd(m: Any) -> int:
    if not m:
        return 0
    s = str(m)
    mo = re.search(r"([0-9][0-9,]*)(\.[0-9]+)?\s*(k|m|million|mln)?\b", s, re.I)
    if not mo:
        return 0
    val = float(mo.group(1).replace(",", "") + (mo.group(2) or ""))
    suf = (mo.group(3) or "").lower()
    val *= 1_000 if suf == "k" else 1_000_000 if suf in ("m", "million", "mln") else 1
    rate = next((FX[c] for c in ("$", "€", "£", "¥", "₽") if c in s), None)
    if rate is None:
        code = re.search(r"\b([A-Z]{3,4})\b", s)
        rate = FX.get(code.group(1)) if code else None
    return int(val * rate) if rate else 0


def type_cat(typ: Any, ident: str = "") -> str:
    t = str(typ or "").strip().lower()
    if t in TYPE_CAT:
        cat = TYPE_CAT[t]
    elif "contract" in t or "blockchain" in t:
        cat = "contract"
    elif "android" in t or "apk" in t:
        cat = "android"
    elif "ios" in t or "ipa" in t:
        cat = "ios"
    elif "mobile" in t:
        cat = "mobile"
    elif "api" in t:
        cat = "api"
    elif "source" in t or "code" in t or "github" in t:
        cat = "code"
    elif "web" in t or "url" in t or "domain" in t or "site" in t:
        cat = "web"
    else:
        cat = "other"
    ident = str(ident)
    if cat in ("web", "other", "wildcard") and EXPLORER.search(ident):
        return "contract"
    if cat in ("web", "other") and CODEHOST.search(ident):
        return "code"
    if cat in ("web", "other") and ident.startswith("*."):
        return "wildcard"
    if cat == "other" and ident.startswith("0x"):
        return "contract"
    if cat == "other" and re.match(r"^(https?://)?([a-z0-9-]+\.)+[a-z]{2,}(/|$)", ident, re.I) and " " not in ident:
        return "web"
    return cat


def is_placeholder(ident: str) -> bool:
    return bool(PLACEHOLDER_HOST.match(str(ident or "").strip()))


def program_state(r: dict) -> str:
    s = str(r.get("state") or r.get("ann") or "").lower()
    if s in ("active", "live"):
        return "open"
    return s or "unknown"


def load_state(path: str) -> dict:
    with gzip.open(path, "rt") as f:
        return json.load(f)


def seen_index(targets: dict | None) -> dict[tuple[str, str, str], int]:
    """(platform, key, asset) -> newest time bbwatch saw it added (targets.json)."""
    seen: dict[tuple[str, str, str], int] = {}
    for e in (targets or {}).get("entries") or []:
        t = ts(e.get("ts"))
        k = (e.get("src"), e.get("key"), e.get("asset"))
        if t and e.get("why") in ("new", "added", "paid", "readded") and t > seen.get(k, 0):
            seen[k] = t
    return seen


def normalise(state: dict, targets: dict | None = None, now: float | None = None) -> list[dict]:
    """Every real program (no QA fixtures, no placeholder-only scopes), one dict each, sorted by id."""
    now = now or dt.datetime.now(dt.UTC).timestamp()
    seen = seen_index(targets)
    out = []
    for plat, src in sorted((state.get("sources") or {}).items()):
        if plat == "mirror" or not isinstance(src, dict):
            continue
        for key, r in sorted((src.get("programs") or {}).items()):
            if not isinstance(r, dict) or TEST_LISTING.match(str(r.get("name") or "")):
                continue
            rec = _program(plat, key, r, seen, now)
            if rec is not None:
                out.append(rec)
    return out


def _program(plat: str, key: str, r: dict, seen: dict, now: float) -> dict | None:
    raw_assets = r.get("assets") or {}
    added, aupd, tiers = r.get("added") or {}, r.get("aupd") or {}, r.get("tier") or {}
    rtab = r.get("rtab") or []
    rows_by_id = {row[5]: row[0] for row in rtab if len(row) > 5}
    assets = []
    for k, a in raw_assets.items():
        if not a:
            continue
        typ, _, ident = k.partition("|")
        ad = max(ts(added.get(k), now), seen.get((plat, key, ident), 0))
        tier = tiers.get(k, "")
        tier = rows_by_id.get(tier, "") if rows_by_id else str(tier or "")
        if not tier and len(a) > 2 and a[2]:
            tier = str(a[2]).capitalize()
        paid = a[1] is True or (a[1] is None and bool(r.get("bounty")))
        assets.append({
            "i": ident, "t": typ, "c": type_cat(typ, ident), "in": bool(a[0]), "paid": bool(paid and a[0]),
            "tier": tier, "at": ad,
        })
    ins = [a for a in assets if a["in"]]
    if ins and all(is_placeholder(a["i"]) for a in ins):
        return None  # a fixture nobody outside can reach
    ins_real = [a for a in ins if not is_placeholder(a["i"])]
    cats = sorted({a["c"] for a in ins_real})
    st = program_state(r)
    first = ts(r.get("first_seen"), now)
    listed_p = ts(r.get("listed"), now) or ts(r.get("date"), now)
    updated = max(ts(r.get("updated"), now), ts(r.get("sig"), now), ts(r.get("scope_changed"), now))
    meta = r.get("meta") or {}
    m = r.get("m") or {}

    def new_within(days: int, wild_only: bool = False) -> int:
        cut = now - days * DAY
        return sum(1 for a in ins_real if a["at"] >= cut and (not wild_only or a["c"] == "wildcard" or a["i"].startswith("*.")))

    assets.sort(key=lambda a: (-a["at"], not a["in"], not a["paid"], a["i"].lower()))
    rec = {
        "id": f"{plat}:{key}",
        "platform": plat,
        "platform_name": LABELS.get(plat, plat),
        "handle": key,
        "name": str(r.get("name") or key).strip(),
        "url": r.get("url") or "",
        "state": st,
        "live": st in LIVE,
        "bounty": bool(r.get("bounty")),
        "contest": bool(r.get("contest")),
        "when": r.get("when") or "",
        "reward_min": r.get("min") or "",
        "reward_max": r.get("max") or "",
        "max_usd": usd(r.get("max")),
        "listed_at": listed_p or first,
        "listed_source": "platform" if listed_p else "first seen by bbwatch",
        "updated_at": max(updated, first),
        "first_seen": first,
        "scope_changed_at": ts(r.get("scope_changed"), now),
        "categories": cats,
        "tags": [str(t) for t in (r.get("tags") or [])][:12],
        "hunter": {k2: v for k2, v in (("reputation_required", meta.get("rep")), ("submission_fee", meta.get("fee")),
                                       ("resolved_reports", m.get("reports") or meta.get("reports")),
                                       ("response_efficiency_pct", m.get("resp"))) if v is not None},
        "ref": r.get("ref") or None,
        "n_in_scope": len(ins_real),
        "n_paid": sum(1 for a in ins_real if a["paid"]),
        "n_out": sum(1 for a in assets if not a["in"]),
        "new_7d": new_within(7),
        "new_14d": new_within(14),
        "new_30d": new_within(30),
        "wild_new_30d": new_within(30, wild_only=True),
        "latest_added_at": max((a["at"] for a in ins_real), default=0),
        "assets": assets,
    }
    rec["hash"] = content_hash(rec)
    return rec


def content_hash(rec: dict) -> str:
    """Hash of everything except time-relative counters, so an unchanged program keeps its hash."""
    skip = {"new_7d", "new_14d", "new_30d", "wild_new_30d", "hash"}
    body = json.dumps({k: v for k, v in rec.items() if k not in skip}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(body.encode()).hexdigest()[:16]


def search_text(rec: dict, max_assets: int = 60) -> str:
    """The text a program is found by: name, platform, categories, tags and its in-scope identifiers."""
    idents = [a["i"] for a in rec["assets"] if a["in"]][:max_assets]
    parts = [rec["name"], rec["platform_name"], " ".join(rec["categories"]), " ".join(rec["tags"]),
             "bounty" if rec["bounty"] else "vdp", "contest" if rec["contest"] else "", " ".join(idents)]
    return " ".join(p for p in parts if p)


def embed_text(rec: dict, rules_summary: str = "", max_assets: int = 25) -> str:
    """The text a program is embedded as (shorter, more descriptive than the keyword doc)."""
    idents = [a["i"] for a in rec["assets"] if a["in"]][:max_assets]
    reward = f"pays up to {rec['reward_max']}" if rec["bounty"] and rec["reward_max"] else ("bug bounty" if rec["bounty"] else "vulnerability disclosure program, no bounty")
    lines = [
        f"{rec['name']} — {rec['platform_name']} {'contest' if rec['contest'] else 'program'}, {rec['state']}, {reward}.",
        f"Asset types: {', '.join(rec['categories']) or 'unknown'}.",
    ]
    if rec["tags"]:
        lines.append(f"Tags: {', '.join(rec['tags'])}.")
    if idents:
        lines.append("Scope: " + ", ".join(idents))
    if rules_summary:
        lines.append(rules_summary)
    return "\n".join(lines)
