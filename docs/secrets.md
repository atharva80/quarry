# Secrets

Every secret Quarry uses, where it lives, and the exact command to set it. Run these from the repo root
(`/home/axrva/quarry`). None of them are ever printed, logged or committed. `.env` and `.dev.vars*` are gitignored.

## Set by you (the owner)

### 1. `LLM_API_KEY`: Command Code API key (primary LLM)

Quarry calls `deepseek/deepseek-v4.1-flash` through Command Code's provider API (OpenAI Responses style), routed
through the AI Gateway custom provider `quarry-commandcode`. The owner chose Command Code over Fireworks
(see docs/decisions.md, "LLM provider"). To switch providers later, change `LLM_BASE_URL`, `LLM_MODEL`,
`LLM_API_STYLE` and `LLM_GATEWAY_PROVIDER` in `worker/wrangler.jsonc` and set the new key the same way.
The key is needed in three places:

```bash
cd worker && npx wrangler secret put LLM_API_KEY && cd ..        # the Worker (chat, ask, agent)
gh secret set LLM_API_KEY --repo atharva80/quarry                # GitHub Actions (rule extraction in the hourly build)
read -rsp "Command Code key: " K && printf 'LLM_API_KEY=%s\n' "$K" > .env && unset K && chmod 600 .env   # local evals
```

### 2. `CLOUDFLARE_API_TOKEN`: for the hourly GitHub Actions build

Create a **custom API token** at https://dash.cloudflare.com/profile/api-tokens with only these permissions,
scoped to your account (Account Resources: include → your account):

| Permission | Access | Used for |
|---|---|---|
| Account · Workers Scripts | Edit | `wrangler deploy` |
| Account · D1 | Edit | upserts into `quarry-db` |
| Account · Workers AI | Read | embeddings (EmbeddingGemma-2), fallback LLM |
| Account · AI Gateway | Run | LLM calls through gateway `quarry` (authenticated gateway) |
| Account · Account Settings | Read | wrangler's account lookup |

No zone permissions are needed. Set a TTL of up to 1 year if you like. Then:

```bash
gh secret set CLOUDFLARE_API_TOKEN --repo atharva80/quarry
```

### 3. `TELEGRAM_BOT_TOKEN`: alerts bot (M5)

In Telegram, message @BotFather → `/newbot` → name it e.g. "Quarry alerts", username e.g. `quarry_hunt_bot`.
Then:

```bash
cd worker && npx wrangler secret put TELEGRAM_BOT_TOKEN && cd ..
```

and tell Quarry's maintainer (me) the bot's **username** (not secret), so the link button can point to it.

## Set by the build (no action needed)

| Secret | Where | How |
|---|---|---|
| `TURNSTILE_SECRET` | Worker | Turnstile widget `quarry-turnstile` created through the Cloudflare API; secret piped straight into `wrangler secret put` |
| `VAPID_PRIVATE_KEY` | Worker | generated locally with WebCrypto, piped into `wrangler secret put`; public key in wrangler vars |
| `TELEGRAM_WEBHOOK_SECRET` | Worker | random, piped into `wrangler secret put`, sent to Telegram's `setWebhook` |
| `ADMIN_TOKEN` | Worker + Actions | random; protects `/api/admin/*` (metrics push from the pipeline) |
| `BENCH_TOKEN` | Worker | random; only for the M0 benchmarks, deleted after M0 |

## Rotating

Set the secret again with the same command; Workers pick it up on the next request. To revoke the Cloudflare
token, delete it in the dashboard; the hourly build then fails visibly in Actions and the status page goes stale
(it does not break the live site).
