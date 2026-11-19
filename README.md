# Quarry

**Tell Quarry what you hunt. It finds the bug-bounty programs worth your time today, explains why, tells you what
each program allows, and pings you when something new fits.**

**Live:** https://quarry.quarry-worker.workers.dev · **MCP:** `claude mcp add --transport http quarry https://quarry.quarry-worker.workers.dev/mcp`

![demo](docs/demo.gif) <!-- GIF placeholder: record onboarding → For you → a rules card → chat -->

3,442 programs from 15 platforms (1,559 open, 61,910 in-scope assets), from my public collector
[bbwatch](https://github.com/atharva80/bbwatch), rebuilt hourly ([corpus.json](evals/results/corpus.json)). Runs entirely on Cloudflare's free plan.

## What it does
- **Onboarding → typed profile** in ~30 s (chips or chat): skills, asset types, platforms, minimum bounty, VDPs,
  exclusions ("no web3"), time. Hard constraints filter; soft preferences only weigh.
- **"For you" feed with reasons**: fit × fresh scope (7/14/30 days, wildcards weighted up) × payout × a competition
  proxy × your feedback. "3 new assets this week (1 wildcard) · fits your api skills · max $10k · limited scanning".
  Dismiss reasons ("too competitive", "not my stack", "low pay") become preferences.
- **Rules cards** (H1, Bugcrowd, Intigriti, YesWeHack, Immunefi): scanning, rate limit, required header, test
  accounts, excluded classes, safe harbour, bounty table, disclosure — each with an **exact policy quote**, checked
  automatically. Unsure → "unclear: read § X".
- **Ask about this program**: answered only from the stored policy, with quotes; "the policy doesn't say" when it
  doesn't.
- **Agent** (chat) with tools and memory: search, get/compare programs, `can_i_test`, what's new for me,
  save/dismiss, profile updates, scope export. Grounding is enforced in code.
- **Scope check**: paste subfinder output → in / out / unknown (deny wins). Burp, Caido, nuclei, plain and
  wildcard-root exports generated in the browser.
- **Alerts**: Telegram, Discord webhooks, Web Push, personal RSS; opt-in daily digest.
- **MCP server** at `/mcp` (stateless, read-only) for Claude Code / Cursor.

## Results

Every number links to the results file that produced it (commit and date inside). Labels are **agent-labelled**
(Claude Sonnet subagents, two passes); the owner reviews a sample. Hold-out sets were never used for tuning.

### Rule extraction — 100 held-out policies, 5 platforms ([extraction_test_primary_v3.json](evals/results/extraction_test_primary_v3.json))
| Metric | Result |
|---|---|
| Mean field accuracy (8 fields) | **96.1%** (scanning 89%, safe harbour 93%, others 96–99%) |
| Quote faithfulness (model quotes found verbatim in the policy) | **99.6%** of 533 |
| Wrong "scanning allowed" when the policy says no/unclear | **2** (target 0 — missed; both "limited", never "yes"; see docs/decisions.md) |
| Cost / latency per policy (DeepSeek V4.1 Flash) | $0.0025 · 8.1 s p50 |

Dev split (50 policies, used for prompt tuning): v1 95.3% / 2 wrong-allowed → v3 96.0% / 1.

### Search — 100 hunter queries, 70 held out, pooled judgments graded 0–3 ([search.json](evals/results/search.json))
| System (hold-out) | nDCG@10 | recall@20 |
|---|---|---|
| Keyword (D1 FTS5 BM25) | 0.415 | 0.415 |
| Embeddings, float 768-d | 0.667 | 0.802 |
| Embeddings, float 256-d | 0.613 | 0.742 |
| Embeddings, **int8 256-d** (shipped index) | 0.617 | 0.739 |
| Hybrid RRF 1:1 | 0.595 | 0.843 |
| Hybrid RRF 1:1 + bge reranker (first shipped) | 0.549 | 0.819 |
| **Hybrid RRF 2:1, no reranker (shipped, tuned on dev)** | **0.628** | **0.812** |

int8 quantisation costs nothing measurable at 256 dims; the reranker hurt, so it's off.

### Agent — 50 scripted conversations + 15 adversarial policies
AGENT_RESULTS_PLACEHOLDER

### Operations
OPS_PLACEHOLDER

## How Quarry runs on $0

| Free-plan limit | Design consequence |
|---|---|
| Workers: 10 ms CPU per request, 100k requests/day | Everything heavy is precomputed hourly. Static pages, program JSON, the catalog and feeds are **assets**: free, uncapped, and still served after the 100k cap. The Worker runs only for `/api/*` and `/mcp`. |
| No Vectorize budget worth using | 3,442 × 256 **int8** vectors in a 0.9 MB static file, brute-forced in a 228-byte **WebAssembly SIMD** kernel: CPU p50 2 ms / p95 6 ms ([m0_cpu.json](evals/results/m0_cpu.json)); plain JS was p95 20 ms on cold isolates. |
| D1: 100k rows written/day | D1 stores only what the Worker queries. Full import: **14,570 rows** ([d1_full_import.json](evals/results/d1_full_import.json)) vs ~130k projected if every asset were a row (21,675 per 1,000 programs, [m0_d1_writes.json](evals/results/m0_d1_writes.json)). Upserts only for changed rows; an unchanged re-run writes 0. |
| Workers AI: 10k neurons/day | Embeddings cost 154 neurons/M tokens: embedding all 3,442 programs used ~70. The fallback LLM is the expensive part and has its own cap. |
| LLM spend | Budget Durable Object: $0.50/day global cap, per-user daily cap, Turnstile before first chat, then the Workers AI fallback, then a friendly "daily limit reached". |
| Durable Objects (SQLite) on Free | One Agents SDK DO per chatting user (memory, digests via alarms); one DO for the budget. A turn with a tool call: 6 ms CPU p95. |
| Workers Logs: 200k events/day | No invocation logs; errors + a 1% sample; never request bodies. |
| GitHub Actions cron can be late | The pipeline is a **site build** (hourly at :17), not a server; freshness is measured on /status. |

## Architecture

```
GitHub Actions (hourly :17, Python) — the site build
  bbwatch state (read-only, conditional GET) → normalise → D1 upserts (changed rows only)
  → fetch changed policies (≤1 req/s/host) → extract rules (LLM, schema + quote check) → embed changed programs
  → static pages + int8 vectors → fast checks → wrangler deploy

Cloudflare Worker "quarry" (TypeScript)
  static assets: program pages + JSON, catalog, change feed, Atom, sitemap, PWA
  /api/* (Hono): search · chat · ask · feedback · profile · match · alerts       /mcp: createMcpHandler
  QuarryAgent DO (Agents SDK) per user · BudgetDO · D1 quarry-db (programs, FTS5, recent assets, policies, …)
  Workers AI: EmbeddingGemma-2 (256-d), fallback LLM · AI Gateway "quarry"
```

## Repo
`pipeline/` (Python, uv) · `worker/` (TypeScript) · `web/` (Preact islands + Jinja templates) · `ranking/` (shared
score) · `prompts/` · `evals/` (Python; results in `evals/results/`) · `docs/` ([decisions](docs/decisions.md),
[evals](docs/evals.md), [ops](docs/ops.md), [secrets](docs/secrets.md), [data contract](docs/data-contract.md)) ·
[SECURITY.md](SECURITY.md).

```bash
uv sync && npm ci
uv run pytest && npx vitest run --root worker
uv run quarry-pipeline build --no-deploy      # needs Cloudflare auth (wrangler login)
```

Data: program data comes from public platform listings via bbwatch; policy text is fetched from each platform's
public endpoint and is not redistributed in this repo. Quarry is not affiliated with any platform.
