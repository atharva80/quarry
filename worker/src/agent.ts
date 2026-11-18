/**
 * QuarryAgent: one Agents SDK Durable Object per anonymous user (uid from the browser).
 * Memory: profile (hard vs soft constraints), feedback history, rolling conversation summary, recent messages,
 * and the "already shown" set. Proactive: an opt-in daily digest via the Agent's scheduler (DO alarms).
 */
import { Agent } from "agents";
import { z } from "zod";
import SYSTEM from "../../prompts/agent_system.md";
import type { Profile } from "../../ranking/score";
import { programsByIds } from "./data";
import { check, type FinalAnswer, trim, type Violation } from "./grounding";
import { type Byok, type ChatMessage, chat, LimitReached, type ToolDef, Unavailable } from "./llm";
import { runTool, type ToolCtx, ToolError, type ToolName, toolDefs } from "./tools";

export interface AgentState {
  profile: Profile;
  summary: string;
  shown: string[];
  turnstileOk: boolean;
  digest: { optin: boolean; hourUtc: number; lastSent?: number };
  day: string;
  chatsToday: number;
  created: number;
}

const FINAL: ToolDef = {
  type: "function",
  function: {
    name: "final_answer",
    description: "Finish the turn with the user-visible reply and its grounding.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["reply", "programs", "rule_claims"],
      properties: {
        reply: { type: "string" },
        programs: { type: "array", items: { type: "string" }, description: "ids of every program the reply names" },
        rule_claims: {
          type: "array",
          items: {
            type: "object",
            required: ["program", "field", "quote"],
            properties: { program: { type: "string" }, field: { type: "string" }, quote: { type: "string" } },
          },
        },
      },
    },
  },
};
const FinalSchema = z.object({
  reply: z.string().min(1).max(6000),
  programs: z.array(z.string().max(200)).max(20).default([]),
  rule_claims: z
    .array(z.object({ program: z.string().max(200), field: z.string().max(40), quote: z.string().max(800) }))
    .max(20)
    .default([]),
});

const TOOLS: ToolName[] = [
  "search_programs",
  "get_program",
  "explain_match",
  "can_i_test",
  "whats_new_for_me",
  "compare_programs",
  "save",
  "dismiss",
  "update_profile",
  "export_scope",
];
const MAX_ROUNDS = 5;
const KEEP_MESSAGES = 12;

export interface ChatReply {
  reply: string;
  programs: string[];
  quotes: { program: string; field: string; quote: string }[];
  tools: string[];
  limited?: boolean;
  model?: string;
  tier?: string;
  grounding: { violations_first: number; regenerated: boolean; trimmed: boolean };
  usage: { usd: number; input: number; output: number };
}

const today = () => new Date().toISOString().slice(0, 10);

export class QuarryAgent extends Agent<Env, AgentState> {
  initialState: AgentState = {
    profile: {},
    summary: "",
    shown: [],
    turnstileOk: false,
    digest: { optin: false, hourUtc: 8 },
    day: today(),
    chatsToday: 0,
    created: Date.now(),
  };

  private ensureTables() {
    this
      .sql`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, role TEXT, content TEXT)`;
    this.sql`CREATE TABLE IF NOT EXISTS feedback (ts INTEGER, program TEXT, action TEXT, reason TEXT)`;
  }

  async getState() {
    return {
      profile: this.state.profile,
      digest: this.state.digest,
      turnstileOk: this.state.turnstileOk,
      shown: this.state.shown.length,
    };
  }

  async setProfile(profile: Profile) {
    this.setState({ ...this.state, profile: sanitizeProfile(profile) });
    return { ok: true };
  }

  async markTurnstile() {
    this.setState({ ...this.state, turnstileOk: true });
  }

  async feedback(program: string, action: "save" | "dismiss", reason?: string) {
    this.ensureTables();
    this.sql`INSERT INTO feedback VALUES (${Date.now()}, ${program}, ${action}, ${reason ?? null})`;
    const p = { ...this.state.profile };
    if (action === "save") p.saved = [...new Set([...(p.saved ?? []), program])].slice(-200);
    else
      p.dismissed = [
        ...(p.dismissed ?? []).filter((d) => d.id !== program),
        { id: program, reason, ts: Math.floor(Date.now() / 1000) },
      ].slice(-300);
    this.setState({ ...this.state, profile: p });
    return { ok: true };
  }

  async setDigest(optin: boolean, hourUtc = 8) {
    const h = Math.max(0, Math.min(23, Math.floor(hourUtc)));
    this.setState({ ...this.state, digest: { ...this.state.digest, optin, hourUtc: h } });
    for (const s of this.getSchedules()) if (s.callback === "dailyDigest") await this.cancelSchedule(s.id);
    if (optin) await this.schedule(`0 ${h} * * *`, "dailyDigest");
    return { ok: true };
  }

  /** Called by the scheduler. Sends through the user's opted-in channels (see alerts.ts). */
  async dailyDigest() {
    if (!this.state.digest.optin) return;
    const { digestFor } = await import("./alerts");
    await digestFor(this.env, this.name, this.state.profile, this.state.shown);
    this.setState({ ...this.state, digest: { ...this.state.digest, lastSent: Date.now() } });
  }

  /** "Delete my data": wipe all storage of this DO. */
  async wipe() {
    for (const s of this.getSchedules()) await this.cancelSchedule(s.id);
    await this.destroy();
    return { ok: true };
  }

  private history(): ChatMessage[] {
    this.ensureTables();
    const rows = this.sql<{
      role: string;
      content: string;
    }>`SELECT role, content FROM messages ORDER BY id DESC LIMIT ${KEEP_MESSAGES}`;
    return rows.reverse().map((r) => ({ role: r.role as "user" | "assistant", content: r.content }));
  }

  private remember(role: "user" | "assistant", content: string) {
    this.sql`INSERT INTO messages (ts, role, content) VALUES (${Date.now()}, ${role}, ${content.slice(0, 4000)})`;
    const n = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM messages`[0]?.n ?? 0;
    if (n > KEEP_MESSAGES * 2) {
      // fold the oldest messages into the rolling summary (cheap, deterministic: no extra LLM call)
      const old = this.sql<{
        id: number;
        role: string;
        content: string;
      }>`SELECT id, role, content FROM messages ORDER BY id ASC LIMIT ${n - KEEP_MESSAGES}`;
      const gist = old
        .filter((m) => m.role === "user")
        .map((m) => `- user asked: ${m.content.slice(0, 160)}`)
        .join("\n");
      const summary = `${this.state.summary}\n${gist}`.split("\n").slice(-20).join("\n").trim();
      const maxId = old[old.length - 1]?.id ?? 0;
      this.sql`DELETE FROM messages WHERE id <= ${maxId}`;
      this.setState({ ...this.state, summary });
    }
  }

  async chat(message: string, opts: { byok?: Byok | null; dailyCap?: number } = {}): Promise<ChatReply> {
    this.ensureTables();
    let st = this.state;
    if (st.day !== today()) st = { ...st, day: today(), chatsToday: 0 };
    const cap = opts.dailyCap ?? Number(this.env.CHAT_DAILY_CAP ?? 40);
    const empty = { violations_first: 0, regenerated: false, trimmed: false };
    if (!opts.byok && st.chatsToday >= cap) {
      return {
        reply: "You've reached today's chat limit. It resets at 00:00 UTC — browsing, search and alerts keep working.",
        programs: [],
        quotes: [],
        tools: [],
        limited: true,
        grounding: empty,
        usage: { usd: 0, input: 0, output: 0 },
      };
    }
    this.setState({ ...st, chatsToday: st.chatsToday + 1 });

    const ctx: ToolCtx = {
      env: this.env,
      profile: this.state.profile,
      shown: new Set(this.state.shown),
      seen: new Map(),
      quotes: new Map(),
      onProfile: async (p) => {
        this.setState({ ...this.state, profile: sanitizeProfile(p) });
      },
      onFeedback: async (id, action, reason) => {
        await this.feedback(id, action, reason);
        ctx.profile = this.state.profile;
      },
    };
    const sys = `${SYSTEM}\n\nHunter profile (JSON): ${JSON.stringify({ ...ctx.profile, saved: ctx.profile.saved?.slice(-20), dismissed: ctx.profile.dismissed?.slice(-20) })}\nEarlier in this conversation:\n${this.state.summary || "(nothing yet)"}\nToday is ${today()}.`;
    const messages: ChatMessage[] = [
      { role: "system", content: sys },
      ...this.history(),
      { role: "user", content: message.slice(0, 2000) },
    ];
    const tools = [...toolDefs(TOOLS), FINAL];
    const used: string[] = [];
    const usage = { usd: 0, input: 0, output: 0 };
    let final: FinalAnswer | null = null;
    let model = "";
    let tier = "";
    try {
      for (let round = 0; round < MAX_ROUNDS && !final; round++) {
        const last = round === MAX_ROUNDS - 1;
        const r = await chat(this.env, messages, {
          tools: last ? [FINAL] : tools,
          toolChoice: last ? { type: "function", function: { name: "final_answer" } } : "required",
          effort: "high",
          maxTokens: 2000,
          noLog: true,
          byok: opts.byok,
        });
        model = r.model;
        tier = r.tier;
        usage.usd += r.usage.usd;
        usage.input += r.usage.input;
        usage.output += r.usage.output;
        if (!r.tool_calls.length) {
          // model answered in prose: treat as a final answer without claims (grounding still applies)
          final = { reply: r.content || "Sorry, I couldn't produce an answer.", programs: [], rule_claims: [] };
          break;
        }
        messages.push({ role: "assistant", content: r.content ?? "", tool_calls: r.tool_calls });
        for (const call of r.tool_calls) {
          let args: unknown = {};
          try {
            args = JSON.parse(call.function.arguments || "{}");
          } catch {
            args = null;
          }
          if (call.function.name === "final_answer") {
            const f = FinalSchema.safeParse(args);
            if (f.success) final = f.data;
            else
              messages.push({
                role: "tool",
                tool_call_id: call.id,
                content: `final_answer invalid: ${f.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}. Call it again.`,
              });
            continue;
          }
          used.push(call.function.name);
          let out: string;
          try {
            const res = await runTool(call.function.name as ToolName, args, ctx);
            out = JSON.stringify(res).slice(0, 12000);
          } catch (e) {
            out = JSON.stringify({ error: e instanceof ToolError ? e.message : "tool failed" });
            if (!(e instanceof ToolError)) console.error("tool error", call.function.name, String(e).slice(0, 200));
          }
          messages.push({ role: "tool", tool_call_id: call.id, content: out });
        }
        if (final)
          messages.push({
            role: "tool",
            tool_call_id: r.tool_calls.find((c) => c.function.name === "final_answer")?.id ?? "final",
            content: "ok",
          });
      }
    } catch (e) {
      if (e instanceof LimitReached) {
        return {
          reply:
            "Quarry has hit today's AI budget, so chat is paused until 00:00 UTC. Search, program pages and alerts still work. (Heavy user? You can bring your own API key in settings.)",
          programs: [],
          quotes: [],
          tools: used,
          limited: true,
          grounding: empty,
          usage,
        };
      }
      if (e instanceof Unavailable)
        return { reply: e.message, programs: [], quotes: [], tools: used, grounding: empty, usage };
      throw e;
    }
    if (!final) final = { reply: "Sorry, I couldn't finish that. Try rephrasing.", programs: [], rule_claims: [] };

    // ---- grounding: check, regenerate once, then trim ----
    const gctx = { seen: ctx.seen, policyText: (id: string) => this.policyText(id) };
    let v: Violation[] = await check(final, gctx);
    const grounding = { violations_first: v.length, regenerated: false, trimmed: false };
    if (v.length) {
      grounding.regenerated = true;
      messages.push({
        role: "user",
        content: `Your final_answer failed Quarry's grounding checks:\n${v.map((x) => `- ${x.kind}: ${x.detail}`).join("\n")}\nCall final_answer again: only name open programs returned by tools (list their ids), and give every stated rule a verbatim quote from the tool results, or remove it.`,
      });
      try {
        const r = await chat(this.env, messages, {
          tools: [FINAL],
          toolChoice: { type: "function", function: { name: "final_answer" } },
          effort: "high",
          maxTokens: 1500,
          noLog: true,
          byok: opts.byok,
        });
        usage.usd += r.usage.usd;
        const call = r.tool_calls.find((c) => c.function.name === "final_answer");
        const f = call ? FinalSchema.safeParse(safeJson(call.function.arguments)) : null;
        if (f?.success) {
          final = f.data;
          v = await check(final, gctx);
        }
      } catch (e) {
        if (!(e instanceof LimitReached || e instanceof Unavailable)) throw e;
      }
      if (v.length) {
        final = trim(final, v);
        grounding.trimmed = true;
      }
    }

    const shown = [...new Set([...this.state.shown, ...final.programs])].slice(-300);
    this.setState({ ...this.state, shown });
    this.remember("user", message);
    this.remember("assistant", final.reply);
    return {
      reply: final.reply,
      programs: final.programs,
      quotes: final.rule_claims,
      tools: used,
      model,
      tier,
      grounding,
      usage,
    };
  }

  private async policyText(id: string): Promise<string | null> {
    const r = await this.env.DB.prepare("SELECT text FROM policies WHERE program_id = ?1")
      .bind(id)
      .first<{ text: string }>();
    return r?.text ?? null;
  }

  /** For evals/tests: verify program ids exist. */
  async exists(ids: string[]) {
    const m = await programsByIds(this.env, ids);
    return ids.map((id) => ({ id, exists: m.has(id), live: !!m.get(id)?.live }));
  }
}

function safeJson(s: string) {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return null;
  }
}

const ProfileSchema = z
  .object({
    skills: z.array(z.string().max(40)).max(20).optional(),
    assets: z.array(z.string().max(20)).max(15).optional(),
    platforms: z.array(z.string().max(20)).max(15).optional(),
    min_bounty: z.number().min(0).max(10_000_000).optional(),
    vdp_ok: z.boolean().optional(),
    exclude: z.array(z.string().max(20)).max(15).optional(),
    exclude_platforms: z.array(z.string().max(20)).max(15).optional(),
    hours_per_week: z.number().min(0).max(168).optional(),
    hard: z.array(z.string().max(20)).max(6).optional(),
    saved: z.array(z.string().max(200)).max(300).optional(),
    dismissed: z
      .array(z.object({ id: z.string().max(200), reason: z.string().max(40).optional(), ts: z.number().optional() }))
      .max(300)
      .optional(),
  })
  .strip();

export function sanitizeProfile(p: unknown): Profile {
  const r = ProfileSchema.safeParse(p ?? {});
  return r.success ? r.data : {};
}
