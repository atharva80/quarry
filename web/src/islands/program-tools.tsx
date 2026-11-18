import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { type Asset, burpJson, caidoJson, nucleiTargets, plainTargets, wildcardRoots } from "../exports";
import { copyText, download, fetchT, getJson, loadProfile, postJson, saveProfile, uid } from "../lib";
import { markTurnstileOk, turnstileToken } from "../turnstile";
import { Status } from "../ui";

interface ProgramJson {
  assets?: Asset[];
}

const REASONS = ["too competitive", "not my stack", "low pay"];

// ---------- scope filter: drives the server-rendered table via the DOM ----------
function ScopeFilter() {
  const [q, setQ] = useState("");
  const [side, setSide] = useState("all");
  const [paid, setPaid] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    const rows = document.querySelectorAll<HTMLTableRowElement>("#scope-table tbody tr");
    const t = q.trim().toLowerCase();
    let n = 0;
    for (const r of rows) {
      const ok =
        (!t || (r.dataset.q ?? "").includes(t)) &&
        (side === "all" || (side === "in" ? r.dataset.in === "1" : r.dataset.in !== "1")) &&
        (!paid || r.dataset.paid === "1");
      r.hidden = !ok;
      if (ok) n++;
    }
    setCount(n);
  }, [q, side, paid]);
  return (
    <form class="filters panel" onSubmit={(e) => e.preventDefault()} aria-label="Filter scope table">
      <label>
        Filter scope
        <input type="search" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      </label>
      <label>
        Show
        <select value={side} onChange={(e) => setSide((e.target as HTMLSelectElement).value)}>
          <option value="all">In and out of scope</option>
          <option value="in">In scope only</option>
          <option value="out">Out of scope only</option>
        </select>
      </label>
      <label class="check">
        <input type="checkbox" checked={paid} onChange={(e) => setPaid((e.target as HTMLInputElement).checked)} />
        Bounty-eligible only
      </label>
      <Status>{count === null ? "" : `${count} rows shown`}</Status>
    </form>
  );
}

// ---------- exports ----------
const FORMATS: { key: string; label: string; file: string; type: string; make: (a: Asset[]) => string }[] = [
  { key: "txt", label: "In-scope targets (text)", file: "targets.txt", type: "text/plain", make: plainTargets },
  { key: "roots", label: "Wildcard roots", file: "wildcard-roots.txt", type: "text/plain", make: wildcardRoots },
  { key: "burp", label: "Burp Suite scope", file: "burp-scope.json", type: "application/json", make: burpJson },
  { key: "caido", label: "Caido scope", file: "caido-scope.json", type: "application/json", make: caidoJson },
  { key: "nuclei", label: "nuclei targets", file: "nuclei-targets.txt", type: "text/plain", make: nucleiTargets },
];

function Exports({ id, assets }: { id: string; assets: Asset[] | null | "error" }) {
  const [msg, setMsg] = useState("");
  if (assets === "error") return <p>Could not load scope data for exports.</p>;
  if (!assets) return <Status>Loading scope data…</Status>;
  const slug = id.replace(/[^a-z0-9]+/gi, "-");
  return (
    <div>
      <ul class="plain export-list">
        {FORMATS.map((f) => {
          const text = f.make(assets);
          const empty = !text || text === '{\n  "allowlist": [],\n  "denylist": []\n}';
          return (
            <li key={f.key} class="row">
              <span class="grow">{f.label}</span>
              <button
                type="button"
                class="btn sm"
                disabled={empty}
                onClick={() => {
                  download(`${slug}-${f.file}`, text, f.type);
                  setMsg(`Downloaded ${f.file}`);
                }}
              >
                Download
              </button>
              <button
                type="button"
                class="btn sm"
                disabled={empty}
                onClick={async () => setMsg((await copyText(text)) ? `Copied ${f.label}` : "Copy failed; use Download")}
              >
                Copy
              </button>
            </li>
          );
        })}
      </ul>
      <Status>{msg}</Status>
    </div>
  );
}

// ---------- scope check ----------
interface MatchResult {
  in: { host: string; rule: string }[];
  out: { host: string; rule: string }[];
  unknown: string[];
}

function ScopeCheck({ id }: { id: string }) {
  const [text, setText] = useState("");
  const [res, setRes] = useState<MatchResult | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await fetchT(`/api/match?program=${encodeURIComponent(id)}`, { method: "POST", body: text }, 15000);
      if (!r.ok) throw new Error(String(r.status));
      setRes((await r.json()) as MatchResult);
    } catch {
      setRes(null);
      setErr("Scope check failed. Try again, or compare against the scope table above.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <label for="sc-hosts">Hosts to check, one per line</label>
      <textarea id="sc-hosts" rows={5} value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />
      <button type="button" class="btn" disabled={busy || !text.trim()} onClick={() => void run()}>
        {busy ? "Checking…" : "Check scope"}
      </button>
      <div aria-live="polite">
        {err && <p role="alert">{err}</p>}
        {res && (
          <div class="match">
            <MatchList title="In scope" items={res.in.map((x) => `${x.host}  (${x.rule})`)} />
            <MatchList title="Out of scope" items={res.out.map((x) => `${x.host}  (${x.rule})`)} />
            <MatchList title="Unknown" items={res.unknown} />
          </div>
        )}
      </div>
    </div>
  );
}

function MatchList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <h4>
        {title} ({items.length})
      </h4>
      {items.length > 0 && (
        <ul class="plain mono">
          {items.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------- ask ----------
interface AskResult {
  answer: string;
  quotes: { text: string; section: string }[];
  status: "answered" | "not_in_policy" | "unavailable";
  turnstile_ok?: boolean;
}

function Ask({ id }: { id: string }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<AskResult | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    setErr("");
    setRes(null);
    try {
      const turnstile = await turnstileToken().catch(() => undefined);
      const r = await postJson<AskResult>("/api/ask", { uid: uid(), program: id, question: q, turnstile }, 30000);
      if (r.turnstile_ok) markTurnstileOk();
      setRes(r);
    } catch {
      setErr("Could not get an answer right now. Please try again later.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <label for="ask-q">Question about this program's policy</label>
      <textarea
        id="ask-q"
        rows={2}
        maxLength={500}
        placeholder="Is automated scanning allowed? Are subdomain takeovers in scope?"
        value={q}
        onInput={(e) => setQ((e.target as HTMLTextAreaElement).value)}
      />
      <button type="button" class="btn" disabled={busy || q.trim().length < 3} onClick={() => void run()}>
        {busy ? "Reading the policy…" : "Ask"}
      </button>
      <div aria-live="polite">
        {err && <p role="alert">{err}</p>}
        {res?.status === "not_in_policy" && <p>The policy doesn't say.</p>}
        {res?.status === "unavailable" && <p>Policy text isn't available for this program yet.</p>}
        {res && res.status === "answered" && <p>{res.answer}</p>}
        {res?.quotes?.map((x) => (
          <blockquote key={x.text}>
            {x.text}
            <footer>§ {x.section}</footer>
          </blockquote>
        ))}
      </div>
    </div>
  );
}

// ---------- save / dismiss ----------
function Feedback({ id }: { id: string }) {
  const [profile, setProfile] = useState(() => loadProfile() ?? {});
  const [asking, setAsking] = useState(false);
  const saved = profile.saved?.includes(id) ?? false;
  const dismissed = profile.dismissed?.find((d) => d.id === id);
  const send = (action: "save" | "dismiss", reason?: string) => {
    const next = { ...profile };
    if (action === "save") {
      next.saved = [...new Set([...(profile.saved ?? []), id])];
      next.dismissed = (profile.dismissed ?? []).filter((d) => d.id !== id);
    } else {
      next.dismissed = [
        ...(profile.dismissed ?? []).filter((d) => d.id !== id),
        { id, reason, ts: Math.floor(Date.now() / 1000) },
      ];
      next.saved = (profile.saved ?? []).filter((x) => x !== id);
    }
    saveProfile(next);
    setProfile(next);
    setAsking(false);
    postJson("/api/feedback", { uid: uid(), program: id, action, reason }, 5000).catch(() => {});
  };
  return (
    <div class="row wrap">
      <button type="button" class="btn" aria-pressed={saved} disabled={saved} onClick={() => send("save")}>
        {saved ? "Saved" : "Save"}
      </button>
      {!asking && (
        <button type="button" class="btn" onClick={() => setAsking(true)}>
          {dismissed ? `Dismissed${dismissed.reason ? `: ${dismissed.reason}` : ""}` : "Dismiss"}
        </button>
      )}
      {asking && (
        <fieldset class="chip-row">
          <legend class="sr-only">Why dismiss?</legend>
          {REASONS.map((r) => (
            <button key={r} type="button" class="chip-btn" onClick={() => send("dismiss", r)}>
              {r}
            </button>
          ))}
          <button type="button" class="chip-btn" onClick={() => send("dismiss")}>
            other
          </button>
          <button type="button" class="chip-btn" onClick={() => setAsking(false)}>
            cancel
          </button>
        </fieldset>
      )}
    </div>
  );
}

function Tools({ id, path, filter }: { id: string; path: string; filter: boolean }) {
  const [assets, setAssets] = useState<Asset[] | null | "error">(null);
  useEffect(() => {
    getJson<ProgramJson>(path, 20000)
      .then((j) => setAssets(j.assets ?? []))
      .catch(() => setAssets("error"));
  }, [path]);
  return (
    <div class="tools">
      <section class="panel" aria-labelledby="t-save">
        <h2 id="t-save">Save this program</h2>
        <Feedback id={id} />
      </section>
      {filter && <ScopeFilter />}
      <section class="panel" aria-labelledby="t-export">
        <h2 id="t-export">Export scope</h2>
        <p class="muted small">Generated in your browser from the scope table; nothing is uploaded.</p>
        <Exports id={id} assets={assets} />
      </section>
      <section class="panel" aria-labelledby="t-check">
        <h2 id="t-check">Scope check</h2>
        <ScopeCheck id={id} />
      </section>
      <section class="panel" aria-labelledby="t-ask">
        <h2 id="t-ask">Ask about this program</h2>
        <Ask id={id} />
      </section>
    </div>
  );
}

export default function mount(el: HTMLElement) {
  const id = el.dataset.id ?? "";
  const path = el.dataset.path ?? "";
  el.textContent = "";
  // The scope filter sits next to the server-rendered table when the page provides a slot for it.
  const slot = document.getElementById("scope-filter-slot");
  if (slot) render(<ScopeFilter />, slot);
  render(<Tools id={id} path={path} filter={!slot} />, el);
}
