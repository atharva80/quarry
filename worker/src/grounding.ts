/**
 * Grounding rules for agent answers, enforced in code:
 *  1. every program the answer names must exist and be open (it must be listed in `programs`, and those ids
 *     must be ones a tool returned and that are accepting reports);
 *  2. every rule claim must carry a quote that appears verbatim in that program's stored policy text;
 *  3. sentences that state rules without a claim are violations.
 * A failing answer is regenerated once with the violations as feedback, then trimmed.
 */

export interface RuleClaim {
  program: string;
  field: string;
  quote: string;
}
export interface FinalAnswer {
  reply: string;
  programs: string[];
  rule_claims: RuleClaim[];
}
export interface Violation {
  kind: "unknown_program" | "closed_program" | "unquoted_rule" | "quote_not_in_policy" | "unlisted_name";
  detail: string;
  sentence?: string;
}

const TRANS: Record<string, string> = { "‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-", " ": " " };

export function norm(s: string): string {
  return (s ?? "")
    .normalize("NFKC")
    .replace(/[‘’“”–— ]/g, (c) => TRANS[c] ?? c)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(?:[-+]|\d+\.)\s+/gm, "")
    .replace(/[*_`\\]/g, "")
    .replace(/#+\s*/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function quoteIn(quote: string, policyNorm: string): boolean {
  const q = norm(quote).replace(/^[\s."'…]+|[\s."'…]+$/g, "");
  if (q.length < 8) return false;
  if (policyNorm.includes(q)) return true;
  const parts = q
    .split(/\.\.\.|…/)
    .map((p) => p.trim().replace(/^\.+|\.+$/g, ""))
    .filter((p) => p.length >= 8);
  return parts.length > 1 && parts.every((p) => policyNorm.includes(p));
}

const RULE_WORDS =
  /\b(scann(?:ing|er)s?|automated|automation|rate[- ]limit|requests? per (?:second|minute)|rps|user[- ]agent|header|safe[- ]harbou?r|out of scope|excluded?|not allowed|prohibit(?:ed|s)?|forbidden|permitted|allowed to|disclos(?:e|ure)|test accounts?)\b/i;

export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface GroundingCtx {
  /** program id -> {name, live} for everything tools returned this turn */
  seen: Map<string, { name: string; live: boolean }>;
  /** names of every known program that tools surfaced (lowercase) -> id */
  policyText: (id: string) => Promise<string | null>;
}

export async function check(a: FinalAnswer, ctx: GroundingCtx): Promise<Violation[]> {
  const v: Violation[] = [];
  for (const id of a.programs) {
    const s = ctx.seen.get(id);
    if (!s) v.push({ kind: "unknown_program", detail: `${id} was not returned by any tool this turn` });
    else if (!s.live) v.push({ kind: "closed_program", detail: `${s.name} (${id}) is not accepting reports` });
  }
  // names of programs tools surfaced that the reply mentions must be listed (and therefore open)
  const listed = new Set(a.programs);
  const replyL = a.reply.toLowerCase();
  for (const [id, s] of ctx.seen) {
    if (listed.has(id) || s.name.length < 4) continue;
    if (new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(s.name.toLowerCase())}([^\\p{L}\\p{N}]|$)`, "u").test(replyL)) {
      v.push({
        kind: s.live ? "unlisted_name" : "closed_program",
        detail: `mentions ${s.name} (${id}) without listing it${s.live ? "" : "; it is not accepting reports"}`,
        sentence: s.name,
      });
    }
  }
  // rule claims must be quoted verbatim from stored policy text
  const cache = new Map<string, string>();
  for (const c of a.rule_claims) {
    if (!cache.has(c.program)) cache.set(c.program, norm((await ctx.policyText(c.program)) ?? ""));
    const pol = cache.get(c.program) ?? "";
    if (!pol || !quoteIn(c.quote, pol))
      v.push({
        kind: "quote_not_in_policy",
        detail: `quote for ${c.program}.${c.field} is not in its stored policy`,
        sentence: c.quote,
      });
  }
  // rule-like sentences need at least one claim backing them
  if (!a.rule_claims.length) {
    for (const s of sentences(a.reply)) {
      if (RULE_WORDS.test(s) && a.programs.length) {
        v.push({ kind: "unquoted_rule", detail: "states a program rule without a policy quote", sentence: s });
      }
    }
  }
  return v;
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Last resort after one regeneration: drop offending sentences and claims, keep the rest. */
export function trim(a: FinalAnswer, v: Violation[]): FinalAnswer {
  const badIds = new Set(
    v
      .filter((x) => x.kind === "unknown_program" || x.kind === "closed_program")
      .map((x) => x.detail.match(/\(([^)]+)\)|^(\S+)/)?.[1] ?? x.detail.split(" ")[0]),
  );
  const badQuotes = new Set(v.filter((x) => x.kind === "quote_not_in_policy").map((x) => x.sentence));
  const badSentences = v.filter((x) => x.kind === "unquoted_rule").map((x) => x.sentence ?? "");
  const badNames = v
    .filter((x) => x.kind === "unlisted_name" || x.kind === "closed_program")
    .map((x) => (x.sentence ?? "").toLowerCase())
    .filter(Boolean);
  const kept = sentences(a.reply).filter(
    (s) => !badSentences.includes(s) && !badNames.some((n) => n && s.toLowerCase().includes(n)),
  );
  const reply = kept.join(" ").trim();
  return {
    reply:
      reply ||
      "I couldn't verify that answer against the programs' policies, so I've left it out. Try asking about a specific program.",
    programs: a.programs.filter((id) => !badIds.has(id)),
    rule_claims: a.rule_claims.filter((c) => !badQuotes.has(c.quote)),
  };
}
