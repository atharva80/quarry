import { describe, expect, it } from "vitest";
import { type CatalogProgram, excludedBy, rank, scoreProgram } from "../../ranking/score";

const base: CatalogProgram = {
  id: "h1:a", p: "h1", pn: "HackerOne", n: "A", s: "open", b: 1, c: 0, mx: "$5,000", usd: 5000, L: 0,
  cat: ["api", "web"], na: 5, n7: 0, n14: 0, n30: 0, w30: 0, age: 400,
};
const now = 1_795_000_000;

describe("personal score", () => {
  it("hard constraints filter", () => {
    expect(excludedBy({ ...base, s: "paused" }, {})).toBe("not accepting reports");
    expect(excludedBy({ ...base, p: "ywh" }, { platforms: ["h1"] })).toBe("not on your platforms");
    expect(excludedBy({ ...base, usd: 500 }, { min_bounty: 1000 })).toMatch(/below/);
    expect(excludedBy({ ...base, b: 0, usd: 0 }, { min_bounty: 1000, vdp_ok: true })).toMatch(/VDP/);
    expect(excludedBy({ ...base, cat: ["contract"] }, { exclude: ["contract"] })).toMatch(/only contract/);
    expect(excludedBy({ ...base, cat: ["contract", "web"] }, { exclude: ["contract"] })).toBeNull();
  });
  it("soft constraints only weigh when not hard", () => {
    expect(excludedBy({ ...base, p: "ywh" }, { platforms: ["h1"], hard: [] })).toBeNull();
  });
  it("fresh wildcard scope and fit raise the score, with reasons", () => {
    const prof = { skills: ["graphql"], assets: ["api"] };
    const stale = scoreProgram(base, prof, now);
    const fresh = scoreProgram({ ...base, n7: 3, n14: 3, n30: 3, w30: 1 }, prof, now);
    expect(fresh.score).toBeGreaterThan(stale.score);
    expect(fresh.reasons.join(" ")).toMatch(/3 new assets this week \(1 wildcard\)/);
    expect(fresh.reasons.join(" ")).toMatch(/fits your api/);
  });
  it("a 'not my stack' dismissal pushes similar programs down", () => {
    const other = { ...base, id: "h1:b" };
    const before = rank([base, other], {}, now).find((x) => x.id === "h1:b")?.score ?? 0;
    const after = rank([base, other], { dismissed: [{ id: "h1:a", reason: "not my stack" }] }, now).find((x) => x.id === "h1:b")?.score ?? 0;
    expect(after).toBeLessThan(before);
  });
});
