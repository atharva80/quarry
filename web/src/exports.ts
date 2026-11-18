/** Scope export formats, generated entirely in the browser from a program's asset list. */

export interface Asset {
  i: string;
  t?: string;
  c: string;
  in: boolean;
  paid?: boolean;
  tier?: string;
  at?: number;
}

const NON_HOST = new Set(["android", "ios", "mobile", "contract", "code", "hardware", "desktop"]);
const HOST_RE = /^(\*\.)*(?:[a-z0-9*_-]+\.)*[a-z0-9*_-]+(?:\.[a-z*]{2,})$|^\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?$/i;

/** Hostname (possibly with * wildcards) from an identifier, or null if it is not host-shaped. */
export function hostOf(a: Asset): string | null {
  if (NON_HOST.has(a.c)) return null;
  let s = a.i.trim();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  s = s.split(/[/?#]/)[0] ?? "";
  s = s.replace(/:\d+$/, "");
  s = s.replace(/^[^@]*@/, "").toLowerCase();
  return HOST_RE.test(s) ? s : null;
}

const isWild = (h: string) => h.includes("*");
const uniq = (xs: string[]) => [...new Set(xs)];
const esc = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/** Regex for a host in Burp's advanced scope. A leading "*." also matches the bare root. */
export function hostRegex(h: string): string {
  let body: string;
  if (h.startsWith("*.")) body = `(.*\\.)?${esc(h.slice(2)).replace(/\*/g, ".*")}`;
  else body = esc(h).replace(/\*/g, ".*");
  return `^${body}$`;
}

export function plainTargets(assets: Asset[]): string {
  return uniq(assets.filter((a) => a.in && !NON_HOST.has(a.c)).map((a) => a.i.trim())).join("\n");
}

export function wildcardRoots(assets: Asset[]): string {
  const out: string[] = [];
  for (const a of assets) {
    if (!a.in) continue;
    const h = hostOf(a);
    if (h?.startsWith("*.")) out.push(h.slice(2));
  }
  return uniq(out).join("\n");
}

export function burpJson(assets: Asset[]): string {
  const rule = (h: string) => ({ enabled: true, host: hostRegex(h), protocol: "any" });
  const inc = uniq(assets.filter((a) => a.in).flatMap((a) => hostOf(a) ?? [])).map(rule);
  const exc = uniq(assets.filter((a) => !a.in).flatMap((a) => hostOf(a) ?? [])).map(rule);
  return JSON.stringify({ target: { scope: { advanced_mode: true, include: inc, exclude: exc } } }, null, 2);
}

function globs(assets: Asset[], inScope: boolean): string[] {
  const out: string[] = [];
  for (const a of assets) {
    if (a.in !== inScope) continue;
    const h = hostOf(a);
    if (!h) continue;
    out.push(h);
    if (h.startsWith("*.") && !h.slice(2).includes("*")) out.push(h.slice(2));
  }
  return uniq(out);
}

export function caidoJson(assets: Asset[]): string {
  return JSON.stringify({ allowlist: globs(assets, true), denylist: globs(assets, false) }, null, 2);
}

/** One URL or host per line; wildcards cannot be expanded by nuclei so they are left out. */
export function nucleiTargets(assets: Asset[]): string {
  const out: string[] = [];
  for (const a of assets) {
    if (!a.in || NON_HOST.has(a.c)) continue;
    const h = hostOf(a);
    if (!h || isWild(h) || isWild(a.i)) continue;
    out.push(/^https?:\/\//i.test(a.i.trim()) ? a.i.trim() : h);
  }
  return uniq(out).join("\n");
}
