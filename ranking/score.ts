/**
 * Quarry's personal score: transparent, explainable, shared by the browser ("For you") and the Worker
 * (/api/search, agent tools). Hard constraints filter; soft preferences only weigh.
 * Every component is in [0, 1]; the score is their weighted sum (weights in ranking/weights.json).
 */
import weights from "./weights.json";

export interface CatalogProgram {
  id: string;
  path?: string;
  p: string;
  pn: string;
  n: string;
  u?: string;
  s: string;
  b: number;
  c: number;
  mx: string;
  usd: number;
  L: number;
  U?: number;
  cat: string[];
  t?: string[];
  na: number;
  np?: number;
  n7: number;
  n14: number;
  n30: number;
  w30: number;
  la?: number;
  sc?: string[];
  rules?: { scan?: string; rl?: string; hdr?: boolean } | null;
  age?: number;
}

export interface Dismissal {
  id: string;
  reason?: string;
  ts?: number;
}

export interface Profile {
  skills?: string[];
  assets?: string[];
  platforms?: string[];
  min_bounty?: number;
  vdp_ok?: boolean;
  exclude?: string[];
  exclude_platforms?: string[];
  hours_per_week?: number;
  hard?: string[];
  saved?: string[];
  dismissed?: Dismissal[];
}

export interface Scored {
  id: string;
  score: number;
  reasons: string[];
  parts: Record<string, number>;
}

/** Skills imply asset categories the hunter can work on. */
export const SKILL_CATS: Record<string, string[]> = {
  xss: ["web", "wildcard"],
  idor: ["web", "api"],
  ssrf: ["web", "api", "wildcard"],
  graphql: ["api"],
  auth: ["web", "api"],
  "business-logic": ["web", "api"],
  "mobile-reversing": ["android", "ios", "mobile"],
  "smart-contracts": ["contract"],
  "source-review": ["code"],
  recon: ["wildcard", "network"],
  cloud: ["network", "wildcard"],
  "ai-redteam": ["ai"],
  hardware: ["hardware"],
  desktop: ["desktop"],
};

const CROWDED: Record<string, number> = { h1: 0.75, bugcrowd: 0.8, intigriti: 0.9, ywh: 0.95 };
const DAY = 86400;

function isHard(profile: Profile, key: string): boolean {
  return (profile.hard ?? ["platforms", "min_bounty", "vdp_ok", "exclude"]).includes(key);
}

/** Why a program is filtered out by the profile's hard constraints, or null if it passes. */
export function excludedBy(p: CatalogProgram, profile: Profile): string | null {
  if (p.s !== "open") return "not accepting reports";
  if (profile.exclude_platforms?.includes(p.p)) return `platform ${p.pn} excluded`;
  if (isHard(profile, "platforms") && profile.platforms?.length && !profile.platforms.includes(p.p))
    return "not on your platforms";
  if (isHard(profile, "vdp_ok") && profile.vdp_ok === false && !p.b) return "VDP (no bounty)";
  const minB = profile.min_bounty ?? 0;
  if (isHard(profile, "min_bounty") && minB > 0 && !p.b) return "VDP (no bounty, below your minimum)";
  if (isHard(profile, "min_bounty") && minB > 0 && p.usd > 0 && p.usd < minB) return `max bounty below $${minB}`;
  if (isHard(profile, "exclude") && profile.exclude?.length) {
    const ex = new Set(profile.exclude);
    const huntable = p.cat.filter((c) => c !== "other" && !ex.has(c));
    if (p.cat.length && huntable.length === 0) return `only ${p.cat.join("/")} in scope`;
  }
  const d = profile.dismissed?.find((x) => x.id === p.id);
  if (d) return `dismissed${d.reason ? `: ${d.reason}` : ""}`;
  return null;
}

export function profileCats(profile: Profile): Set<string> {
  const s = new Set(profile.assets ?? []);
  for (const sk of profile.skills ?? []) for (const c of SKILL_CATS[sk] ?? []) s.add(c);
  if (s.has("mobile")) {
    s.add("android");
    s.add("ios");
  }
  if (s.has("web")) s.add("wildcard");
  return s;
}

export interface FeedbackPrefs {
  competitive: number;
  lowPay: number;
  stackPenalty: Map<string, number>;
}

/** Learned-from-feedback adjustments: dismiss reasons become soft preferences. */
export function feedbackPrefs(profile: Profile, byId?: Map<string, CatalogProgram>): FeedbackPrefs {
  let competitive = 0;
  let lowPay = 0;
  const stackPenalty = new Map<string, number>();
  for (const d of profile.dismissed ?? []) {
    const r = (d.reason ?? "").toLowerCase();
    if (r.includes("competitive")) competitive++;
    if (r.includes("pay")) lowPay++;
    if (r.includes("stack") && byId) {
      for (const c of byId.get(d.id)?.cat ?? []) stackPenalty.set(c, (stackPenalty.get(c) ?? 0) + 1);
    }
  }
  return { competitive, lowPay, stackPenalty };
}

export const fmtUsd = (n: number) => (n >= 1000 ? `$${Math.round(n / 100) / 10}k`.replace(".0k", "k") : `$${n}`);

export function scoreProgram(
  p: CatalogProgram,
  profile: Profile,
  now: number,
  ctx?: { prefs?: FeedbackPrefs; savedCats?: Set<string> },
): Scored {
  const want = profileCats(profile);
  const prefs = ctx?.prefs ?? feedbackPrefs(profile);
  const reasons: string[] = [];

  // fit: share of the program's huntable categories the hunter works on (no profile = neutral 0.5)
  const progCats = p.cat.filter((c) => c !== "other");
  let fit = 0.5;
  if (want.size && progCats.length) {
    const hit = progCats.filter((c) => want.has(c));
    fit = hit.length / progCats.length;
    if (hit.length) reasons.push(`fits your ${hit.slice(0, 2).join(" + ")} skills`);
  }
  for (const c of progCats) fit -= 0.15 * Math.min(2, prefs.stackPenalty.get(c) ?? 0);
  fit = Math.max(0, Math.min(1, fit));

  // freshness: recently added scope, wildcards weigh more
  const fresh = p.n7 + 0.5 * Math.max(0, p.n14 - p.n7) + 0.25 * Math.max(0, p.n30 - p.n14) + 1.5 * p.w30;
  const freshness = 1 - Math.exp(-fresh / 3);
  if (p.n7 > 0) reasons.push(`${p.n7} new asset${p.n7 > 1 ? "s" : ""} this week${p.w30 ? ` (${p.w30} wildcard)` : ""}`);
  else if (p.n30 > 0) reasons.push(`${p.n30} asset${p.n30 > 1 ? "s" : ""} added in 30 days`);

  // payout: log scale, $100 -> 0.33, $10k -> 0.67, $1M -> 1
  let payout = p.b ? (p.usd > 0 ? Math.min(1, Math.log10(Math.max(p.usd, 10)) / 6) : 0.3) : 0.05;
  const minB = profile.min_bounty ?? 0;
  if (minB > 0 && p.usd > 0 && p.usd < minB) payout *= 0.3; // soft min-bounty when it isn't a hard filter
  if (prefs.lowPay) payout = payout ** (1 + 0.3 * prefs.lowPay);
  if (p.b && p.usd) reasons.push(`max ${fmtUsd(p.usd)}`);
  else if (!p.b) reasons.push("VDP, no bounty");

  // competition proxy: newer programs and less-crowded platforms are less picked over
  const age = p.age ?? (p.L ? (now - p.L) / DAY : 365);
  const platformRoom = CROWDED[p.p] !== undefined ? 1 - CROWDED[p.p] : 0.5; // 0.05 .. 0.5
  let competition = 0.7 * Math.exp(-age / 240) + 0.3 * (platformRoom / 0.5);
  if (prefs.competitive) competition *= 1 + 0.25 * prefs.competitive;
  competition = Math.min(1, competition);
  if (age < 30) reasons.push(`listed ${Math.max(1, Math.round(age))} days ago`);

  // rules: automation-friendly programs suit recon-heavy hunters
  let rules = 0.5;
  if (p.rules?.scan === "yes") {
    rules = 1;
    reasons.push("scanning allowed");
  } else if (p.rules?.scan === "limited") {
    rules = 0.7;
    reasons.push(`limited scanning${p.rules.rl ? ` (${p.rules.rl})` : ""}`);
  } else if (p.rules?.scan === "no") {
    rules = want.has("wildcard") || (profile.skills ?? []).includes("recon") ? 0.1 : 0.4;
    reasons.push("no automated scanning");
  }

  // similarity to saved programs (category overlap)
  let saved = 0;
  if (ctx?.savedCats?.size && progCats.length)
    saved = progCats.filter((c) => ctx.savedCats?.has(c)).length / progCats.length;

  const parts = { fit, freshness, payout, competition, rules, saved_similar: saved };
  const score =
    weights.fit * fit +
    weights.freshness * freshness +
    weights.payout * payout +
    weights.competition * competition +
    weights.rules * rules +
    weights.saved_similar * saved;
  return { id: p.id, score: Math.round(score * 1000) / 1000, reasons, parts };
}

/** Rank a catalog for a profile: hard filters first, then the weighted score. */
export function rank(programs: CatalogProgram[], profile: Profile, now: number, k = 50): Scored[] {
  const byId = new Map(programs.map((p) => [p.id, p]));
  const prefs = feedbackPrefs(profile, byId);
  const savedCats = new Set<string>();
  for (const id of profile.saved ?? []) for (const c of byId.get(id)?.cat ?? []) savedCats.add(c);
  const out: Scored[] = [];
  for (const p of programs) {
    if (excludedBy(p, profile)) continue;
    if (profile.saved?.includes(p.id)) continue;
    out.push(scoreProgram(p, profile, now, { prefs, savedCats }));
  }
  out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return out.slice(0, k);
}
