import { loadConfig, lsGet, lsSet } from "./lib";

interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptP: Promise<void> | null = null;
function loadScript(): Promise<void> {
  if (!scriptP) {
    scriptP = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        scriptP = null;
        reject(new Error("turnstile script failed"));
      };
      document.head.appendChild(s);
    });
  }
  return scriptP;
}

/** A Turnstile token when the server asks for one and this browser has not yet been verified; else undefined. */
export async function turnstileToken(): Promise<string | undefined> {
  if (lsGet("quarry.turnstile_ok")) return undefined;
  const cfg = await loadConfig();
  if (!cfg.turnstile_sitekey) return undefined;
  await loadScript();
  const api = window.turnstile;
  if (!api) throw new Error("turnstile unavailable");
  return new Promise<string>((resolve, reject) => {
    const box = document.createElement("div");
    box.className = "turnstile-box";
    document.body.appendChild(box);
    const done = () => box.remove();
    api.render(box, {
      sitekey: cfg.turnstile_sitekey,
      appearance: "interaction-only",
      callback: (t: string) => {
        done();
        resolve(t);
      },
      "error-callback": () => {
        done();
        reject(new Error("turnstile failed"));
      },
      "timeout-callback": () => {
        done();
        reject(new Error("turnstile timed out"));
      },
    });
  });
}

export function markTurnstileOk(): void {
  lsSet("quarry.turnstile_ok", "1");
}
