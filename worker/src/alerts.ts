/**
 * Alerts: Telegram, Discord webhook, Web Push and personal Atom feed.
 *
 * Opt-in only: a user receives something only if a row exists in `subscriptions` (see pipeline/sql/alerts.sql for the
 * extra index). Row conventions:
 *   kind 'telegram-pending'  target = one-time link code (hex, 128 bit), created_at = issue time (valid 1 h)
 *   kind 'telegram'          target = chat id
 *   kind 'discord'           target = webhook URL (validated, never logged)
 *   kind 'push'              target = PushSubscription JSON
 *   kind 'rss'               target = feed token (256 bit hex)
 *
 * Secrets / config: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, VAPID_PRIVATE_KEY (base64url of the raw 32-byte
 * P-256 private scalar `d`, as printed by generateVapidKeys; NOT a JWK), vars SITE_URL, TELEGRAM_BOT_USERNAME,
 * VAPID_PUBLIC_KEY (base64url of the 65-byte uncompressed public point), VAPID_SUBJECT (mailto: or https: URL).
 *
 * Nothing here logs secrets, tokens, webhook URLs or chat ids: only counts and status codes.
 * `./data` (wasm import) and the push library are imported lazily so the pure helpers stay testable in plain Node.
 */
import type { Context, Hono } from "hono";
import { z } from "zod";
import { type CatalogProgram, excludedBy, type Profile, scoreProgram } from "../../ranking/score";
import type { ProgramRow } from "./data";

interface AlertsExtra {
  SITE_URL?: string;
  TELEGRAM_BOT_USERNAME?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_SUBJECT?: string;
  RL_ALERTS?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
}
type AEnv = Env & AlertsExtra;
const ext = (env: Env) => env as AEnv;
type Ctx = Context<{ Bindings: Env }>;

const DAY = 86400;
export const MAX_SENDS_PER_RUN = 40;
const MAX_ITEMS = 5;
const CODE_TTL_S = 3600;
const KINDS = ["telegram", "discord", "push", "rss"] as const;
type Kind = (typeof KINDS)[number];
const FAIL_LIMIT: Record<string, number> = { discord: 3, telegram: 8, push: 8 };

const nowS = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const data = () => import("./data");

// ---------- pure helpers (exported for tests) ----------

export function randomHex(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escapes text for an Atom document and drops characters that are illegal in XML 1.0. */
export function xmlEscape(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    const ok =
      c === 9 || c === 10 || c === 13 || (c >= 0x20 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xfffd) || c >= 0x10000;
    if (!ok) continue;
    out +=
      ch === "&"
        ? "&amp;"
        : ch === "<"
          ? "&lt;"
          : ch === ">"
            ? "&gt;"
            : ch === '"'
              ? "&quot;"
              : ch === "'"
                ? "&apos;"
                : ch;
  }
  return out;
}

/** Escapes Discord markdown / mention syntax in untrusted text. */
export function escapeDiscord(s: string): string {
  return s.replace(/([\\*_`~|>[\]()<@#:])/g, "\\$1");
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const DISCORD_HOSTS = new Set(["discord.com", "discordapp.com"]);
const DISCORD_PATH = /^\/api\/webhooks\/\d{15,22}\/[A-Za-z0-9_-]{30,120}$/;

/** Returns the canonical webhook URL, or null. Strict to prevent SSRF through the stored webhook. */
export function parseDiscordWebhook(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 300) return null;
  if (/[\s\\?#@]/.test(input)) return null; // whitespace, backslash (URL treats it as '/'), query, fragment, userinfo
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || !DISCORD_HOSTS.has(u.hostname)) return null;
  if (u.port !== "" || u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "") return null;
  if (!DISCORD_PATH.test(u.pathname)) return null;
  return `https://${u.hostname}${u.pathname}`;
}

export function isAllowedPushEndpoint(input: unknown): boolean {
  if (typeof input !== "string" || input.length > 1024 || /[\s\\]/.test(input)) return false;
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.port !== "" || u.username !== "" || u.password !== "" || u.hash !== "") return false;
  const h = u.hostname;
  return (
    h === "fcm.googleapis.com" ||
    h === "updates.push.services.mozilla.com" ||
    h === "web.push.apple.com" ||
    (h.endsWith(".notify.windows.com") && h.length > ".notify.windows.com".length)
  );
}

export type TelegramCommand = { cmd: "start"; code: string } | { cmd: "stop" } | { cmd: "help" };

export function parseTelegramCommand(text: unknown): TelegramCommand {
  if (typeof text !== "string" || text.length > 256) return { cmd: "help" };
  const m = /^\/(start|stop)(?:@\w{1,64})?(?:[ \t]+(\S+))?[ \t]*$/i.exec(text.trim());
  if (!m) return { cmd: "help" };
  if (m[1].toLowerCase() === "stop") return { cmd: "stop" };
  if (m[2] && /^[A-Za-z0-9_-]{16,64}$/.test(m[2])) return { cmd: "start", code: m[2].toLowerCase() };
  return { cmd: "help" };
}

export async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

const b64u = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/** VAPID key pair for a setup script: publicKey = 65-byte uncompressed point, privateKey = raw 32-byte `d`; both base64url. */
export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as JsonWebKey;
  if (!jwk.x || !jwk.y || !jwk.d) throw new Error("jwk export failed");
  const pub = new Uint8Array(65);
  pub[0] = 4;
  pub.set(unb64u(jwk.x), 1);
  pub.set(unb64u(jwk.y), 33);
  return { publicKey: b64u(pub), privateKey: jwk.d };
}

// ---------- messages ----------

export interface MsgItem {
  name: string;
  what: string;
  url: string;
}
export interface Msg {
  title: string;
  items: MsgItem[];
}

export function renderTelegram(m: Msg): string {
  const lines = m.items.map(
    (i) =>
      `• <a href="${escapeHtml(i.url)}">${escapeHtml(clip(clean(i.name), 80))}</a> — ${escapeHtml(clip(clean(i.what), 140))}`,
  );
  return `<b>${escapeHtml(m.title)}</b>\n${lines.join("\n")}\n\n/stop to unsubscribe`;
}

export function renderDiscord(m: Msg): string {
  const lines = m.items.map(
    (i) => `• [${escapeDiscord(clip(clean(i.name), 80))}](<${i.url}>) — ${escapeDiscord(clip(clean(i.what), 140))}`,
  );
  return clip(`**${escapeDiscord(m.title)}**\n${lines.join("\n")}`, 2000);
}

export function renderPush(m: Msg): { title: string; body: string; url: string } {
  const first = m.items[0];
  const more = m.items.length > 1 ? ` (+${m.items.length - 1} more)` : "";
  return {
    title: clip(m.title, 80),
    body: first ? clip(`${clean(first.name)}: ${clean(first.what)}${more}`, 200) : "",
    url: first?.url ?? "",
  };
}

const KIND_LABEL: Record<string, string> = {
  NEW: "New program",
  SCOPE: "New scope",
  OPEN: "Program opened",
  BOUNTY: "Bounty changed",
};

export function describeChange(kind: string, summary: string | null): string {
  const label = KIND_LABEL[kind] ?? kind;
  const s = clean(summary ?? "");
  return s ? `${label}: ${s}` : label;
}

// ---------- delivery ----------

type Outcome = "ok" | "gone" | "fail" | "skip";
interface SubRow {
  id: string;
  user_id: string;
  kind: string;
  target: string;
  profile?: string | null;
  failures: number;
}

const chatLast = new Map<string, number>();
let tgGlobalLast = 0;
/** <= 1 msg/s per chat, <= 25 msg/s overall (best effort per isolate). */
async function tgPace(chat: string): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, tgGlobalLast + 40 - now, (chatLast.get(chat) ?? 0) + 1000 - now);
  if (wait > 0) await sleep(wait);
  const t = Date.now();
  tgGlobalLast = t;
  chatLast.set(chat, t);
  if (chatLast.size > 500) chatLast.clear();
}

async function retryAfter(r: Response, field: "json-seconds" | "telegram"): Promise<number> {
  try {
    const j = (await r.json()) as { retry_after?: number; parameters?: { retry_after?: number } };
    const v = field === "telegram" ? j.parameters?.retry_after : j.retry_after;
    if (typeof v === "number" && v >= 0) return v;
  } catch {
    // ignore
  }
  return 60;
}

async function sendTelegram(env: Env, chatId: string, html: string, canRetry = true): Promise<Outcome> {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token || !/^-?\d{1,20}$/.test(chatId)) return "skip";
  await tgPace(chatId);
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: clip(html, 4000),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  if (r.ok) return "ok";
  if (r.status === 403) return "gone"; // bot blocked / kicked
  if (r.status === 429) {
    const wait = await retryAfter(r, "telegram");
    if (canRetry && wait <= 5) {
      await sleep(wait * 1000 + 50);
      return sendTelegram(env, chatId, html, false);
    }
    return "skip";
  }
  if (r.status === 400) {
    const t = await r.text().catch(() => "");
    if (/chat not found|user is deactivated/i.test(t)) return "gone";
  }
  return "fail";
}

async function postDiscord(webhook: string, content: string, canRetry = true): Promise<Outcome> {
  const url = parseDiscordWebhook(webhook);
  if (!url) return "gone"; // never fetch anything that fails the strict check
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    redirect: "manual",
    body: JSON.stringify({ content: clip(content, 2000), allowed_mentions: { parse: [] } }),
  });
  if (r.ok) return "ok";
  if (r.status === 404 || r.status === 401) return "gone";
  if (r.status === 429) {
    const wait = await retryAfter(r, "json-seconds");
    if (canRetry && wait <= 5) {
      await sleep(wait * 1000 + 50);
      return postDiscord(webhook, content, false);
    }
    return "skip";
  }
  return "fail";
}

async function sendPush(env: Env, targetJson: string, payload: unknown): Promise<Outcome> {
  const e = ext(env);
  if (!env.VAPID_PRIVATE_KEY || !e.VAPID_PUBLIC_KEY || !e.VAPID_SUBJECT) return "skip";
  let sub: z.infer<typeof pushSubSchema>;
  try {
    sub = pushSubSchema.parse(JSON.parse(targetJson));
  } catch {
    return "gone";
  }
  try {
    const { buildPushPayload } = await import("@block65/webcrypto-web-push");
    const req = await buildPushPayload(
      { data: payload as Record<string, string>, options: { ttl: 3600, urgency: "normal" } },
      { endpoint: sub.endpoint, expirationTime: sub.expirationTime ?? null, keys: sub.keys },
      { subject: e.VAPID_SUBJECT, publicKey: e.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY },
    );
    const r = await fetch(sub.endpoint, { ...req, redirect: "manual" });
    if (r.ok) return "ok";
    if (r.status === 404 || r.status === 410) return "gone";
    if (r.status === 429) return "skip";
    return "fail";
  } catch (err) {
    console.error("alerts: push send error", err instanceof Error ? err.name : "unknown");
    return "fail";
  }
}

async function sendOne(env: Env, sub: SubRow, msg: Msg): Promise<Outcome> {
  try {
    if (sub.kind === "telegram") return await sendTelegram(env, sub.target, renderTelegram(msg));
    if (sub.kind === "discord") return await postDiscord(sub.target, renderDiscord(msg));
    if (sub.kind === "push") return await sendPush(env, sub.target, renderPush(msg));
  } catch (err) {
    console.error("alerts: send error", sub.kind, err instanceof Error ? err.name : "unknown");
    return "fail";
  }
  return "skip";
}

interface RunState {
  sends: number;
  failed: number;
  stmts: D1PreparedStatement[];
}

/** Sends one message to one subscription, queuing the bookkeeping write. Returns 1 if delivered. */
async function deliver(env: Env, sub: SubRow, msg: Msg, st: RunState): Promise<number> {
  st.sends++;
  const out = await sendOne(env, sub, msg);
  const db = env.DB;
  if (out === "ok") {
    st.stmts.push(
      db.prepare("UPDATE subscriptions SET last_sent_at = ?1, failures = 0 WHERE id = ?2").bind(nowS(), sub.id),
    );
    return 1;
  }
  if (out === "gone") {
    st.stmts.push(db.prepare("DELETE FROM subscriptions WHERE id = ?1").bind(sub.id));
    st.failed++;
  } else if (out === "fail") {
    st.failed++;
    if (sub.failures + 1 >= (FAIL_LIMIT[sub.kind] ?? 5)) {
      st.stmts.push(db.prepare("DELETE FROM subscriptions WHERE id = ?1").bind(sub.id)); // disabled: stop sending
    } else {
      st.stmts.push(db.prepare("UPDATE subscriptions SET failures = failures + 1 WHERE id = ?1").bind(sub.id));
    }
  }
  return 0;
}

async function flush(env: Env, st: RunState): Promise<void> {
  for (let i = 0; i < st.stmts.length; i += 90) await env.DB.batch(st.stmts.slice(i, i + 90));
}

// ---------- profile snapshots ----------

export async function syncProfile(env: Env, uid: string, profile: Profile): Promise<void> {
  const p: Profile = {
    ...profile,
    dismissed: (profile.dismissed ?? []).slice(-200),
    saved: (profile.saved ?? []).slice(-200),
  };
  let json = JSON.stringify(p);
  if (json.length > 16000) json = JSON.stringify({ ...p, dismissed: [], saved: [] });
  await env.DB.prepare("UPDATE subscriptions SET profile = ?1 WHERE user_id = ?2").bind(json, uid).run();
}

function parseProfile(s: string | null | undefined): Profile {
  if (!s) return {};
  try {
    const p = JSON.parse(s);
    return p && typeof p === "object" ? (p as Profile) : {};
  } catch {
    return {};
  }
}

// ---------- dispatch ----------

const siteOf = (env: Env, req?: Request) =>
  (ext(env).SITE_URL ?? (req ? new URL(req.url).origin : "")).replace(/\/+$/, "");

interface ChangeRow {
  id: string;
  ts: number;
  kind: string;
  prio: number | null;
  program_id: string;
  title: string | null;
  summary: string | null;
}

/** Hourly cron: `sinceTs` is unix seconds. At most one message per user, up to 5 items. */
export async function dispatchChanges(
  env: Env,
  sinceTs: number,
): Promise<{ users: number; sent: number; failed: number }> {
  const none = { users: 0, sent: 0, failed: 0 };
  const changes = (
    await env.DB.prepare(
      `SELECT id, ts, kind, prio, program_id, title, summary FROM changes
        WHERE ts > ?1 AND kind IN ('NEW','SCOPE','OPEN','BOUNTY') AND program_id IS NOT NULL ORDER BY ts DESC LIMIT 300`,
    )
      .bind(sinceTs)
      .all<ChangeRow>()
  ).results;
  if (!changes.length) return none;
  const subs = (
    await env.DB.prepare(
      `SELECT id, user_id, kind, target, profile, failures FROM subscriptions
        WHERE kind IN ('telegram','discord','push') ORDER BY user_id LIMIT 2000`,
    ).all<SubRow>()
  ).results;
  if (!subs.length) return none;

  const { programsByIds, toCatalog, programPaths } = await data();
  const rows = await programsByIds(
    env,
    changes.map((c) => c.program_id),
  );
  const now = nowS();
  const cat = new Map<string, CatalogProgram>();
  for (const [id, row] of rows) cat.set(id, toCatalog(row, now) as CatalogProgram);
  const site = siteOf(env);

  const byUser = new Map<string, SubRow[]>();
  for (const s of subs) {
    const l = byUser.get(s.user_id);
    if (l) l.push(s);
    else byUser.set(s.user_id, [s]);
  }

  const st: RunState = { sends: 0, failed: 0, stmts: [] };
  let users = 0;
  let sent = 0;
  for (const [, list] of byUser) {
    if (st.sends >= MAX_SENDS_PER_RUN) break;
    const profile = parseProfile(list.find((s) => s.profile)?.profile);
    const items: MsgItem[] = [];
    const seen = new Set<string>();
    for (const c of changes) {
      if (items.length >= MAX_ITEMS) break;
      const p = cat.get(c.program_id);
      if (!p || seen.has(c.program_id) || excludedBy(p, profile)) continue;
      seen.add(c.program_id);
      items.push({ name: p.n, what: describeChange(c.kind, c.summary), url: site + programPaths(c.program_id).page });
    }
    if (!items.length) continue;
    users++;
    const msg: Msg = { title: `Quarry: ${items.length} update${items.length > 1 ? "s" : ""} for you`, items };
    for (const s of list) {
      if (st.sends >= MAX_SENDS_PER_RUN) break;
      sent += await deliver(env, s, msg, st);
    }
  }
  await flush(env, st);
  console.log(`alerts: dispatch users=${users} sent=${sent} failed=${st.failed}`);
  return { users, sent, failed: st.failed };
}

/** Today's top 5 among programs with new scope in the last 24 h, excluding `shown`; one message per channel. */
export async function digestFor(env: Env, uid: string, profile: Profile, shown: string[]): Promise<{ sent: number }> {
  const now = nowS();
  const subs = (
    await env.DB.prepare(
      "SELECT id, user_id, kind, target, failures FROM subscriptions WHERE user_id = ?1 AND kind IN ('telegram','discord','push')",
    )
      .bind(uid)
      .all<SubRow>()
  ).results;
  if (!subs.length) return { sent: 0 };
  const fresh = (
    await env.DB.prepare(
      "SELECT program_id, COUNT(*) AS n FROM recent_assets WHERE added_at > ?1 GROUP BY program_id ORDER BY n DESC LIMIT 90",
    )
      .bind(now - DAY)
      .all<{ program_id: string; n: number }>()
  ).results;
  const skip = new Set(shown);
  const counts = new Map(fresh.filter((f) => !skip.has(f.program_id)).map((f) => [f.program_id, f.n]));
  if (!counts.size) return { sent: 0 };

  const { programsByIds, toCatalog, programPaths } = await data();
  const rows = await programsByIds(env, [...counts.keys()]);
  const ranked = [...rows.values()]
    .map((r) => toCatalog(r, now) as CatalogProgram)
    .filter((p) => !excludedBy(p, profile))
    .map((p) => scoreProgram(p, profile, now))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, MAX_ITEMS);
  if (!ranked.length) return { sent: 0 };

  const site = siteOf(env);
  const items: MsgItem[] = ranked.map((s) => {
    const n = counts.get(s.id) ?? 0;
    const why = s.reasons.slice(0, 2).join(", ");
    return {
      name: rows.get(s.id)?.name ?? s.id,
      what: `${n} new in-scope asset${n === 1 ? "" : "s"}${why ? `; ${why}` : ""}`,
      url: site + programPaths(s.id).page,
    };
  });
  const msg: Msg = { title: "Quarry daily digest: top picks with new scope", items };
  const st: RunState = { sends: 0, failed: 0, stmts: [] };
  let sent = 0;
  for (const s of subs) sent += await deliver(env, s, msg, st);
  await flush(env, st);
  return { sent };
}

// ---------- Atom feed ----------

export interface FeedEntry {
  id: string;
  ts: number;
  title: string;
  url: string;
  summary: string;
}

export function buildAtom(opts: { selfUrl: string; siteUrl: string; entries: FeedEntry[]; now: number }): string {
  const updated = new Date((opts.entries[0]?.ts ?? opts.now) * 1000).toISOString();
  const entries = opts.entries
    .map(
      (e) =>
        `<entry><id>${xmlEscape(e.id)}</id><title>${xmlEscape(clip(clean(e.title), 200))}</title>` +
        `<link href="${xmlEscape(e.url)}"/><updated>${new Date(e.ts * 1000).toISOString()}</updated>` +
        `<summary type="text">${xmlEscape(clip(clean(e.summary), 500))}</summary></entry>`,
    )
    .join("");
  return (
    `<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">` +
    `<id>${xmlEscape(opts.selfUrl)}</id><title>Quarry alerts</title>` +
    `<link rel="self" href="${xmlEscape(opts.selfUrl)}"/><link href="${xmlEscape(opts.siteUrl)}/"/>` +
    `<updated>${updated}</updated>${entries}</feed>`
  );
}

async function feedEntries(env: Env, profile: Profile, site: string): Promise<FeedEntry[]> {
  const now = nowS();
  const since = now - 14 * DAY;
  const [ch, as] = await Promise.all([
    env.DB.prepare(
      `SELECT id, ts, kind, prio, program_id, title, summary FROM changes
        WHERE ts > ?1 AND kind IN ('NEW','SCOPE','OPEN','BOUNTY') AND program_id IS NOT NULL ORDER BY ts DESC LIMIT 200`,
    )
      .bind(since)
      .all<ChangeRow>(),
    env.DB.prepare(
      "SELECT program_id, ident, added_at FROM recent_assets WHERE added_at > ?1 ORDER BY added_at DESC LIMIT 300",
    )
      .bind(since)
      .all<{ program_id: string; ident: string; added_at: number }>(),
  ]);
  const { programsByIds, toCatalog, programPaths } = await data();

  const assetsBy = new Map<string, { ts: number; idents: string[] }>();
  for (const a of as.results) {
    const g = assetsBy.get(a.program_id);
    if (g) g.idents.push(a.ident);
    else assetsBy.set(a.program_id, { ts: a.added_at, idents: [a.ident] });
  }
  type Ev = { ts: number; pid: string; kind: "change" | "assets"; ch?: ChangeRow };
  const events: Ev[] = [
    ...ch.results.map((c) => ({ ts: c.ts, pid: c.program_id, kind: "change" as const, ch: c })),
    ...[...assetsBy].map(([pid, g]) => ({ ts: g.ts, pid, kind: "assets" as const })),
  ].sort((a, b) => b.ts - a.ts);

  const rows: Map<string, ProgramRow> = await programsByIds(
    env,
    events.map((e) => e.pid),
  );
  const cat = new Map<string, CatalogProgram>();
  const out: FeedEntry[] = [];
  for (const e of events) {
    if (out.length >= 50) break;
    const row = rows.get(e.pid);
    if (!row) continue;
    let p = cat.get(e.pid);
    if (!p) {
      p = toCatalog(row, now) as CatalogProgram;
      cat.set(e.pid, p);
    }
    if (excludedBy(p, profile)) continue;
    const url = site + programPaths(e.pid).page;
    if (e.ch) {
      out.push({
        id: `tag:quarry,2026:change:${e.ch.id}`,
        ts: e.ts,
        title: `${row.name}: ${KIND_LABEL[e.ch.kind] ?? e.ch.kind}`,
        url,
        summary: e.ch.summary ?? e.ch.title ?? "",
      });
    } else {
      const g = assetsBy.get(e.pid);
      if (!g) continue;
      const list = g.idents.slice(0, 5).join(", ") + (g.idents.length > 5 ? ` (+${g.idents.length - 5} more)` : "");
      out.push({
        id: `tag:quarry,2026:assets:${e.pid}:${e.ts}`,
        ts: e.ts,
        title: `${row.name}: ${g.idents.length} new in-scope asset${g.idents.length === 1 ? "" : "s"}`,
        url,
        summary: list,
      });
    }
  }
  return out;
}

// ---------- routes ----------

const uidSchema = z.string().regex(/^[0-9a-f]{32}$/);
const uidBody = z.object({ uid: uidSchema });
const discordBody = z.object({ uid: uidSchema, webhook: z.string().max(300) });
const pushSubSchema = z.object({
  endpoint: z.string().max(1024).refine(isAllowedPushEndpoint, "unsupported push service"),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().regex(/^[A-Za-z0-9_-]{80,100}={0,2}$/),
    auth: z.string().regex(/^[A-Za-z0-9_-]{20,30}={0,2}$/),
  }),
});
const pushBody = z.object({ uid: uidSchema, subscription: pushSubSchema });
const kindSchema = z.enum(KINDS);

async function readJson(c: Ctx, max = 8192): Promise<unknown> {
  const len = Number(c.req.header("content-length") ?? 0);
  if (len > max) return undefined;
  try {
    const text = await c.req.text();
    return text.length > max ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function limited(c: Ctx, scope: string): Promise<boolean> {
  const rl = ext(c.env).RL_ALERTS;
  if (!rl) return false;
  try {
    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    return !(await rl.limit({ key: `${scope}:${ip}` })).success;
  } catch {
    return false;
  }
}

/** Replace the uid's row of `kind`, inheriting the profile snapshot from any existing row. */
async function upsertSub(env: Env, uid: string, kind: string, target: string): Promise<void> {
  const id = randomHex(16);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO subscriptions (id, user_id, kind, target, profile, created_at)
       VALUES (?1, ?2, ?3, ?4, (SELECT profile FROM subscriptions WHERE user_id = ?2 AND profile IS NOT NULL LIMIT 1), ?5)`,
    ).bind(id, uid, kind, target, nowS()),
    env.DB.prepare("DELETE FROM subscriptions WHERE user_id = ?1 AND kind = ?2 AND id <> ?3").bind(uid, kind, id),
  ]);
}

const bad = (c: Ctx, status: 400 | 429 | 503 | 502 = 400, error = "invalid request") => c.json({ error }, status);

export function alertsRoutes(app: Hono<{ Bindings: Env }>): void {
  app.get("/api/alerts", async (c) => {
    const uid = uidSchema.safeParse(c.req.query("uid"));
    if (!uid.success) return bad(c);
    const rows = (
      await c.env.DB.prepare(
        "SELECT kind, target FROM subscriptions WHERE user_id = ?1 AND kind IN ('telegram','discord','push','rss')",
      )
        .bind(uid.data)
        .all<{ kind: string; target: string }>()
    ).results;
    const has = (k: string) => rows.some((r) => r.kind === k);
    const rss = rows.find((r) => r.kind === "rss");
    return c.json({
      telegram: has("telegram"),
      discord: has("discord"),
      push: has("push"),
      rss: rss ? `${siteOf(c.env, c.req.raw)}/api/feed/${rss.target}.xml` : null,
    });
  });

  app.post("/api/alerts/telegram", async (c) => {
    const e = ext(c.env);
    if (!c.env.TELEGRAM_BOT_TOKEN || !e.TELEGRAM_BOT_USERNAME) return bad(c, 503, "telegram bot not configured");
    if (await limited(c, "tg")) return bad(c, 429, "too many requests");
    const b = uidBody.safeParse(await readJson(c));
    if (!b.success) return bad(c);
    const code = randomHex(16);
    await c.env.DB.batch([
      c.env.DB.prepare(
        "DELETE FROM subscriptions WHERE kind = 'telegram-pending' AND (user_id = ?1 OR created_at < ?2)",
      ).bind(b.data.uid, nowS() - CODE_TTL_S),
      c.env.DB.prepare(
        `INSERT INTO subscriptions (id, user_id, kind, target, profile, created_at)
         VALUES (?1, ?2, 'telegram-pending', ?3, (SELECT profile FROM subscriptions WHERE user_id = ?2 AND profile IS NOT NULL LIMIT 1), ?4)`,
      ).bind(randomHex(16), b.data.uid, code, nowS()),
    ]);
    return c.json({ link: `https://t.me/${e.TELEGRAM_BOT_USERNAME}?start=${code}` });
  });

  app.post("/api/telegram/webhook", async (c) => {
    const secret = c.env.TELEGRAM_WEBHOOK_SECRET;
    const got = c.req.header("X-Telegram-Bot-Api-Secret-Token");
    if (!secret || !got || !(await safeEqual(got, secret))) return c.json({ error: "forbidden" }, 403);
    const upd = (await readJson(c, 65536)) as
      | { message?: { text?: string; chat?: { id?: number; type?: string } } }
      | undefined;
    const chatId = upd?.message?.chat?.id;
    // Telegram retries non-2xx replies, so everything past the secret check answers 200.
    if (typeof chatId !== "number" || !Number.isSafeInteger(chatId)) return c.json({ ok: true });
    const chat = String(chatId);
    const reply = (text: string) => c.json({ method: "sendMessage", chat_id: chatId, text });
    const cmd = parseTelegramCommand(upd?.message?.text);
    const isPrivate = upd?.message?.chat?.type === "private";
    const help = "Quarry alerts. Create a link on Quarry's alerts page to connect this chat. /stop to unsubscribe.";

    if (cmd.cmd === "stop") {
      await c.env.DB.prepare("DELETE FROM subscriptions WHERE kind = 'telegram' AND target = ?1").bind(chat).run();
      return reply("Unsubscribed. You won't get Quarry alerts here any more.");
    }
    if (cmd.cmd === "start" && isPrivate) {
      const row = await c.env.DB.prepare(
        "SELECT id, user_id FROM subscriptions WHERE kind = 'telegram-pending' AND target = ?1 AND created_at > ?2",
      )
        .bind(cmd.code, nowS() - CODE_TTL_S)
        .first<{ id: string; user_id: string }>();
      if (!row) return reply("That link has expired or was already used. Create a new one on Quarry.");
      await c.env.DB.batch([
        c.env.DB.prepare("DELETE FROM subscriptions WHERE kind = 'telegram' AND (user_id = ?1 OR target = ?2)").bind(
          row.user_id,
          chat,
        ),
        c.env.DB.prepare(
          "UPDATE subscriptions SET kind = 'telegram', target = ?1, created_at = ?2, failures = 0 WHERE id = ?3",
        ).bind(chat, nowS(), row.id),
      ]);
      return reply("Linked. You'll get Quarry alerts here. /stop to unsubscribe.");
    }
    return reply(help);
  });

  app.post("/api/alerts/discord", async (c) => {
    if (await limited(c, "dc")) return bad(c, 429, "too many requests");
    const b = discordBody.safeParse(await readJson(c));
    if (!b.success) return bad(c);
    const url = parseDiscordWebhook(b.data.webhook);
    if (!url) return bad(c, 400, "not a Discord webhook URL");
    let out: Outcome = "fail";
    try {
      out = await postDiscord(url, "Quarry alerts connected");
    } catch {
      out = "fail";
    }
    if (out !== "ok") {
      console.error("alerts: discord test message not accepted");
      return bad(c, 502, "Discord did not accept the test message");
    }
    await upsertSub(c.env, b.data.uid, "discord", url);
    return c.json({ ok: true });
  });

  app.post("/api/alerts/push", async (c) => {
    if (await limited(c, "push")) return bad(c, 429, "too many requests");
    const b = pushBody.safeParse(await readJson(c));
    if (!b.success) return bad(c);
    const s = b.data.subscription;
    const clean1 = { endpoint: s.endpoint, expirationTime: s.expirationTime ?? null, keys: s.keys };
    await upsertSub(c.env, b.data.uid, "push", JSON.stringify(clean1));
    return c.json({ ok: true });
  });

  app.post("/api/alerts/rss", async (c) => {
    if (await limited(c, "rss")) return bad(c, 429, "too many requests");
    const b = uidBody.safeParse(await readJson(c));
    if (!b.success) return bad(c);
    const existing = await c.env.DB.prepare(
      "SELECT target FROM subscriptions WHERE user_id = ?1 AND kind = 'rss' LIMIT 1",
    )
      .bind(b.data.uid)
      .first<{ target: string }>();
    let token = existing?.target;
    if (!token) {
      token = randomHex(32); // 256 bits
      await upsertSub(c.env, b.data.uid, "rss", token);
    }
    return c.json({ url: `${siteOf(c.env, c.req.raw)}/api/feed/${token}.xml` });
  });

  app.delete("/api/alerts/:kind", async (c) => {
    const kind = kindSchema.safeParse(c.req.param("kind"));
    const b = uidBody.safeParse(await readJson(c));
    if (!kind.success || !b.success) return bad(c);
    const k: Kind = kind.data;
    await c.env.DB.prepare("DELETE FROM subscriptions WHERE user_id = ?1 AND kind IN (?2, ?3)")
      .bind(b.data.uid, k, k === "telegram" ? "telegram-pending" : k)
      .run();
    return c.json({ ok: true });
  });

  app.get("/api/feed/:file", async (c) => {
    const m = /^([0-9a-f]{64})\.xml$/.exec(c.req.param("file"));
    if (!m)
      return new Response('{"error":"not found"}', { status: 404, headers: { "content-type": "application/json" } });
    const row = await c.env.DB.prepare("SELECT profile FROM subscriptions WHERE kind = 'rss' AND target = ?1")
      .bind(m[1])
      .first<{ profile: string | null }>();
    if (!row)
      return new Response('{"error":"not found"}', { status: 404, headers: { "content-type": "application/json" } });
    const site = siteOf(c.env, c.req.raw);
    const entries = await feedEntries(c.env, parseProfile(row.profile), site);
    const xml = buildAtom({ selfUrl: `${site}/api/feed/${m[1]}.xml`, siteUrl: site, entries, now: nowS() });
    return new Response(xml, {
      headers: {
        "content-type": "application/atom+xml; charset=utf-8",
        "cache-control": "private, max-age=900",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    });
  });
}
