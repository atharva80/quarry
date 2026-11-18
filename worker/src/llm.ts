/**
 * LLM access for the Worker: one OpenAI-style chat interface over
 *   1. a bring-your-own-key provider (fixed allowlist, key only in this request's header), or
 *   2. the primary provider (LLM_BASE_URL/LLM_MODEL/LLM_API_STYLE + secret LLM_API_KEY), routed through
 *      AI Gateway "quarry" (custom provider) when LLM_GATEWAY_PROVIDER is set, else called directly, then
 *   3. the Workers AI fallback model (Free-plan model), then
 *   4. "unavailable".
 * Spend is reserved/committed in the Budget DO (global daily USD + neuron caps).
 */
import type { z } from "zod";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
export interface ChatResult {
  content: string;
  tool_calls: ToolCall[];
  model: string;
  tier: "byok" | "primary" | "fallback";
  usage: { input: number; output: number; usd: number; neurons: number };
}
export interface ChatOptions {
  tools?: ToolDef[];
  toolChoice?: "auto" | "required" | { type: "function"; function: { name: string } };
  effort?: "none" | "low" | "high" | "max";
  maxTokens?: number;
  /** user chat: never let AI Gateway store prompts/responses */
  noLog?: boolean;
  byok?: Byok | null;
}

export class LimitReached extends Error {}
export class Unavailable extends Error {}

/** BYOK providers: fixed hosts only (an arbitrary base URL would be an SSRF hole). */
export const BYOK_PROVIDERS: Record<string, { base: string; style: "chat" | "anthropic"; model: string }> = {
  anthropic: { base: "https://api.anthropic.com/v1", style: "anthropic", model: "claude-haiku-5-5" },
  openai: { base: "https://api.openai.com/v1", style: "chat", model: "gpt-5-mini" },
  fireworks: {
    base: "https://api.fireworks.ai/inference/v1",
    style: "chat",
    model: "accounts/fireworks/models/deepseek-v4p1-flash-1017",
  },
  deepseek: { base: "https://api.deepseek.com/v1", style: "chat", model: "deepseek-chat" },
  groq: { base: "https://api.groq.com/openai/v1", style: "chat", model: "openai/gpt-oss-120b" },
  openrouter: { base: "https://openrouter.ai/api/v1", style: "chat", model: "deepseek/deepseek-v4.1-flash" },
};
export interface Byok {
  provider: keyof typeof BYOK_PROVIDERS;
  key: string;
  model?: string;
}

/** Reads BYOK headers. The key is never stored, logged, or put into model context. */
export function readByok(req: Request): Byok | null {
  const provider = req.headers.get("x-quarry-byok-provider") ?? "";
  const key = req.headers.get("x-quarry-byok-key") ?? "";
  if (!provider || !key) return null;
  if (!(provider in BYOK_PROVIDERS)) throw new Error("unsupported BYOK provider");
  if (key.length > 400 || /\s/.test(key)) throw new Error("invalid BYOK key");
  const model = req.headers.get("x-quarry-byok-model") ?? undefined;
  if (model && !/^[\w./:-]{1,120}$/.test(model)) throw new Error("invalid BYOK model");
  return { provider: provider as Byok["provider"], key, model };
}

function scrub(msg: string, secrets: (string | undefined)[]): string {
  let m = msg;
  for (const s of secrets) if (s && s.length > 6) m = m.split(s).join("[redacted]");
  return m.slice(0, 300);
}

async function budget(env: Env) {
  return env.BUDGET.get(env.BUDGET.idFromName("global"));
}

function price(env: Env, tier: "primary" | "fallback") {
  if (tier === "primary") return { in: Number(env.LLM_PRICE_IN ?? 0.3), out: Number(env.LLM_PRICE_OUT ?? 1.2) };
  return { in: Number(env.FALLBACK_PRICE_IN ?? 0.1), out: Number(env.FALLBACK_PRICE_OUT ?? 0.3) };
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs = 60000) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (r.status === 429 || r.status >= 500) {
      const ra = Number(r.headers.get("retry-after"));
      await new Promise((res) => setTimeout(res, Math.min(4000, (ra > 0 ? ra * 1000 : 0) || 500 * 2 ** attempt)));
      continue;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return (await r.json()) as Record<string, unknown>;
  }
  throw new Error("retries exhausted");
}

// biome-ignore lint/suspicious/noExplicitAny: provider payloads
function parseChat(data: any): { content: string; tool_calls: ToolCall[]; input: number; output: number } {
  const msg = data?.choices?.[0]?.message ?? {};
  return {
    content: typeof msg.content === "string" ? msg.content : "",
    tool_calls: (msg.tool_calls ?? []).filter((t: ToolCall) => t?.function?.name),
    input: Number(data?.usage?.prompt_tokens ?? 0),
    output: Number(data?.usage?.completion_tokens ?? 0),
  };
}

function toResponsesInput(messages: ChatMessage[]) {
  // OpenAI Responses API shape (LLM_API_STYLE=responses)
  // biome-ignore lint/suspicious/noExplicitAny: provider payloads
  const input: any[] = [];
  for (const m of messages) {
    if (m.role === "tool") input.push({ type: "function_call_output", call_id: m.tool_call_id, output: m.content });
    else if (m.tool_calls?.length)
      for (const t of m.tool_calls)
        input.push({ type: "function_call", call_id: t.id, name: t.function.name, arguments: t.function.arguments });
    else input.push({ role: m.role === "system" ? "developer" : m.role, content: m.content });
  }
  return input;
}

async function callPrimary(env: Env, messages: ChatMessage[], o: ChatOptions) {
  const style: string = env.LLM_API_STYLE ?? "chat";
  const model = env.LLM_MODEL;
  const headers: Record<string, string> = { authorization: `Bearer ${env.LLM_API_KEY}` };
  if (style === "responses") {
    const body = {
      model,
      input: toResponsesInput(messages),
      tools: o.tools?.map((t) => ({ type: "function", ...t.function })),
      tool_choice: !o.tools
        ? undefined
        : typeof o.toolChoice === "object"
          ? { type: "function", name: o.toolChoice.function.name }
          : (o.toolChoice ?? "auto"),
      reasoning: { effort: o.effort === "none" ? "low" : (o.effort ?? "low") },
      max_output_tokens: o.maxTokens ?? 1500,
    };
    let data: Record<string, unknown>;
    if (env.LLM_GATEWAY_PROVIDER) {
      const gwHeaders: Record<string, string> = { ...headers, "content-type": "application/json" };
      if (o.noLog) gwHeaders["cf-aig-collect-log"] = "false";
      const res = await env.AI.gateway(env.AI_GATEWAY_ID).run({
        provider: env.LLM_GATEWAY_PROVIDER,
        endpoint: "responses",
        headers: gwHeaders,
        query: body,
      });
      if (!res.ok) throw new Error(`gateway HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      data = (await res.json()) as Record<string, unknown>;
    } else data = await postJson(`${env.LLM_BASE_URL}/responses`, headers, body);
    // biome-ignore lint/suspicious/noExplicitAny: provider payloads
    const out = (data.output as any[]) ?? [];
    const tool_calls: ToolCall[] = out
      .filter((x) => x.type === "function_call")
      .map((x) => ({ id: x.call_id, type: "function", function: { name: x.name, arguments: x.arguments } }));
    const content = out
      .filter((x) => x.type === "message")
      .flatMap((x) => x.content ?? [])
      .map((c: { text?: string }) => c.text ?? "")
      .join("");
    // biome-ignore lint/suspicious/noExplicitAny: provider payloads
    const u = data.usage as any;
    return { content, tool_calls, input: Number(u?.input_tokens ?? 0), output: Number(u?.output_tokens ?? 0) };
  }
  const body = {
    model,
    messages,
    tools: o.tools,
    tool_choice: o.tools ? (o.toolChoice ?? "auto") : undefined,
    reasoning_effort: o.effort ?? "low",
    max_tokens: o.maxTokens ?? 1500,
    temperature: 0.2,
  };
  if (env.LLM_GATEWAY_PROVIDER) {
    const gwHeaders: Record<string, string> = { ...headers, "content-type": "application/json" };
    if (o.noLog) gwHeaders["cf-aig-collect-log"] = "false";
    const res = await env.AI.gateway(env.AI_GATEWAY_ID).run({
      provider: env.LLM_GATEWAY_PROVIDER,
      endpoint: "chat/completions",
      headers: gwHeaders,
      query: body,
    });
    if (!res.ok) throw new Error(`gateway HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return parseChat(await res.json());
  }
  return parseChat(await postJson(`${env.LLM_BASE_URL}/chat/completions`, headers, body));
}

async function callFallback(env: Env, messages: ChatMessage[], o: ChatOptions) {
  const opts = o.noLog
    ? { gateway: { id: env.AI_GATEWAY_ID, collectLog: false } }
    : { gateway: { id: env.AI_GATEWAY_ID } };
  // biome-ignore lint/suspicious/noExplicitAny: model typings lag the catalog
  const data: any = await env.AI.run(
    env.FALLBACK_MODEL as any,
    {
      messages,
      tools: o.tools,
      tool_choice: o.tools ? (o.toolChoice ?? "auto") : undefined,
      max_completion_tokens: o.maxTokens ?? 1500,
      temperature: 0.2,
    } as any,
    opts as any,
  );
  const parsed = parseChat(data);
  return { ...parsed, neurons: Number(data?.usage?.neurons ?? 0) };
}

async function callByok(b: Byok, messages: ChatMessage[], o: ChatOptions) {
  const p = BYOK_PROVIDERS[b.provider];
  const model = b.model ?? p.model;
  if (p.style === "anthropic") {
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    // biome-ignore lint/suspicious/noExplicitAny: provider payloads
    const msgs: any[] = [];
    for (const m of messages) {
      if (m.role === "system") continue;
      if (m.role === "tool")
        msgs.push({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content }],
        });
      else if (m.tool_calls?.length)
        msgs.push({
          role: "assistant",
          content: [
            ...(m.content ? [{ type: "text", text: m.content }] : []),
            ...m.tool_calls.map((t) => ({
              type: "tool_use",
              id: t.id,
              name: t.function.name,
              input: JSON.parse(t.function.arguments || "{}"),
            })),
          ],
        });
      else msgs.push({ role: m.role, content: m.content });
    }
    const tc = o.toolChoice;
    const data = await postJson(
      `${p.base}/messages`,
      { "x-api-key": b.key, "anthropic-version": "2023-06-01" },
      {
        model,
        system,
        messages: msgs,
        max_tokens: o.maxTokens ?? 1500,
        tools: o.tools?.map((t) => ({
          name: t.function.name,
          description: t.function.description,
          input_schema: t.function.parameters,
        })),
        tool_choice: !o.tools
          ? undefined
          : typeof tc === "object"
            ? { type: "tool", name: tc.function.name }
            : tc === "required"
              ? { type: "any" }
              : { type: "auto" },
      },
    );
    // biome-ignore lint/suspicious/noExplicitAny: provider payloads
    const blocks = (data.content as any[]) ?? [];
    // biome-ignore lint/suspicious/noExplicitAny: provider payloads
    const u = data.usage as any;
    return {
      content: blocks
        .filter((x) => x.type === "text")
        .map((x) => x.text)
        .join(""),
      tool_calls: blocks
        .filter((x) => x.type === "tool_use")
        .map((x) => ({
          id: x.id,
          type: "function" as const,
          function: { name: x.name, arguments: JSON.stringify(x.input ?? {}) },
        })),
      input: Number(u?.input_tokens ?? 0),
      output: Number(u?.output_tokens ?? 0),
    };
  }
  return parseChat(
    await postJson(
      `${p.base}/chat/completions`,
      { authorization: `Bearer ${b.key}` },
      {
        model,
        messages,
        tools: o.tools,
        tool_choice: o.tools ? (o.toolChoice ?? "auto") : undefined,
        max_tokens: o.maxTokens ?? 1500,
      },
    ),
  );
}

/** One chat call with the full fallback chain and budget accounting. */
export async function chat(env: Env, messages: ChatMessage[], o: ChatOptions = {}): Promise<ChatResult> {
  if (o.byok) {
    try {
      const r = await callByok(o.byok, messages, o);
      return {
        content: r.content,
        tool_calls: r.tool_calls,
        model: o.byok.model ?? BYOK_PROVIDERS[o.byok.provider].model,
        tier: "byok",
        usage: { input: r.input, output: r.output, usd: 0, neurons: 0 },
      };
    } catch (e) {
      // never echo the key; tell the user their provider failed
      throw new Unavailable(`your ${o.byok.provider} key failed: ${scrub(String(e), [o.byok.key])}`);
    }
  }
  const b = await budget(env);
  if (env.LLM_API_KEY && env.LLM_MODEL) {
    const ok = await b.reserve("primary", 0.002);
    if (ok) {
      try {
        const r = await callPrimary(env, messages, o);
        const pr = price(env, "primary");
        const usd = (r.input * pr.in + r.output * pr.out) / 1e6;
        await b.commit("primary", usd, 0);
        return {
          content: r.content,
          tool_calls: r.tool_calls,
          model: env.LLM_MODEL,
          tier: "primary",
          usage: { input: r.input, output: r.output, usd, neurons: 0 },
        };
      } catch (e) {
        await b.commit("primary", 0, 0);
        console.error("primary LLM failed", scrub(String(e), [env.LLM_API_KEY]));
      }
    }
  }
  if (await b.reserve("fallback", 0)) {
    try {
      const r = await callFallback(env, messages, o);
      const pr = price(env, "fallback");
      const usd = (r.input * pr.in + r.output * pr.out) / 1e6;
      await b.commit("fallback", usd, r.neurons || usd * 90909);
      return {
        content: r.content,
        tool_calls: r.tool_calls,
        model: env.FALLBACK_MODEL,
        tier: "fallback",
        usage: { input: r.input, output: r.output, usd, neurons: r.neurons },
      };
    } catch (e) {
      await b.commit("fallback", 0, 0);
      console.error("fallback LLM failed", String(e).slice(0, 200));
      throw new Unavailable("the assistant is temporarily unavailable");
    }
  }
  throw new LimitReached("daily limit reached");
}

/**
 * Structured output: force a tool call, validate its arguments with Zod, retry once with the validation error
 * fed back (the chain inside `chat` already falls back across providers). Never returns unvalidated data.
 */
export async function structured<T>(
  env: Env,
  messages: ChatMessage[],
  tool: ToolDef,
  schema: z.ZodType<T>,
  o: ChatOptions = {},
): Promise<{ value: T; result: ChatResult } | null> {
  let msgs = messages;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await chat(env, msgs, {
      ...o,
      tools: [tool],
      toolChoice: { type: "function", function: { name: tool.function.name } },
    });
    const call = result.tool_calls.find((t) => t.function.name === tool.function.name);
    let args: unknown = null;
    try {
      args = call ? JSON.parse(call.function.arguments || "{}") : null;
    } catch {
      args = null;
    }
    const parsed = schema.safeParse(args);
    if (parsed.success) return { value: parsed.data, result };
    const err = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ")
      .slice(0, 800);
    const id = call?.id ?? "call_0";
    msgs = [
      ...messages,
      {
        role: "assistant",
        content: "",
        tool_calls: [call ?? { id, type: "function", function: { name: tool.function.name, arguments: "{}" } }],
      },
      {
        role: "tool",
        tool_call_id: id,
        content: `Validation failed: ${err}. Call ${tool.function.name} again with valid arguments.`,
      },
    ];
  }
  return null;
}
