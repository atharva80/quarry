import type { CatalogProgram, Profile } from "../../ranking/score";

export type { CatalogProgram, Profile };

export interface Catalog {
  generated: string;
  source_updated: string;
  programs: CatalogProgram[];
}

// ---- storage (always guarded: private windows / blocked storage throw) ----
export function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}
export function lsDel(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

let memUid = "";
export function uid(): string {
  const have = lsGet("quarry.uid");
  if (have && /^[0-9a-f]{32}$/.test(have)) return have;
  if (memUid) return memUid;
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  const id = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  memUid = id;
  lsSet("quarry.uid", id);
  return id;
}

// ---- profile ----
export function loadProfile(): Profile | null {
  const raw = lsGet("quarry.profile");
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    return p && typeof p === "object" ? (p as Profile) : null;
  } catch {
    return null;
  }
}
export function saveProfile(p: Profile): void {
  lsSet("quarry.profile", JSON.stringify(p));
}

// ---- network ----
export async function fetchT(url: string, init: RequestInit = {}, ms = 10000): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function getJson<T>(url: string, ms = 10000): Promise<T> {
  const r = await fetchT(url, {}, ms);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return (await r.json()) as T;
}

export async function postJson<T>(url: string, body: unknown, ms = 15000, method = "POST"): Promise<T> {
  const r = await fetchT(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, ms);
  if (!r.ok) throw new Error(`${r.status}`);
  return (await r.json()) as T;
}

let catalogP: Promise<Catalog> | null = null;
export function loadCatalog(): Promise<Catalog> {
  if (!catalogP) {
    catalogP = getJson<Catalog>("/data/catalog.json", 20000);
    catalogP.catch(() => {
      catalogP = null;
    });
  }
  return catalogP;
}

export interface ApiConfig {
  turnstile_sitekey?: string;
  vapid_public_key?: string;
  telegram_bot?: string;
}
let cfgP: Promise<ApiConfig> | null = null;
export function loadConfig(): Promise<ApiConfig> {
  if (!cfgP) cfgP = getJson<ApiConfig>("/api/config", 5000).catch(() => ({}));
  return cfgP;
}

// ---- formatting ----
export function dateStr(ts: number): string {
  return ts ? new Date(ts * 1000).toISOString().slice(0, 10) : "—";
}

export function download(name: string, text: string, type = "text/plain"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Only same-origin /p/ paths or http(s) URLs are ever linked. */
export function safeHref(h: string): string | null {
  if (/^\/p\/[A-Za-z0-9._~\-/]*$/.test(h)) return h;
  if (/^https:\/\/[^\s<>"']+$/.test(h)) return h;
  return null;
}

export const SKILLS = [
  "xss",
  "idor",
  "ssrf",
  "graphql",
  "auth",
  "business-logic",
  "mobile-reversing",
  "smart-contracts",
  "source-review",
  "recon",
  "cloud",
  "ai-redteam",
];
export const ASSET_TYPES = ["web", "api", "android", "ios", "contract", "code", "wildcard", "network"];
