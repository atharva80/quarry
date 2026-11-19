# Ops runbook

## What runs where
| Piece | Where | Schedule |
|---|---|---|
| Site build (`quarry-pipeline build`) | GitHub Actions `build.yml` | hourly at :17 (+ manual `workflow_dispatch`) |
| Alerts dispatch | Worker cron | hourly at :23 |
| Daily digests | each opted-in user's Agent DO alarm | the hour the user picked (UTC) |
| Weekly evals | Actions `evals-full.yml` | Mondays 03:41 UTC; commits `evals/results/` (keeps schedules alive) |

## Health
- **/status/** (static, rebuilt every build): bbwatch lag, pipeline success rate over the last 48 runs, rows written,
  pipeline LLM spend by day, last 24 runs.
- **/api/status** (live): today's Worker LLM spend, neurons, calls, refusals vs caps (budget Durable Object).
- **UptimeRobot (owner to set up, free plan):** two HTTP(S) monitors, 5-minute interval:
  1. `https://quarry.quarry-worker.workers.dev/` — keyword monitor for `Quarry` (static assets; should never fail).
  2. `https://quarry.quarry-worker.workers.dev/api/status` — keyword `caps` (Worker + Durable Object up).
  Alert contact: your email. Optional: a third keyword monitor on `/data/status.json` for `"generated"`.

## Common operations
```bash
gh workflow run build.yml -f force=true --repo atharva80/quarry      # rebuild now
gh run list --workflow build.yml --repo atharva80/quarry -L 5        # recent builds
cd worker && npx wrangler tail quarry --format pretty                # live Worker logs (errors + 1% sample)
uv run quarry-pipeline build --no-deploy                             # local dry build into worker/public/
uv run quarry-pipeline build --no-llm --force                        # rebuild without spending on the LLM
```

## Quota exhaustion: what users see (drills in M6, results in docs/evals.md)
| Quota hit | Behaviour |
|---|---|
| Worker 100k requests/day | Static pages, program JSON, catalog, feeds keep serving (assets are free and uncapped). `/api/*` returns 429; the browser keeps instant keyword search; chat shows an error. |
| LLM budget ($0.50/day) | Chat falls back to Workers AI; when the neuron cap is also hit: "Quarry has hit today's AI budget…" Search, pages and alerts unaffected. |
| Workers AI neurons (10k/day) | Smart search falls back to keyword (D1 FTS) — `mode: "keyword"`; chat as above. |
| D1 rows written (100k/day) | The build's upserts fail → the build fails before deploy, the live site keeps the previous version; feedback writes fail silently (logged). |
| D1 rows read (5M/day) | Search falls back to vector-only (`mode: "vector"`); agent tools return errors the model reports. |

## Incidents
- **Build failing**: `gh run view --log-failed`. Most likely: Cloudflare token expired (rotate per docs/secrets.md),
  bbwatch's `state` branch unreachable (the build retries next hour), a platform changed its API (fetch failures
  show per platform in the run's `policies` stats; other platforms are unaffected).
- **Bad rules card reported**: rules are re-extracted when the policy text hash changes; to force one, clear it:
  `npx wrangler d1 execute quarry-db --remote --command "UPDATE programs SET rules_hash = NULL WHERE id = 'h1:x'"`.
- **Abuse / spend spike**: lower `DAILY_LLM_USD_CAP` in `worker/wrangler.jsonc` and deploy, or set it to `0` to
  stop primary-model chat entirely; rate limits are in the `ratelimits` block.
- **Stop everything**: `gh workflow disable build.yml` and remove the cron from `wrangler.jsonc`; the static site
  stays up.
