import { type ComponentChildren, render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { type ApiConfig, copyText, getJson, loadConfig, lsDel, postJson, uid } from "../lib";
import { Status } from "../ui";

interface AlertState {
  telegram?: unknown;
  discord?: unknown;
  push?: unknown;
  rss?: unknown;
}

const DISCORD_RE = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+\/?$/;

function Section({ title, id, children }: { title: string; id: string; children: ComponentChildren }) {
  return (
    <section class="panel" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}

function urlB64ToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function Alerts() {
  const [cfg, setCfg] = useState<ApiConfig | null>(null);
  const [state, setState] = useState<AlertState>({});
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [tg, setTg] = useState("");
  const [hook, setHook] = useState("");
  const [rss, setRss] = useState("");
  const say = (k: string, v: string) => setMsg((m) => ({ ...m, [k]: v }));

  useEffect(() => {
    loadConfig().then(setCfg);
    getJson<AlertState>(`/api/alerts?uid=${uid()}`, 5000)
      .then(setState)
      .catch(() => {});
  }, []);

  const remove = async (kind: string) => {
    try {
      await postJson(`/api/alerts/${kind}`, { uid: uid() }, 8000, "DELETE");
      setState((s) => ({ ...s, [kind]: undefined }));
      say(kind, "Removed.");
    } catch {
      say(kind, "Could not remove it. Try again.");
    }
  };

  const doTelegram = async () => {
    say("telegram", "");
    try {
      const r = await postJson<{ link: string }>("/api/alerts/telegram", { uid: uid() });
      if (!/^https:\/\/t\.me\//.test(r.link)) throw new Error("bad link");
      setTg(r.link);
    } catch {
      say("telegram", "Could not create a Telegram link right now.");
    }
  };

  const doDiscord = async () => {
    const h = hook.trim();
    if (!DISCORD_RE.test(h)) {
      say("discord", "That doesn't look like a Discord webhook URL (https://discord.com/api/webhooks/…).");
      return;
    }
    try {
      await postJson("/api/alerts/discord", { uid: uid(), webhook: h });
      setHook("");
      setState((s) => ({ ...s, discord: true }));
      say("discord", "Discord alerts enabled.");
    } catch {
      say("discord", "Could not save the webhook. Try again.");
    }
  };

  const doPush = async () => {
    try {
      if (!cfg?.vapid_public_key || !("serviceWorker" in navigator) || !("PushManager" in window))
        throw new Error("unsupported");
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        say("push", "Notifications were not allowed in this browser.");
        return;
      }
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlB64ToBytes(cfg.vapid_public_key),
        }));
      await postJson("/api/alerts/push", { uid: uid(), subscription: sub.toJSON() });
      setState((s) => ({ ...s, push: true }));
      say("push", "Push notifications enabled on this device.");
    } catch {
      say("push", "Could not enable push notifications on this device.");
    }
  };

  const doRss = async () => {
    try {
      const r = await postJson<{ url: string }>("/api/alerts/rss", { uid: uid() });
      setRss(r.url);
      setState((s) => ({ ...s, rss: true }));
    } catch {
      say("rss", "Could not create a feed URL right now.");
    }
  };

  const wipe = async () => {
    if (!confirm("Delete everything Quarry stores about you (alerts, chat memory, profile on the server)?")) return;
    try {
      await postJson("/api/me", { uid: uid() }, 15000, "DELETE");
      for (const k of ["quarry.profile", "quarry.uid", "quarry.turnstile_ok"]) lsDel(k);
      setState({});
      say("me", "Your data was deleted. This browser's saved profile was cleared too.");
    } catch {
      say("me", "Deletion failed. Try again in a moment.");
    }
  };

  return (
    <div class="tools">
      <Section title="Telegram" id="a-tg">
        <p>Get a message when programs matching your profile add scope.</p>
        <div class="row wrap">
          <button type="button" class="btn" onClick={() => void doTelegram()}>
            Connect Telegram
          </button>
          {state.telegram ? (
            <button type="button" class="btn" onClick={() => void remove("telegram")}>
              Disconnect
            </button>
          ) : null}
        </div>
        {tg && (
          <p>
            <a href={tg} rel="noopener noreferrer">
              Open {tg}
            </a>{" "}
            and press Start.
          </p>
        )}
        <Status>{msg.telegram}</Status>
      </Section>

      <Section title="Discord webhook" id="a-dc">
        <label for="dc-hook">Webhook URL</label>
        <input
          id="dc-hook"
          type="url"
          autocomplete="off"
          placeholder="https://discord.com/api/webhooks/…"
          value={hook}
          onInput={(e) => setHook((e.target as HTMLInputElement).value)}
        />
        <div class="row wrap">
          <button type="button" class="btn" onClick={() => void doDiscord()}>
            Save webhook
          </button>
          {state.discord ? (
            <button type="button" class="btn" onClick={() => void remove("discord")}>
              Remove
            </button>
          ) : null}
        </div>
        <Status>{msg.discord}</Status>
      </Section>

      {cfg?.vapid_public_key && (
        <Section title="Web Push" id="a-push">
          <p>Browser notifications on this device.</p>
          <div class="row wrap">
            <button type="button" class="btn" onClick={() => void doPush()}>
              Enable push
            </button>
            {state.push ? (
              <button type="button" class="btn" onClick={() => void remove("push")}>
                Disable
              </button>
            ) : null}
          </div>
          <Status>{msg.push}</Status>
        </Section>
      )}

      <Section title="Personal RSS feed" id="a-rss">
        <p>A private Atom feed URL for your feed reader. Keep it to yourself.</p>
        <div class="row wrap">
          <button type="button" class="btn" onClick={() => void doRss()}>
            Create feed URL
          </button>
          {state.rss ? (
            <button type="button" class="btn" onClick={() => void remove("rss")}>
              Revoke
            </button>
          ) : null}
        </div>
        {rss && (
          <p class="row wrap">
            <input
              type="text"
              readOnly
              value={rss}
              aria-label="Personal feed URL"
              onFocus={(e) => (e.target as HTMLInputElement).select()}
            />
            <button
              type="button"
              class="btn sm"
              onClick={async () => say("rss", (await copyText(rss)) ? "Copied." : "Copy failed.")}
            >
              Copy
            </button>
          </p>
        )}
        <Status>{msg.rss}</Status>
      </Section>

      <Section title="Delete my data" id="a-me">
        <p>
          Removes your alert subscriptions, chat memory and server-side profile. See the{" "}
          <a href="/privacy/">privacy page</a> for what is stored.
        </p>
        <button type="button" class="btn danger" onClick={() => void wipe()}>
          Delete my data
        </button>
        <Status>{msg.me}</Status>
      </Section>
    </div>
  );
}

export default function mount(el: HTMLElement) {
  el.textContent = "";
  render(<Alerts />, el);
}
