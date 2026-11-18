"""Fetch public program policies (rules pages) from each platform's public, unauthenticated endpoint.

Politeness (hard rules): one request per second per host, `Retry-After` honoured, conditional requests where
the platform supports them (Immunefi ETag; Bugcrowd's changelog version id), identify as quarry-bot, never log
in, public programs only. Output is normalised Markdown with `## ` section headings, so rules can be quoted
verbatim and cited as "§ <heading>".
"""

from __future__ import annotations

import hashlib
import json
import re
import threading
import time
from dataclasses import dataclass
from urllib.parse import quote, urlparse

import httpx
from markdownify import markdownify

UA = "quarry-bot (+https://github.com/atharva80/quarry)"
POLICY_PLATFORMS = ("h1", "bugcrowd", "intigriti", "ywh", "immunefi")
MAX_TEXT = 45_000  # characters kept per policy (D1: 100 KB per statement)


class HostLimiter:
    """At most one request per `interval` seconds per host, across threads."""

    def __init__(self, interval: float = 1.05):
        self.interval = interval
        self.next_at: dict[str, float] = {}
        self.lock = threading.Lock()

    def wait(self, host: str) -> None:
        with self.lock:
            now = time.monotonic()
            at = max(now, self.next_at.get(host, 0.0))
            self.next_at[host] = at + self.interval
        if at > now:
            time.sleep(at - now)

    def push_back(self, host: str, seconds: float) -> None:
        with self.lock:
            self.next_at[host] = max(self.next_at.get(host, 0.0), time.monotonic() + seconds)


class Client:
    def __init__(self, limiter: HostLimiter | None = None, timeout: float = 30):
        self.limiter = limiter or HostLimiter()
        self.http = httpx.Client(headers={"User-Agent": UA, "Accept": "application/json"}, timeout=timeout,
                                 follow_redirects=False)
        self.requests = 0

    def request(self, method: str, url: str, *, headers: dict | None = None, json_body=None, tries: int = 3):
        host = urlparse(url).netloc
        for attempt in range(tries):
            self.limiter.wait(host)
            self.requests += 1
            r = self.http.request(method, url, headers=headers, json=json_body)
            if r.status_code in (429, 503):
                ra = r.headers.get("retry-after", "")
                wait = float(ra) if ra.isdigit() else 30.0 * (attempt + 1)
                self.limiter.push_back(host, min(wait, 600))
                continue
            return r
        return r

    def close(self) -> None:
        self.http.close()


@dataclass
class Policy:
    program_id: str
    source_url: str
    version: str
    text: str

    @property
    def hash(self) -> str:
        return hashlib.sha256(self.text.encode()).hexdigest()[:16]


def html_to_md(html: str | None) -> str:
    if not html:
        return ""
    md = markdownify(html, heading_style="ATX", bullets="-", strip=["img", "script", "style"])
    return clean(md)


def clean(text: str | None) -> str:
    if not text:
        return ""
    text = text.replace("\r\n", "\n").replace(" ", " ")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def demote(md: str) -> str:
    """Policy-internal headings become ### so our ## sections stay the top level."""
    return re.sub(r"^(#{1,2}) ", "### ", md, flags=re.M)


def section(title: str, body: str) -> str:
    body = clean(body)
    return f"## {title}\n\n{demote(body)}" if body else ""


def join(parts: list[str]) -> str:
    return clean("\n\n".join(p for p in parts if p))[:MAX_TEXT]


# ---------- HackerOne ----------

H1_QUERY = (
    "query($h:String!){team(handle:$h){handle name submission_state state offers_bounties currency policy "
    "bounty_table{bounty_table_rows(first:20){nodes{low medium high critical}}} "
    "structured_scopes(first:100,archived:false){nodes{asset_identifier asset_type instruction eligible_for_bounty "
    "eligible_for_submission max_severity}}}}"
)


def fetch_h1(c: Client, handle: str) -> Policy | None:
    r = c.request("POST", "https://hackerone.com/graphql", json_body={"query": H1_QUERY, "variables": {"h": handle}},
                  headers={"Content-Type": "application/json"})
    if r.status_code != 200:
        return None
    team = ((r.json() or {}).get("data") or {}).get("team")
    if not team or team.get("state") not in ("public_mode", "soft_launched", None):
        return None
    parts = [section("Policy", team.get("policy") or "")]
    rows = (((team.get("bounty_table") or {}).get("bounty_table_rows") or {}).get("nodes")) or []
    if rows:
        cur = team.get("currency") or "usd"
        lines = [f"- Low: {x.get('low')} · Medium: {x.get('medium')} · High: {x.get('high')} · Critical: {x.get('critical')} ({cur.upper()})"
                 for x in rows]
        parts.append(section("Bounty table", "\n".join(lines)))
    notes = []
    for s in ((team.get("structured_scopes") or {}).get("nodes")) or []:
        ins = clean(s.get("instruction"))
        if ins:
            notes.append(f"- `{s.get('asset_identifier')}` ({s.get('asset_type')}): {ins.replace(chr(10), ' ')}")
    if notes:
        parts.append(section("Scope notes", "\n".join(notes)))
    text = join(parts)
    if not text:
        return None
    return Policy(f"h1:{handle}", f"https://hackerone.com/{handle}/policy", hashlib.sha256(text.encode()).hexdigest()[:16], text)


# ---------- Bugcrowd ----------

def fetch_bugcrowd(c: Client, code: str, known_version: str | None = None) -> Policy | str | None:
    """Returns a Policy, the string "unchanged" when the brief version is the one we have, or None."""
    base = f"https://bugcrowd.com/engagements/{quote(code)}"
    r = c.request("GET", f"{base}/changelog.json")
    if r.status_code != 200:
        return None
    logs = (r.json() or {}).get("changelogs") or []
    if not logs:
        return None
    latest = next((x for x in logs if x.get("changelogState") == "Latest"), logs[0])
    vid = latest.get("id")
    if known_version and vid == known_version:
        return "unchanged"
    r = c.request("GET", f"{base}/changelog/{vid}.json")
    if r.status_code != 200:
        return None
    d = (r.json() or {}).get("data") or r.json() or {}
    brief = d.get("brief") or {}
    parts = [
        section("Program description", html_to_md(brief.get("description"))),
        section("Rules and targets overview", html_to_md(brief.get("targetsOverview"))),
        section("Additional information", html_to_md(brief.get("additionalInformation"))),
    ]
    sh = brief.get("safeHarborStatus") or {}
    if sh:
        parts.append(section("Safe harbor", f"Status: {sh.get('label') or sh.get('status')}\n\n{html_to_md(sh.get('description'))}"))
    for g in d.get("scope") or []:
        body = html_to_md(g.get("descriptionHtml"))
        rr = g.get("rewardRangeData") or {}
        if rr:
            body += "\n\nRewards: " + "; ".join(
                f"P{k}: ${v.get('min')}–${v.get('max')}" for k, v in sorted(rr.items()) if isinstance(v, dict))
        parts.append(section(f"Target group: {g.get('name') or 'Targets'}", body))
    disc = d.get("coordinatedDisclosure")
    if disc is not None:
        parts.append(section("Disclosure", "Coordinated disclosure: " + ("yes" if disc else "no")))
    text = join(parts)
    return Policy(f"bugcrowd:{code}", base, str(vid), text) if text else None


# ---------- Intigriti ----------

def _latest(versions):
    if not versions:
        return None
    if isinstance(versions, dict):
        return versions.get("content", versions)
    best = max(versions, key=lambda v: (v or {}).get("createdAt") or 0)
    return (best or {}).get("content")


def fetch_intigriti(c: Client, pid: str, ref) -> Policy | None:
    if not ref or len(ref) < 2:
        return None
    url = f"https://app.intigriti.com/api/core/public/programs/{quote(str(ref[0]))}/{quote(str(ref[1]))}"
    r = c.request("GET", url)
    if r.status_code != 200:
        return None
    d = r.json() or {}
    parts = [section("Description", d.get("description") or "")]
    roe = _latest(d.get("rulesOfEngagements")) or {}
    roe_c = roe.get("content") if isinstance(roe.get("content"), dict) else roe
    if roe_c:
        lines = [roe_c.get("description") or ""]
        tr = roe_c.get("testingRequirements") or {}
        if tr.get("userAgent"):
            lines.append(f"Required user agent: {tr['userAgent']}")
        if tr.get("requestHeader"):
            lines.append(f"Required request header: {tr['requestHeader']}")
        if tr.get("automatedTooling") is not None:
            lines.append(f"Automated tooling setting (platform code): {tr['automatedTooling']}")
        if roe_c.get("safeHarbour") is not None:
            lines.append("Safe harbour: " + ("yes" if roe_c.get("safeHarbour") else "no"))
        parts.append(section("Rules of engagement", "\n\n".join(x for x in lines if x)))
    for key, title in (("inScopes", "In scope"), ("outOfScopes", "Out of scope"), ("severityAssessments", "Severity assessment"), ("faqs", "FAQ")):
        v = _latest(d.get(key))
        if isinstance(v, dict):
            v = v.get("content")
        if isinstance(v, str):
            parts.append(section(title, v))
    bt = _latest(d.get("bountyTables"))
    if isinstance(bt, dict):
        rows = []
        for row in bt.get("bountyRows") or []:
            for br in row.get("bountyRanges") or []:
                lo = (br.get("minBounty") or {}).get("value")
                hi = (br.get("maxBounty") or {}).get("value")
                rows.append(f"- CVSS {br.get('minScore')}–{br.get('maxScore')}: {lo}–{hi}")
        if rows:
            parts.append(section("Bounty table", "\n".join(rows)))
    text = join(parts)
    return Policy(pid, d.get("webLinks", {}).get("detail") if isinstance(d.get("webLinks"), dict) else f"https://app.intigriti.com/programs/{ref[0]}/{ref[1]}/detail",
                  hashlib.sha256(text.encode()).hexdigest()[:16], text) if text else None


# ---------- YesWeHack ----------

def fetch_ywh(c: Client, slug: str) -> Policy | None:
    r = c.request("GET", f"https://api.yeswehack.com/programs/{quote(slug)}")
    if r.status_code != 200:
        return None
    d = r.json() or {}
    if not d.get("public", True):
        return None
    parts = [section("Rules", d.get("rules") or html_to_md(d.get("rules_html")))]
    if d.get("user_agent"):
        parts.append(section("Required user agent", f"Required user agent: {d['user_agent']}"))
    if d.get("account_access") or d.get("account_access_html"):
        parts.append(section("Account access", d.get("account_access") or html_to_md(d.get("account_access_html"))))
    for key, title in (("out_of_scope", "Out of scope"), ("qualifying_vulnerability", "Qualifying vulnerabilities"),
                       ("non_qualifying_vulnerability", "Non-qualifying vulnerabilities")):
        v = d.get(key)
        if v:
            parts.append(section(title, "\n".join(f"- {x}" for x in v) if isinstance(v, list) else str(v)))
    grid = []
    for k in ("reward_grid_default", "reward_grid_low", "reward_grid_medium", "reward_grid_high", "reward_grid_critical"):
        g = d.get(k)
        if isinstance(g, dict) and any(g.get(x) for x in ("bounty_low", "bounty_medium", "bounty_high", "bounty_critical")):
            grid.append(f"- {k.replace('reward_grid_', '').title()} asset value: low {g.get('bounty_low')} · medium {g.get('bounty_medium')} · high {g.get('bounty_high')} · critical {g.get('bounty_critical')}")
    if grid:
        parts.append(section("Bounty table", "\n".join(grid)))
    if d.get("vpn_active"):
        parts.append(section("Network requirements", "Testing must go through the YesWeHack VPN."))
    text = join(parts)
    return Policy(f"ywh:{slug}", f"https://yeswehack.com/programs/{slug}", str(d.get("last_update_at") or hashlib.sha256(text.encode()).hexdigest()[:16]), text) if text else None


# ---------- Immunefi (one feed, conditional) ----------

def fetch_immunefi_feed(c: Client, etag: str | None = None) -> tuple[list[dict] | None, str | None]:
    headers = {"If-None-Match": etag} if etag else None
    r = c.request("GET", "https://immunefi.com/public-api/bounties.json", headers=headers)
    if r.status_code == 304:
        return None, etag
    if r.status_code != 200:
        raise RuntimeError(f"immunefi feed: HTTP {r.status_code}")
    return r.json(), r.headers.get("etag")


def immunefi_policy(entry: dict) -> Policy | None:
    slug = entry.get("slug") or entry.get("id")
    parts = [section("Program overview", entry.get("programOverview") or entry.get("description") or ""),
             section("Assets", entry.get("assetsBodyV2") or ""),
             section("Rewards", entry.get("rewardsBody") or "")]
    rw = entry.get("rewards") or []
    if rw:
        parts.append(section("Bounty table", "\n".join(
            f"- {x.get('assetType')} · {x.get('severity')}: {x.get('minReward') or ''}–{x.get('maxReward') or ''}"
            for x in rw if isinstance(x, dict))))
    for key, title in (("outOfScopeAndRules", "Out of scope and rules"), ("defaultOutOfScopeGeneral", "Out of scope (general)"),
                       ("defaultOutOfScopeSmartContract", "Out of scope (smart contracts)"),
                       ("defaultOutOfScopeWebAndApplications", "Out of scope (web and apps)"),
                       ("defaultProhibitedActivities", "Prohibited activities"),
                       ("defaultFeasibilityLimitations", "Feasibility limitations")):
        parts.append(section(title, entry.get(key) or ""))
    cp = entry.get("customProhibitedActivities")
    if cp:
        parts.append(section("Custom prohibited activities", "\n".join(f"- {x}" for x in cp) if isinstance(cp, list) else str(cp)))
    if entry.get("kyc") is not None:
        parts.append(section("KYC", "KYC required: " + ("yes" if entry.get("kyc") else "no")))
    if entry.get("responsiblePublicationCategory"):
        parts.append(section("Disclosure", f"Responsible publication category: {entry['responsiblePublicationCategory']}"))
    text = join(parts)
    return Policy(f"immunefi:{slug}", f"https://immunefi.com/bug-bounty/{slug}/information/", hashlib.sha256(text.encode()).hexdigest()[:16], text) if text else None


def fetch_one(c: Client, prog: dict, known_version: str | None = None):
    plat, key = prog["platform"], prog["handle"]
    try:
        if plat == "h1":
            return fetch_h1(c, key)
        if plat == "bugcrowd":
            return fetch_bugcrowd(c, key, known_version)
        if plat == "intigriti":
            return fetch_intigriti(c, prog["id"], prog.get("ref"))
        if plat == "ywh":
            return fetch_ywh(c, key)
    except (httpx.HTTPError, json.JSONDecodeError, ValueError):
        return None
    return None


def sections(text: str) -> list[tuple[str, str]]:
    """[(heading, body)] for '## ' sections — used for § citations and for chunking."""
    out = []
    cur, buf = "Policy", []
    for line in text.split("\n"):
        if line.startswith("## "):
            if buf:
                out.append((cur, "\n".join(buf).strip()))
            cur, buf = line[3:].strip(), []
        else:
            buf.append(line)
    if buf:
        out.append((cur, "\n".join(buf).strip()))
    return [(h, b) for h, b in out if b]
