import { type ComponentChildren, render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { type CatalogProgram, loadCatalog, postJson, safeHref, uid } from "../lib";
import { markTurnstileOk, turnstileToken } from "../turnstile";

interface ChatReply {
  reply?: string;
  programs?: string[];
  tools?: string[];
  limited?: boolean;
  turnstile_ok?: boolean;
}
interface Msg {
  role: "user" | "bot";
  text: string;
  programs?: string[];
  limited?: boolean;
}

/** Inline markdown-lite: `code` and [text](url); nothing else is interpreted and no HTML is ever injected. */
function inline(s: string): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  const re = /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m = re.exec(s);
  while (m) {
    if (m.index > last) out.push(s.slice(last, m.index));
    if (m[1] !== undefined) out.push(<code key={m.index}>{m[1]}</code>);
    else {
      const href = safeHref(m[3] ?? "");
      out.push(
        href ? (
          <a key={m.index} href={href} rel="noopener noreferrer">
            {m[2]}
          </a>
        ) : (
          (m[2] ?? "")
        ),
      );
    }
    last = m.index + m[0].length;
    m = re.exec(s);
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

function Markdown({ text }: { text: string }) {
  const blocks = text.replace(/\r/g, "").split(/\n{2,}/);
  return (
    <>
      {blocks.map((b, bi) => {
        const lines = b.split("\n").filter((l) => l.trim());
        if (!lines.length) return null;
        if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) {
          return (
            <ul key={bi}>
              {lines.map((l, li) => (
                <li key={li}>{inline(l.replace(/^\s*[-*•]\s+/, ""))}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={bi}>
            {lines.map((l, li) => (
              <span key={li}>
                {li > 0 && <br />}
                {inline(l)}
              </span>
            ))}
          </p>
        );
      })}
    </>
  );
}

function Chat() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [byId, setById] = useState<Map<string, CatalogProgram>>(new Map());
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadCatalog()
      .then((c) => setById(new Map(c.programs.map((p) => [p.id, p]))))
      .catch(() => {});
  }, []);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "nearest" });
  }, [msgs, busy]);

  const send = async () => {
    const message = input.trim();
    if (!message || busy) return;
    setInput("");
    setMsgs((m) => [...m, { role: "user", text: message }]);
    setBusy(true);
    try {
      let turnstile: string | undefined;
      try {
        turnstile = await turnstileToken();
      } catch {
        turnstile = undefined; // let the server decide whether that is acceptable
      }
      const r = await postJson<ChatReply>("/api/chat", { uid: uid(), message, turnstile }, 60000);
      if (r.turnstile_ok) markTurnstileOk();
      if (r.limited) {
        setMsgs((m) => [
          ...m,
          {
            role: "bot",
            limited: true,
            text: "You've reached today's chat limit. It resets tomorrow; browsing, search and alerts keep working.",
          },
        ]);
      } else {
        setMsgs((m) => [...m, { role: "bot", text: r.reply ?? "", programs: r.programs }]);
      }
    } catch {
      setMsgs((m) => [...m, { role: "bot", text: "Something went wrong reaching the assistant. Please try again." }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="chat">
      <div class="chat-log" role="log" aria-live="polite" aria-label="Conversation">
        {msgs.length === 0 && (
          <p class="muted">
            Ask things like "new API programs paying over $1k" or "which programs allow automated scanning?". Quarry
            answers from the same public data as the rest of the site.
          </p>
        )}
        {msgs.map((m, i) => (
          <div key={i} class={`msg ${m.role}`}>
            <span class="who">{m.role === "user" ? "You" : "Quarry"}</span>
            <Markdown text={m.text} />
            {m.programs && m.programs.length > 0 && (
              <ul class="chips">
                {m.programs.map((id) => {
                  const p = byId.get(id);
                  return <li key={id}>{p?.path ? <a href={p.path}>{p.n}</a> : id}</li>;
                })}
              </ul>
            )}
          </div>
        ))}
        {busy && <p class="muted">Thinking…</p>}
        <div ref={end} />
      </div>
      <form
        class="row chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <label class="sr-only" for="chat-in">
          Message
        </label>
        <input
          id="chat-in"
          type="text"
          autocomplete="off"
          maxLength={1000}
          value={input}
          placeholder="Ask about programs…"
          onInput={(e) => setInput((e.target as HTMLInputElement).value)}
        />
        <button type="submit" class="btn primary" disabled={busy || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}

export default function mount(el: HTMLElement) {
  el.textContent = "";
  render(<Chat />, el);
}
