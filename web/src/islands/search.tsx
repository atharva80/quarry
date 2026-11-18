import type MiniSearch from "minisearch";
import { render } from "preact";
import { useRef, useState } from "preact/hooks";
import { type CatalogProgram, loadCatalog, loadProfile, postJson } from "../lib";
import { Status } from "../ui";

interface Hit {
  p: CatalogProgram;
  reasons?: string[];
}

let engine: Promise<{ ms: MiniSearch<CatalogProgram>; byId: Map<string, CatalogProgram> }> | null = null;
function getEngine() {
  if (!engine) {
    engine = Promise.all([import("minisearch"), loadCatalog()]).then(([mod, cat]) => {
      const MS = mod.default;
      const ms = new MS<CatalogProgram>({
        fields: ["n", "pn", "cat", "t", "sc"],
        storeFields: [],
        idField: "id",
        searchOptions: { boost: { n: 3 }, prefix: true, fuzzy: 0.15, combineWith: "AND" },
      });
      ms.addAll(cat.programs);
      return { ms, byId: new Map(cat.programs.map((p) => [p.id, p])) };
    });
    engine.catch(() => {
      engine = null;
    });
  }
  return engine;
}

function Search() {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  const run = async (text: string) => {
    const my = ++seq.current;
    setNote("");
    if (!text.trim()) {
      setHits([]);
      return;
    }
    try {
      const e = await getEngine();
      if (my !== seq.current) return;
      const res = e.ms.search(text).slice(0, 12);
      setHits(res.flatMap((r) => (e.byId.get(r.id) ? [{ p: e.byId.get(r.id) as CatalogProgram }] : [])));
    } catch {
      setNote("Search data could not be loaded.");
    }
  };

  const smart = async () => {
    if (!q.trim()) return;
    const my = ++seq.current;
    setBusy(true);
    setNote("");
    try {
      const [e, r] = await Promise.all([
        getEngine(),
        postJson<{ results: { id: string; score: number; reasons: string[] }[] }>(
          "/api/search",
          { q, profile: loadProfile() ?? undefined },
          3000,
        ),
      ]);
      if (my !== seq.current) return;
      const out: Hit[] = [];
      for (const x of r.results.slice(0, 12)) {
        const p = e.byId.get(x.id);
        if (p) out.push({ p, reasons: x.reasons });
      }
      setHits(out);
      setNote(out.length ? "Smart search results" : "Smart search found nothing.");
    } catch {
      if (my === seq.current) setNote("Smart search unavailable; showing keyword results.");
    } finally {
      setBusy(false);
    }
  };

  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const links = () => Array.from(listRef.current?.querySelectorAll("a") ?? []);

  const onInputKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" && hits.length) {
      e.preventDefault();
      links()[0]?.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const first = hits[0]?.p.path;
      if (first) location.href = first;
      else void smart();
    } else if (e.key === "Escape") setHits([]);
  };
  const onListKey = (e: KeyboardEvent) => {
    const ls = links();
    const i = ls.indexOf(document.activeElement as HTMLAnchorElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      ls[Math.min(ls.length - 1, i + 1)]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (i <= 0) inputRef.current?.focus();
      else ls[i - 1]?.focus();
    } else if (e.key === "Escape") {
      inputRef.current?.focus();
      setHits([]);
    }
  };

  return (
    <search class="search">
      <label for="q-search">Search programs, targets or tags</label>
      <div class="row">
        <input
          id="q-search"
          type="search"
          autocomplete="off"
          placeholder="e.g. graphql, *.example.com, fintech"
          value={q}
          ref={inputRef}
          onFocus={() => void getEngine().catch(() => {})}
          onInput={(e) => {
            const v = (e.target as HTMLInputElement).value;
            setQ(v);
            void run(v);
          }}
          onKeyDown={onInputKey}
        />
        <button type="button" class="btn" disabled={busy || !q.trim()} onClick={() => void smart()}>
          {busy ? "Searching…" : "Smart search"}
        </button>
      </div>
      <Status>{note}</Status>
      {hits.length > 0 && (
        <ul class="results" ref={listRef} aria-label="Search results" onKeyDown={onListKey}>
          {hits.map((h) => (
            <li key={h.p.id}>
              <a href={h.p.path}>
                <strong>{h.p.n}</strong> <span class="muted">{h.p.pn}</span>
                {h.p.b ? ` · max ${h.p.mx || "n/a"}` : " · VDP"}
              </a>
              {h.reasons && h.reasons.length > 0 && <span class="muted small"> {h.reasons.join(" · ")}</span>}
            </li>
          ))}
        </ul>
      )}
    </search>
  );
}

export default function mount(el: HTMLElement) {
  el.textContent = "";
  render(<Search />, el);
}
