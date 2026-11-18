import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { type CatalogProgram, dateStr, getJson, loadCatalog, loadProfile } from "../lib";
import { Status, Toggle } from "../ui";

interface Entry {
  id: string;
  ts: number;
  kind: string;
  prio: number;
  pid: string | null;
  title: string;
  body: string;
  summary: string;
}

const KINDS = ["SCOPE", "SCOPE-", "STATE", "OPEN", "NEW", "GONE", "BOUNTY", "META"];

function Changes() {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [byId, setById] = useState<Map<string, CatalogProgram>>(new Map());
  const [err, setErr] = useState(false);
  const [kinds, setKinds] = useState<string[]>([]);
  const [mine, setMine] = useState(false);
  const profile = useMemo(() => loadProfile(), []);
  const hasProfile = !!profile && !!(profile.platforms?.length || profile.assets?.length || profile.skills?.length);

  useEffect(() => {
    Promise.all([getJson<{ entries: Entry[] }>("/data/changes.json", 15000), loadCatalog().catch(() => null)])
      .then(([c, cat]) => {
        setEntries(c.entries);
        if (cat) setById(new Map(cat.programs.map((p) => [p.id, p])));
        document.getElementById("changes-static")?.setAttribute("hidden", "");
      })
      .catch(() => setErr(true));
  }, []);

  const shown = useMemo(() => {
    const plats = profile?.platforms ?? [];
    const cats = new Set(profile?.assets ?? []);
    return (entries ?? []).filter((e) => {
      if (kinds.length && !kinds.includes(e.kind)) return false;
      if (mine && e.pid) {
        const p = byId.get(e.pid);
        if (plats.length && !plats.includes(e.pid.split(":")[0])) return false;
        if (cats.size && p && !p.cat.some((c) => cats.has(c))) return false;
      }
      return true;
    });
  }, [entries, kinds, mine, byId, profile]);

  if (err) return null;
  if (!entries) return <Status>Loading changes…</Status>;
  return (
    <section aria-label="Filter changes">
      <div class="panel">
        <fieldset class="chip-row">
          <legend class="sr-only">Kind</legend>
          {KINDS.map((k) => (
            <Toggle
              key={k}
              on={kinds.includes(k)}
              onClick={() => setKinds(kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k])}
            >
              {k}
            </Toggle>
          ))}
        </fieldset>
        {hasProfile && (
          <label class="check">
            <input type="checkbox" checked={mine} onChange={(e) => setMine((e.target as HTMLInputElement).checked)} />
            Only my platforms and asset types
          </label>
        )}
      </div>
      <Status>{`${shown.length} changes`}</Status>
      <ul class="feed plain">
        {shown.map((e) => {
          const p = e.pid ? byId.get(e.pid) : undefined;
          const path = p?.path;
          return (
            <li key={e.id}>
              <span class={`badge k-${e.kind.replace("-", "m").toLowerCase()}`}>{e.kind}</span>{" "}
              {path ? <a href={path}>{e.title}</a> : <strong>{e.title}</strong>}
              <div class="muted small">
                {dateStr(e.ts)} · {e.summary}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default function mount(el: HTMLElement) {
  el.textContent = "";
  render(<Changes />, el);
}
