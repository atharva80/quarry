# Decisions

Each entry: what, why, and the evidence. Numbers come from files in `evals/results/` (commit and date are inside
each file). Where current docs contradicted the original plan, the docs won and the difference is noted.

## M0 tests

### (a) Brute-force int8 search CPU — `evals/results/m0_cpu.json`
- 3,442 × 256 int8 matrix (0.9 MB static asset), loaded once per isolate through the assets binding.
- Plain JS loop: CPU p50 9 ms, p95 20 ms, max 32 ms (80 requests). Most requests land on cold isolates where
  the loop is still interpreted, so the JIT never helps on the Free plan's traffic shape.
- **WebAssembly SIMD kernel** (`worker/src/dot.wat`, 228 bytes, `i32x4.dot_i16x8_s`): CPU p50 2 ms,
  **p95 6 ms**, max 9 ms (100 requests). Target was < 5 ms p95: **missed by 1 ms**, but under the 10 ms cap.
- Decision: ship the WASM kernel; JS stays as the reference implementation (unit-tested equal).

### (b) Agent Durable Object turn CPU — `evals/results/m0_cpu.json`
- One turn = 2 LLM calls + 1 D1 FTS tool call: DO CPU p95 6 ms, wall 4–8 s (all waiting on the model).
  The Free plan's undocumented DO CPU limit isn't a concern for this workload.

### (c) D1 rows written — `evals/results/m0_d1_writes.json`
- 1,000-program import, lean layout (programs + FTS + assets added in the last 90 days): **3,080 rows written**.
- Same programs with every in-scope asset as a row + an `added_at` index: **21,675 rows written** (2 per asset).
- Projected full import: lean ≈ 15k (measured: **14,570** for 3,442 programs) vs normalised ≈ 130k, which would
  have needed the import split across two UTC days.
- Decision: **D1 holds only what the Worker queries**; full scopes live in static per-program JSON (free).
  No split import needed. Idempotent re-run: 0 statements.
- Later measurement: rewriting a changed program's FTS row costs ~20 rows written (395 programs → 7,994 rows), so
  FTS is only rewritten when the program's content hash changes, not when its time-relative counters do.

## Platform facts that differed from the plan (docs win)

| Plan said | Current docs / measurement | Consequence |
|---|---|---|
| Fallback LLM `@cf/deepseek-ai/deepseek-v4.1-flash-1017` | Returns error 5035: "not available on the Workers Free plan" | Fallback is `@cf/google/gemma-4-26b-a4b-it` (function calling verified on Free; $0.10/M in) |
| `McpAgent` deprecated → `createMcpHandler` | True, and the stateless handler now takes an **SDK v2 factory** from `@modelcontextprotocol/server`, imported from `agents/mcp/server` | `/mcp` uses `createMcpHandler(() => new McpServer(...))`, loaded lazily (see "bundling") |
| EmbeddingGemma-2 output like bge (`data[]` of arrays) | OpenAI-style `data[i].embedding`; `dimensions` ∈ {128, 256, 512, 768}; task prefixes recommended | Implemented as documented |
| Workers Logs: 0.5 GB/day from 2026-12-01 | Free: 200,000 events/day, 3-day retention | Invocation logs off; errors + 1% sample |
| DO migrations `new_sqlite_classes` | Still supported; docs now prefer the `exports` field | Kept `migrations` (works, and is what the bench class used) |
| AI Gateway: plain routing | New gateways must be authenticated; Fireworks/Command Code aren't native providers (custom providers exist) | See "LLM provider" |
| D1 limits | Enforced since 2026-09-01: 100k rows written/day, queries fail until 00:00 UTC | Write budget measured per build, shown on /status |

## LLM provider

- The plan said: read Command Code's terms first; if they don't clearly allow a deployed public app, use
  Fireworks. They don't: the ToS licenses use "for your internal business or personal purposes" and prohibits use
  "for the benefit of a third party". I recommended Fireworks (`accounts/fireworks/models/deepseek-v4p1-flash-1017`).
- **The owner chose Command Code** on their GOAT plan ($10/month, including up to $100 of DeepSeek V4.1 Flash
  credits and API-key access). The owner reads the plan's API access as usable anywhere; the ToS clauses above are
  noted here for completeness. The USD figures Quarry tracks are list prices per token, so on this plan the real
  cost is the flat $10/month until the credits run out. It's one config change away
  from Fireworks: `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_STYLE=chat`, `LLM_GATEWAY_PROVIDER=custom-quarry-fireworks`
  (the gateway custom provider already exists).
- **AI Gateway:** custom provider `quarry-commandcode` returned 502 ("provider did not return a valid response")
  for Command Code's Responses API through the Workers binding; direct calls with the same body return 200. So, as
  the plan allowed, Command Code is called **directly** with our own retries/backoff (429/5xx, `Retry-After`).
  Workers AI calls (fallback LLM) still go through gateway `quarry`. Prompt logging: user-chat calls set
  `cf-aig-collect-log: false` where they pass through the gateway.
- Structured output: no strict JSON-schema mode on Command Code, so every structured call is a forced tool call,
  validated (Pydantic / Zod), retried once with the validation error fed back, then the fallback model, then
  "unavailable".

## Spend
- Owner caps: Worker `DAILY_LLM_USD_CAP` $0.50 (budget Durable Object), plus a one-time approval of up to $10 for
  evals and the rules backfill. The pipeline shares a daily ledger in D1 (`metrics.llm_usd`) with the evals.
- Measured: rule extraction $0.0025/policy, 8 s p50 (`evals/results/extraction_test_primary_v3.json`).

## Search (eval 2 — `evals/results/search.json`)
- Shipped first: hybrid (1:1 RRF) + bge-reranker-base. On the hold-out queries it scored the **lowest** of the
  embedding systems (nDCG@10 0.549 vs 0.617 for int8 vectors alone). Kept as a row in the results.
- Tuned on the 30 dev queries only: weighted RRF, vector:keyword = 2:1, no reranker. Hold-out: nDCG@10 0.628,
  recall@20 0.812. Shipped. The reranker code stays, off (`rerank: true` to enable).
- int8 vs float at 256 dims: 0.617 vs 0.613 nDCG@10 — quantisation costs nothing measurable. 768 float dims are
  better (0.667) at 3× the bytes and 3× the CPU.
- No Vectorize: 3,442 vectors fit in a 0.9 MB file; brute force in WASM is 2 ms p50 CPU and costs nothing.

## Rule extraction (eval 1)
- Prompt tuned on the 50 dev policies only (v1 → v3); the 100 test policies were run once with v3.
- Added a code guard: a "yes"/"limited" scanning value whose quote doesn't mention scanning/tools/automation/rates is
  downgraded to "unclear". On dev it removed both wrong "allowed" answers seen with v1.
- Test result: 2 wrong "scanning limited" answers where the label is "unclear" (target 0, **missed**). Both quotes
  were real but not about permission (an "Access: no restrictions, but rate limits apply" line; a sentence about not
  submitting raw scanner output). Neither said "yes". Not fixed on the test set; a stricter guard needs a fresh set.

## Agent (eval 4)
- v1 → v2 fixes, found by the eval: the stored profile's hard constraints are now checked in code inside grounding
  (not just via the model's filters), assistant turns are remembered with the program ids they named (a follow-up had
  resolved "Kiteworks" to a different platform's program), and `trim()` now drops offending ids. That last one was a
  real bug: a regex matched the program name instead of its id. The shortlist rate went down (22/23 → 20/23) because
  more answers get trimmed; recorded, not hidden.
- The fallback model (Gemma 4 26B) takes 34 s p50 per turn and some multi-tool turns exceed 3 minutes, so it's a
  degraded mode, not a peer.

## Bundling
- `ZodLazy is not a constructor` at deploy: the MCP SDK runs `lazy()` at module top level before zod's classes are
  initialised in the bundle. Fix: `import("./mcp")` lazily on the `/mcp` route.

## Client
- Pages are rendered by the Python pipeline with Jinja2 (one source of truth for HTML, works without JS); islands
  are Preact (≈ 6.6 KB runtime) built with Vite, loaded per page with dynamic imports. Astro would have duplicated the
  page generation that the pipeline already does. Heaviest page ≈ 22 KB JS gzipped.

## Identity
- No login. A random 128-bit id in localStorage names the user's Agent DO; it acts as a bearer token (documented in
  SECURITY.md). GitHub OAuth sync was the first item on the cut list, and is cut.

## Cuts
- GitHub OAuth sync (cut order #1): not built.
- Eval 3 (recommendations from public H1 hacktivity): see docs/evals.md.
