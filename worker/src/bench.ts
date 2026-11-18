// M0 benchmarks (tests a and b). Removed after M0; results in docs/decisions.md.
import { Agent, getAgentByName } from "agents";
import dotWasm from "./dot.wasm";
import { type Matrix, parseMatrix, quantiseQuery, topK, WasmDots } from "./vectors";

let kernel: WasmDots | null = null;

let matrix: Matrix | null = null;

export async function benchVectors(env: Env, req: Request): Promise<Response> {
  if (!matrix) {
    const base = new URL(req.url).origin;
    const [bin, ids] = await Promise.all([
      env.ASSETS.fetch(`${base}/data/vectors.bin`).then((r) => r.arrayBuffer()),
      env.ASSETS.fetch(`${base}/data/vectors.ids.json`).then((r) => r.json() as Promise<string[]>),
    ]);
    matrix = parseMatrix(bin, ids);
  }
  const q = new Float32Array(matrix.d);
  for (let i = 0; i < q.length; i++) q[i] = Math.sin(i * 1.7 + Number(new URL(req.url).searchParams.get("s") || 1));
  const useWasm = new URL(req.url).searchParams.get("js") !== "1";
  if (useWasm && !kernel) kernel = new WasmDots(dotWasm);
  const res = topK(matrix, quantiseQuery(q), 30, undefined, useWasm ? (kernel ?? undefined) : undefined);
  return Response.json({ top: res.slice(0, 3) });
}

export class BenchAgent extends Agent<Env> {
  async turn(question: string) {
    const tools = [
      {
        type: "function",
        function: {
          name: "search_programs",
          description: "Search bug-bounty programs by keywords",
          parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
        },
      },
    ];
    const messages: { role: string; content: string; tool_call_id?: string; tool_calls?: unknown }[] = [
      { role: "system", content: "You help bug-bounty hunters. Use the tool to search, then answer in one sentence." },
      { role: "user", content: question },
    ];
    // biome-ignore lint/suspicious/noExplicitAny: bench
    const first: any = await env_ai(this.env).run("@cf/google/gemma-4-26b-a4b-it" as any, {
      messages,
      tools,
      reasoning_effort: "none",
      max_completion_tokens: 200,
    } as any);
    const call = first?.choices?.[0]?.message?.tool_calls?.[0];
    let toolResult = "[]";
    if (call) {
      const rows = await this.env.DB.prepare("SELECT id, name FROM programs_fts WHERE programs_fts MATCH ?1 LIMIT 5")
        .bind(JSON.parse(call.function.arguments || "{}").q?.replace(/[^\w\s]/g, " ") || "api")
        .all();
      toolResult = JSON.stringify(rows.results);
      messages.push({ role: "assistant", content: "", tool_calls: [call] });
      messages.push({ role: "tool", content: toolResult, tool_call_id: call.id });
    }
    // biome-ignore lint/suspicious/noExplicitAny: bench
    const second: any = await env_ai(this.env).run("@cf/google/gemma-4-26b-a4b-it" as any, {
      messages,
      reasoning_effort: "none",
      max_completion_tokens: 200,
    } as any);
    this.sql`CREATE TABLE IF NOT EXISTS turns (ts INTEGER, q TEXT)`;
    this.sql`INSERT INTO turns VALUES (${Date.now()}, ${question})`;
    return { tool: call?.function?.name ?? null, answer: second?.choices?.[0]?.message?.content ?? null, usage: [first?.usage, second?.usage] };
  }
}
function env_ai(env: Env) {
  return env.AI;
}

export async function benchAgent(env: Env, req: Request): Promise<Response> {
  const agent = await getAgentByName(env.BENCH_AGENT, "bench");
  const q = new URL(req.url).searchParams.get("q") || "Find GraphQL API programs on HackerOne";
  return Response.json(await agent.turn(q));
}
