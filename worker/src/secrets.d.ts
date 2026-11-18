// Secrets are set with `npx wrangler secret put NAME` (see docs/secrets.md); they are not in wrangler.jsonc.
interface QuarrySecrets {
  BENCH_TOKEN?: string;
  LLM_API_KEY?: string;
  TURNSTILE_SECRET?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  VAPID_PRIVATE_KEY?: string;
  ADMIN_TOKEN?: string;
}
interface Env extends QuarrySecrets {}
declare namespace Cloudflare {
  interface Env extends QuarrySecrets {}
}
