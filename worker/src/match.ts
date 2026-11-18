/**
 * Scope check: which of these hosts (e.g. subfinder output) are in a program's scope?
 * Out-of-scope rules win over in-scope rules (deny wins). Wildcards `*.x.com` cover subdomains of x.com, not x.com
 * itself unless listed. Lookup is O(hosts × labels) through hash sets, so 2,000 hosts stay well under 10 ms CPU.
 */
export const MAX_LINES = 2000;
export const MAX_BYTES = 64 * 1024;

export interface Asset {
  i: string;
  in: boolean;
  c?: string;
}

export function hostOf(s: string): string | null {
  let t = s.trim().toLowerCase();
  if (!t || t.startsWith("#")) return null;
  t = t.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  t = t.split(/[/?#\s]/)[0];
  t = t
    .replace(/^[^@]*@/, "")
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
  if (!/^(\*\.)?[a-z0-9_-]+(\.[a-z0-9_-]+)+$/.test(t)) return null;
  return t;
}

interface Rules {
  exact: Map<string, string>;
  wild: Map<string, string>;
}

/** A URL rule with a real path ("https://x.com/app/") only covers part of a host. */
export function hasPath(s: string): boolean {
  const m = s.trim().match(/^(?:[a-z][a-z0-9+.-]*:\/\/)?[^/?#\s]+(\/[^?#\s]*)?/i);
  const path = m?.[1] ?? "";
  return path.replace(/\/+$/, "").length > 0;
}

function compile(assets: Asset[], inScope: boolean): Rules {
  const exact = new Map<string, string>();
  const wild = new Map<string, string>();
  for (const a of assets) {
    if (a.in !== inScope) continue;
    const h = hostOf(a.i);
    if (!h) continue;
    // deny rules limited to a path don't exclude the whole host; allow rules limited to a path still
    // put the host in scope, and the rule text shows the path
    if (!inScope && hasPath(a.i)) continue;
    if (h.startsWith("*.")) wild.set(h.slice(2), a.i);
    else exact.set(h, a.i);
  }
  return { exact, wild };
}

function lookup(host: string, r: Rules): string | null {
  const e = r.exact.get(host);
  if (e) return e;
  const labels = host.split(".");
  for (let i = 1; i < labels.length - 1; i++) {
    const w = r.wild.get(labels.slice(i).join("."));
    if (w) return w;
  }
  return null;
}

export function matchHosts(input: string, assets: Asset[]) {
  const lines = input.slice(0, MAX_BYTES).split("\n").slice(0, MAX_LINES);
  const inR = compile(assets, true);
  const outR = compile(assets, false);
  const res = {
    in: [] as { host: string; rule: string }[],
    out: [] as { host: string; rule: string }[],
    unknown: [] as string[],
    invalid: 0,
  };
  const seen = new Set<string>();
  for (const line of lines) {
    const h = hostOf(line);
    if (!h) {
      if (line.trim()) res.invalid++;
      continue;
    }
    if (seen.has(h)) continue;
    seen.add(h);
    const deny = lookup(h, outR);
    if (deny) {
      res.out.push({ host: h, rule: deny });
      continue;
    }
    const allow = lookup(h, inR);
    if (allow) res.in.push({ host: h, rule: allow });
    else res.unknown.push(h);
  }
  return res;
}
