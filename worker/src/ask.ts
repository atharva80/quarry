/**
 * "Ask about this program": answer only from the program's stored policy text, with verbatim quotes.
 * Retrieval: split the policy into its "## " sections (+ paragraphs for long ones), rerank chunks against the
 * question with bge-reranker, give the model the top chunks as delimited untrusted data, force a structured
 * answer, then check every quote against the policy. If the policy doesn't say, the answer says so.
 */
import { z } from "zod";
import ASK from "../../prompts/ask_policy.md";
import { norm, quoteIn } from "./grounding";
import { type Byok, LimitReached, structured, Unavailable } from "./llm";
import { RERANK_MODEL } from "./search";

const AnswerSchema = z.object({
  status: z.enum(["answered", "not_in_policy"]),
  answer: z.string().min(1).max(2000),
  quotes: z
    .array(z.object({ text: z.string().min(1).max(600), section: z.string().max(200).default("") }))
    .max(5)
    .default([]),
});

const TOOL = {
  type: "function" as const,
  function: {
    name: "policy_answer",
    description: "Answer the question from the policy excerpts only.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["status", "answer", "quotes"],
      properties: {
        status: { type: "string", enum: ["answered", "not_in_policy"] },
        answer: { type: "string" },
        quotes: {
          type: "array",
          maxItems: 5,
          items: {
            type: "object",
            required: ["text", "section"],
            properties: { text: { type: "string" }, section: { type: "string" } },
          },
        },
      },
    },
  },
};

export interface Chunk {
  section: string;
  text: string;
}

export function chunkPolicy(text: string, max = 1500): Chunk[] {
  const out: Chunk[] = [];
  let section = "Policy";
  let buf: string[] = [];
  const flush = () => {
    const body = buf.join("\n").trim();
    buf = [];
    if (!body) return;
    if (body.length <= max) out.push({ section, text: body });
    else {
      let cur = "";
      for (const para of body.split(/\n{2,}/)) {
        if (cur && cur.length + para.length > max) {
          out.push({ section, text: cur.trim() });
          cur = "";
        }
        cur += `${para}\n\n`;
      }
      if (cur.trim()) out.push({ section, text: cur.trim().slice(0, max * 2) });
    }
  };
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) {
      flush();
      section = line.slice(3).trim();
    } else buf.push(line);
  }
  flush();
  return out;
}

export async function askPolicy(env: Env, programId: string, question: string, byok?: Byok | null) {
  const row = await env.DB.prepare(
    "SELECT p.name, p.platform, pol.text, pol.source_url FROM programs p LEFT JOIN policies pol ON pol.program_id = p.id WHERE p.id = ?1",
  )
    .bind(programId)
    .first<{ name: string; platform: string; text: string | null; source_url: string | null }>();
  if (!row) return { status: "unavailable" as const, answer: "Unknown program.", quotes: [] };
  if (!row.text)
    return {
      status: "unavailable" as const,
      answer: "Quarry doesn't have this program's policy yet. Read it on the platform.",
      quotes: [],
      source: null,
    };
  const q = question.trim().slice(0, 500);
  let chunks = chunkPolicy(row.text);
  if (chunks.length > 6) {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: model typings lag the catalog
      const rr: any = await env.AI.run(
        RERANK_MODEL as any,
        {
          query: q,
          contexts: chunks.slice(0, 60).map((c) => ({ text: `${c.section}: ${c.text.slice(0, 1200)}` })),
          top_k: 6,
        } as any,
      );
      const ids: number[] = (rr?.response ?? [])
        .sort((a: { score: number }, b: { score: number }) => b.score - a.score)
        .map((x: { id: number }) => x.id);
      if (ids.length)
        chunks = ids
          .slice(0, 6)
          .map((i) => chunks[i])
          .filter(Boolean);
      else chunks = chunks.slice(0, 6);
    } catch {
      chunks = chunks.slice(0, 6);
    }
  }
  const excerpts = chunks
    .map((c, i) => `<excerpt n="${i + 1}" section="${c.section.replace(/"/g, "'")}">\n${c.text}\n</excerpt>`)
    .join("\n");
  try {
    const res = await structured(
      env,
      [
        { role: "system", content: ASK },
        {
          role: "user",
          content: `Program: ${row.name}\nQuestion: ${q}\n\n<policy_excerpts>\n${excerpts}\n</policy_excerpts>`,
        },
      ],
      TOOL,
      AnswerSchema,
      { effort: "low", maxTokens: 800, noLog: true, byok },
    );
    if (!res)
      return {
        status: "unavailable" as const,
        answer: "Couldn't produce a valid answer. Read the policy directly.",
        quotes: [],
        source: row.source_url,
      };
    const pol = norm(row.text);
    const quotes = res.value.quotes.filter((x) => quoteIn(x.text, pol));
    const dropped = res.value.quotes.length - quotes.length;
    let { status, answer } = res.value;
    if (status === "answered" && quotes.length === 0) {
      // an answer with no verifiable quote is not grounded: say what we can
      status = "not_in_policy";
      answer =
        "I couldn't find a passage in the stored policy that answers this. The policy may not say — check it on the platform.";
    }
    return { status, answer, quotes, dropped_quotes: dropped, source: row.source_url, model: res.result.model };
  } catch (e) {
    if (e instanceof LimitReached)
      return {
        status: "unavailable" as const,
        answer: "Daily AI limit reached; try again after 00:00 UTC.",
        quotes: [],
        limited: true,
      };
    if (e instanceof Unavailable) return { status: "unavailable" as const, answer: e.message, quotes: [] };
    throw e;
  }
}
