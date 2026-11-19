/**
 * Quarry Worker. Static assets are served free (and keep serving after the 100k/day request cap); the Worker
 * runs only for /api/* and /mcp (`run_worker_first`). Logging: errors always, plus a 1% sample of request
 * summaries — never request bodies, keys or user text.
 */
import { getAgentByName } from "agents";
import { Hono } from "hono";
import { z } from "zod";
import { QuarryAgent, sanitizeProfile } from "./agent";
import { alertsRoutes, dispatchChanges, syncProfile } from "./alerts";
import { askPolicy } from "./ask";
import { BudgetDO } from "./budget";
import { getProgramJson } from "./data";
import { readByok } from "./llm";
import { MAX_BYTES, matchHosts } from "./match";
import { search } from "./search";
import type { Fixture } from "./tools";

export { BudgetDO, QuarryAgent };

type App = { Bindings: Env };
const app = new Hono<App>();

const Uid = z.string().regex(/^[a-f0-9]{32}$/);
const ip = (req: Request) => req.headers.get("cf-connecting-ip") ?? "0.0.0.0";

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function limit(rl: RateLimit | undefined, key: string) {
  if (!rl) return;
  const { success } = await rl.limit({ key });
  if (!success) throw new HttpError(429, "Too many requests — slow down a little.");
}

async function body<T>(c: { req: { json: () => Promise<unknown> } }, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
  const r = schema.safeParse(raw);
  if (!r.success)
    throw new HttpError(
      400,
      r.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")
        .slice(0, 300),
    );
  return r.data;
}

async function verifyTurnstile(env: Env, token: string | undefined, remoteip: string): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return true; // not configured (dev)
  if (!token) return false;
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token);
  form.append("remoteip", remoteip);
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  const j = (await r.json()) as { success?: boolean };
  return !!j.success;
}

/** Constant-time admin check; false when ADMIN_TOKEN isn't configured. */
function isAdmin(env: Env, header: string | undefined): boolean {
  const t = env.ADMIN_TOKEN;
  if (!t || t.length < 32 || !header) return false;
  const want = `Bearer ${t}`;
  if (header.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ header.charCodeAt(i);
  return diff === 0;
}

function agent(env: Env, uid: string) {
  return getAgentByName(env.QUARRY_AGENT, uid);
}

// ---------- middleware: sampled access log + error shape ----------
app.use("*", async (c, next) => {
  const t0 = Date.now();
  await next();
  if (Math.random() < 0.01)
    console.log(JSON.stringify({ path: new URL(c.req.url).pathname, status: c.res.status, ms: Date.now() - t0 }));
});
app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
  console.error(JSON.stringify({ path: new URL(c.req.url).pathname, error: String(err).slice(0, 300) }));
  return c.json({ error: "Something went wrong on our side." }, 500);
});

// ---------- public API ----------
app.get("/api/config", (c) =>
  c.json(
    {
      turnstile_sitekey: c.env.TURNSTILE_SITEKEY || null,
      vapid_public_key: c.env.VAPID_PUBLIC_KEY || null,
      telegram_bot: c.env.TELEGRAM_BOT_USERNAME || null,
      byok_providers: ["anthropic", "openai", "fireworks", "deepseek", "groq", "openrouter"],
    },
    200,
    { "cache-control": "public, max-age=300" },
  ),
);

const SearchBody = z.object({
  q: z.string().min(1).max(300),
  k: z.number().int().min(1).max(30).optional(),
  profile: z.unknown().optional(),
  filters: z
    .object({
      platforms: z.array(z.string().max(20)).max(15).optional(),
      categories: z.array(z.string().max(20)).max(12).optional(),
      bountyOnly: z.boolean().optional(),
      minUsd: z.number().min(0).optional(),
    })
    .optional(),
  rerank: z.boolean().optional(),
});
app.post("/api/search", async (c) => {
  await limit(c.env.RL_API, `search:${ip(c.req.raw)}`);
  const b = await body(c, SearchBody);
  const res = await search(c.env, b.q, {
    k: b.k ?? 10,
    profile: b.profile ? sanitizeProfile(b.profile) : null,
    filters: b.filters,
    rerank: b.rerank,
  });
  return c.json({
    mode: res.mode,
    results: res.results.map((h) => ({
      id: h.id,
      score: h.score,
      relevance: Math.round(h.relevance * 1000) / 1000,
      reasons: h.reasons,
      name: h.row.name,
      platform: h.row.platform,
    })),
    timings: res.timings,
  });
});

const ChatBody = z.object({
  uid: Uid,
  message: z.string().min(1).max(2000),
  turnstile: z.string().max(4096).optional(),
});
app.post("/api/chat", async (c) => {
  const b = await body(c, ChatBody);
  await limit(c.env.RL_CHAT, `chat:${b.uid}`);
  await limit(c.env.RL_API, `chat-ip:${ip(c.req.raw)}`);
  let byok = null;
  try {
    byok = readByok(c.req.raw);
  } catch (e) {
    throw new HttpError(400, String((e as Error).message));
  }
  const a = await agent(c.env, b.uid);
  let turnstileOk = false;
  if (c.env.TURNSTILE_SECRET) {
    const st = await a.getState();
    if (!st.turnstileOk) {
      if (!(await verifyTurnstile(c.env, b.turnstile, ip(c.req.raw))))
        throw new HttpError(403, "Please complete the human check first.");
      await a.markTurnstile();
      turnstileOk = true;
    }
  }
  // eval-only: fixture programs, accepted only with the admin token (never stored, never shown to users)
  let fixtures: Fixture[] | undefined;
  const fxHeader = c.req.header("x-quarry-eval-fixtures");
  if (fxHeader) {
    if (!isAdmin(c.env, c.req.header("authorization"))) throw new HttpError(403, "forbidden");
    fixtures = JSON.parse(atob(fxHeader)) as Fixture[];
  }
  const admin = isAdmin(c.env, c.req.header("authorization"));
  const r = await a.chat(b.message, { byok, fixtures, forceFallback: admin && c.req.header("x-quarry-eval-tier") === "fallback", dailyCap: isAdmin(c.env, c.req.header("authorization")) ? 10_000 : undefined });
  return c.json({ ...r, turnstile_ok: turnstileOk || undefined });
});

const AskBody = z.object({
  uid: Uid,
  program: z.string().min(3).max(200),
  question: z.string().min(3).max(500),
  turnstile: z.string().max(4096).optional(),
});
app.post("/api/ask", async (c) => {
  const b = await body(c, AskBody);
  await limit(c.env.RL_CHAT, `ask:${b.uid}`);
  await limit(c.env.RL_API, `ask-ip:${ip(c.req.raw)}`);
  let turnstileOk = false;
  if (c.env.TURNSTILE_SECRET) {
    const a = await agent(c.env, b.uid);
    if (!(await a.getState()).turnstileOk) {
      if (!(await verifyTurnstile(c.env, b.turnstile, ip(c.req.raw))))
        throw new HttpError(403, "Please complete the human check first.");
      await a.markTurnstile();
      turnstileOk = true;
    }
  }
  let byok = null;
  try {
    byok = readByok(c.req.raw);
  } catch (e) {
    throw new HttpError(400, String((e as Error).message));
  }
  return c.json({ ...(await askPolicy(c.env, b.program, b.question, byok)), turnstile_ok: turnstileOk || undefined });
});

const FeedbackBody = z.object({
  uid: Uid,
  program: z.string().min(3).max(200),
  action: z.enum(["save", "dismiss"]),
  reason: z.string().max(40).optional(),
});
app.post("/api/feedback", async (c) => {
  const b = await body(c, FeedbackBody);
  await limit(c.env.RL_API, `fb:${b.uid}`);
  await c.env.DB.prepare("INSERT INTO feedback (user_id, program_id, action, reason, ts) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(b.uid, b.program, b.action, b.reason ?? null, Math.floor(Date.now() / 1000))
    .run();
  // only touch the user's DO if they already have one (chat/alerts users); browsing users stay stateless
  return c.json({ ok: true });
});

const ProfileBody = z.object({ uid: Uid, profile: z.unknown() });
app.post("/api/profile", async (c) => {
  const b = await body(c, ProfileBody);
  await limit(c.env.RL_API, `profile:${b.uid}`);
  const p = sanitizeProfile(b.profile);
  await (await agent(c.env, b.uid)).setProfile(p);
  await syncProfile(c.env, b.uid, p);
  return c.json({ ok: true });
});

const DigestBody = z.object({ uid: Uid, optin: z.boolean(), hour_utc: z.number().int().min(0).max(23).optional() });
app.post("/api/digest", async (c) => {
  const b = await body(c, DigestBody);
  await limit(c.env.RL_API, `digest:${b.uid}`);
  return c.json(await (await agent(c.env, b.uid)).setDigest(b.optin, b.hour_utc ?? 8));
});

app.post("/api/match", async (c) => {
  await limit(c.env.RL_API, `match:${ip(c.req.raw)}`);
  const program = c.req.query("program") ?? "";
  const len = Number(c.req.header("content-length") ?? 0);
  if (len > MAX_BYTES) throw new HttpError(413, `At most ${MAX_BYTES / 1024} KB of hosts per request.`);
  const text = (await c.req.text()).slice(0, MAX_BYTES);
  const p = await getProgramJson(c.env, program);
  if (!p) throw new HttpError(404, "Unknown program.");
  return c.json({ program, ...matchHosts(text, p.assets ?? []) });
});

const MeBody = z.object({ uid: Uid });
app.delete("/api/me", async (c) => {
  const b = await body(c, MeBody);
  await limit(c.env.RL_API, `me:${ip(c.req.raw)}`);
  await (await agent(c.env, b.uid)).wipe();
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM subscriptions WHERE user_id = ?1").bind(b.uid),
    c.env.DB.prepare("DELETE FROM feedback WHERE user_id = ?1").bind(b.uid),
  ]);
  return c.json({ ok: true });
});

app.get("/api/status", async (c) => {
  const b = c.env.BUDGET.get(c.env.BUDGET.idFromName("global"));
  return c.json(await b.stats(7), 200, { "cache-control": "public, max-age=60" });
});

// ---------- admin (pipeline metrics, quota drills) ----------
app.post("/api/admin/budget-sim", async (c) => {
  if (!c.env.ADMIN_TOKEN || c.req.header("authorization") !== `Bearer ${c.env.ADMIN_TOKEN}`)
    throw new HttpError(403, "forbidden");
  const b = await body(c, z.object({ usd: z.number().min(0), neurons: z.number().min(0) }));
  return c.json(await c.env.BUDGET.get(c.env.BUDGET.idFromName("global")).simulate(b.usd, b.neurons));
});

alertsRoutes(app);

app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      const { success } = env.RL_MCP ? await env.RL_MCP.limit({ key: `mcp:${ip(req)}` }) : { success: true };
      if (!success) return Response.json({ error: "rate limited" }, { status: 429 });
      // loaded lazily: keeps the MCP SDK out of the startup path (and its zod schemas initialise after ours)
      const { mcpFetch } = await import("./mcp");
      return mcpFetch(req, env, ctx);
    }
    if (url.pathname.startsWith("/api/")) return app.fetch(req, env, ctx);
    return env.ASSETS.fetch(req);
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    // hourly: push alerts for changes since the previous run (state in D1 meta)
    const last = await env.DB.prepare("SELECT v FROM meta WHERE k = 'alerts_last_ts'").first<{ v: string }>();
    const since = Number(last?.v ?? Math.floor(controller.scheduledTime / 1000) - 3600);
    ctx.waitUntil(
      (async () => {
        try {
          const r = await dispatchChanges(env, since);
          await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('alerts_last_ts', ?1)")
            .bind(String(Math.floor(controller.scheduledTime / 1000)))
            .run();
          if (r.sent || r.failed) console.log(JSON.stringify({ cron: "alerts", ...r }));
        } catch (e) {
          console.error(JSON.stringify({ cron: "alerts", error: String(e).slice(0, 300) }));
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
