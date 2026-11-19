import { describe, expect, it } from "vitest";
import { check, norm, quoteIn, trim } from "../src/grounding";

const policy =
  "## Policy\n\nPlease do **not** use automated scanners.\n\n## Safe harbor\n\nWe will not take legal action.";
const seen = new Map([
  ["h1:a", { name: "Acme Corp", live: true }],
  ["h1:b", { name: "Beta Closed", live: false }],
  ["bugcrowd:c", { name: "Gamma", live: true }],
]);
const ctx = {
  seen,
  policyText: async (id: string) => (id === "h1:a" ? policy : null),
  hardCheck: async (id: string) => (id === "bugcrowd:c" ? "not on your platforms" : null),
};

describe("grounding", () => {
  it("accepts a grounded answer", async () => {
    const v = await check(
      {
        reply: "Try Acme Corp. Its policy says scanners are not allowed.",
        programs: ["h1:a"],
        rule_claims: [{ program: "h1:a", field: "scanning", quote: "Please do not use automated scanners." }],
      },
      ctx,
    );
    expect(v).toEqual([]);
  });
  it("flags unknown, closed and hard-constraint programs, fabricated quotes, unlisted names", async () => {
    const v = await check(
      {
        reply: "Try Beta Closed and Gamma, also Acme Corp.",
        programs: ["h1:zzz", "h1:b", "bugcrowd:c"],
        rule_claims: [{ program: "h1:a", field: "scanning", quote: "Automated scanning is welcome here." }],
      },
      ctx,
    );
    const kinds = v.map((x) => x.kind).sort();
    expect(kinds).toEqual([
      "closed_program",
      "hard_constraint",
      "quote_not_in_policy",
      "unknown_program",
      "unlisted_name",
    ]);
  });
  it("flags rule statements without quotes", async () => {
    const v = await check({ reply: "Acme Corp allows automated scanning.", programs: ["h1:a"], rule_claims: [] }, ctx);
    expect(v.map((x) => x.kind)).toEqual(["unquoted_rule"]);
  });
  it("trims offending sentences and ids", async () => {
    const a = { reply: "Gamma is great. Acme Corp is open.", programs: ["h1:a", "bugcrowd:c"], rule_claims: [] };
    const t = trim(a, await check(a, ctx));
    expect(t.programs).toEqual(["h1:a"]);
    expect(t.reply).toBe("Acme Corp is open.");
  });
  it("quote matching ignores markdown and smart quotes, needs real text", () => {
    expect(quoteIn("Please do not use automated scanners", norm(policy))).toBe(true);
    expect(quoteIn("scanners", norm(policy))).toBe(true);
    expect(quoteIn("ok", norm(policy))).toBe(false);
  });
});
