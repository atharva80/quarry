# Data contract: pipeline → static site → client → Worker

The pipeline (`pipeline/`, Python) writes everything under `worker/public/` (served free as static assets).
The client (`web/`, Preact islands) and the Worker (`worker/`) only read these shapes. Change them here first.

## Static files

### `/data/catalog.json` — every program, compact (the browser's instant-search + "For you" data)

```jsonc
{
  "generated": "2026-11-19T01:17:00Z",     // pipeline build time (UTC)
  "source_updated": "2026-11-19T01:10:00Z", // bbwatch status.updated
  "programs": [
    {
      "id": "h1:1password",        // "<platform>:<handle>", stable
      "path": "/p/h1/1password/",  // program page URL
      "p": "h1",                   // platform key
      "pn": "HackerOne",           // platform name
      "n": "1Password",            // program name
      "u": "https://hackerone.com/1password", // program URL on the platform
      "s": "open",                 // open|paused|closed|ended|upcoming|judging|suspended|unknown
      "b": 1,                      // pays bounties (0 = VDP)
      "c": 0,                      // contest/audit competition
      "mx": "$100,000",            // max reward as published ("" if none)
      "usd": 100000,               // max reward, approx USD (0 unknown)
      "L": 1700000000,             // listed at (unix s; platform date or first seen)
      "U": 1790000000,             // last activity (unix s)
      "cat": ["api", "web", "wildcard"], // in-scope asset categories (see below)
      "t": ["tag"],                // platform tags
      "na": 12,                    // in-scope assets
      "np": 10,                    // bounty-eligible in-scope assets
      "n7": 1, "n14": 1, "n30": 3, // in-scope assets added in last 7/14/30 days
      "w30": 1,                    // wildcard assets added in last 30 days
      "la": 1790000000,            // newest in-scope asset added at (0 unknown)
      "sc": ["*.1password.com", "api.1password.com"], // up to 8 in-scope identifiers (search + preview)
      "rules": { "scan": "no", "rl": "5 req/s", "hdr": true } | null, // rules-card summary, null = not extracted
      "age": 1234                  // days since listed (competition proxy input)
    }
  ]
}
```

Categories: `web wildcard api android ios mobile contract code network desktop hardware ai other`.

### `/data/p/<platform>/<handle>.json` — one program in full

The catalog row's fields, plus:

```jsonc
{
  "assets": [ { "i": "*.example.com", "t": "wildcard", "c": "wildcard", "in": true, "paid": true,
                "tier": "Tier 1", "at": 1790000000 } ],   // newest first; at = added/seen (0 unknown)
  "rules": RulesCard | null,           // see below
  "rules_source": "https://…",         // policy URL
  "rules_status": "extracted" | "not_available" | "pending",
  "changes": [ ChangeEntry ],          // this program's recent changes, newest first
  "hunter": { "reputation_required": 0, "submission_fee": "…", "resolved_reports": 12, "response_efficiency_pct": 90 }
}
```

### RulesCard (validated by Pydantic in the pipeline, Zod in the Worker)

```jsonc
{
  "scanning":        { "value": "yes|no|limited|unclear", "quote": "…verbatim…", "section": "Policy" },
  "rate_limit":      { "value": "5 requests/second" | "unclear", "quote": "…", "section": "…" },
  "required_header": { "value": "X-Bug-Bounty: <username>" | "none stated" | "unclear", "quote": "…", "section": "…" },
  "test_accounts":   { "value": "…", "quote": "…", "section": "…" },
  "excluded_classes":{ "value": ["self-XSS", "…"], "quote": "…", "section": "…" },
  "safe_harbour":    { "value": "yes|no|unclear", "quote": "…", "section": "…" },
  "bounty_table":    { "value": "Critical $5k–$10k …" | "unclear", "quote": "…", "section": "…" },
  "disclosure":      { "value": "…" | "unclear", "quote": "…", "section": "…" },
  "model": "fireworks/deepseek-v4p1-flash-1017", "extracted_at": 1790000000, "policy_hash": "abcd…"
}
```

`quote` is a verbatim substring of the stored policy text (checked automatically; a field whose quote
fails the check is downgraded to `unclear`). `section` is the `## ` heading the quote sits under.
When `value` is `unclear`, `quote` may be empty and the UI shows "unclear: read § <section>".

### `/data/changes.json` — change feed, last 30 days, newest first

```jsonc
{ "generated": "…", "entries": [ { "id": "9e97…", "ts": 1790000000, "kind": "SCOPE|SCOPE-|STATE|OPEN|NEW|GONE|BOUNTY|META",
  "prio": 4, "pid": "bugcrowd:kantega" | null, "title": "…", "body": "…", "summary": "one line" } ] }
```

### `/data/vectors.bin` + `/data/vectors.ids.json`

int8 matrix, format documented in `worker/src/vectors.ts`. ids are program ids in row order.

### `/data/status.json` — ops metrics for the status page (see docs/ops.md)

## Worker API (all JSON; `uid` = random anonymous id from localStorage, 32 hex chars)

| Method | Path | Body / query | Response |
|---|---|---|---|
| POST | `/api/search` | `{q, k?, profile?, filters?}` | `{mode: "hybrid"|"keyword", results: [{id, score, reasons: string[]}]}` |
| POST | `/api/chat` | `{uid, message, turnstile?}` | `{reply, programs: [id], tools: [name], limited?: bool}` |
| POST | `/api/ask` | `{uid, program, question, turnstile?}` | `{answer, quotes: [{text, section}], status: "answered"|"not_in_policy"|"unavailable"}` |
| POST | `/api/feedback` | `{uid, program, action: "save"|"dismiss", reason?}` | `{ok}` |
| POST | `/api/profile` | `{uid, profile}` | `{ok}` |
| POST | `/api/match?program=<id>` | text body, newline-separated hosts (≤ 2,000 lines / 64 KB) | `{in: [{host, rule}], out: [{host, rule}], unknown: [host]}` |
| GET | `/api/alerts?uid=` | – | `{telegram, discord, push, rss}` |
| POST | `/api/alerts/telegram` | `{uid}` | `{link: "https://t.me/<bot>?start=<code>"}` |
| POST | `/api/alerts/discord` | `{uid, webhook}` | `{ok}` |
| POST | `/api/alerts/push` | `{uid, subscription}` | `{ok}` |
| POST | `/api/alerts/rss` | `{uid}` | `{url}` |
| DELETE | `/api/alerts/<kind>` | `{uid}` | `{ok}` |
| DELETE | `/api/me` | `{uid}` | `{ok}` — wipes the user's Durable Object and subscriptions |
| GET | `/api/feed/<token>.xml` | – | personal Atom feed |
| GET | `/api/config` | – | `{turnstile_sitekey, vapid_public_key, telegram_bot}` |
| POST/GET | `/mcp` | MCP Streamable HTTP (stateless) | read-only tools |

### Profile (browser-owned; synced to the user's Agent DO only when chat/alerts are used)

```jsonc
{
  "skills": ["xss", "idor", "ssrf", "graphql", "auth", "business-logic", "mobile-reversing", "smart-contracts", "source-review", "recon"],
  "assets": ["web", "api", "android", "ios", "contract", "code", "wildcard", "network", "desktop", "hardware", "ai"],
  "platforms": ["h1", "bugcrowd"],         // empty = any
  "min_bounty": 500,                        // USD, 0 = any
  "vdp_ok": false,
  "exclude": ["contract"],                  // hard exclusions (categories) e.g. "no web3"
  "exclude_platforms": [],
  "hours_per_week": 10,
  "hard": ["platforms", "min_bounty", "vdp_ok", "exclude"], // which constraints are hard filters
  "saved": ["h1:x"], "dismissed": [{"id": "h1:y", "reason": "too competitive", "ts": 0}]
}
```
