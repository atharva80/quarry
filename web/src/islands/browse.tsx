import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { type CatalogProgram, loadCatalog } from "../lib";
import { Status } from "../ui";

const PAGE = 100;
const WINDOWS: [string, number][] = [
  ["any time", 0],
  ["7 days", 7],
  ["14 days", 14],
  ["30 days", 30],
];
const BOUNTIES: [string, number][] = [
  ["any", 0],
  ["$100+", 100],
  ["$500+", 500],
  ["$1k+", 1000],
  ["$5k+", 5000],
  ["$10k+", 10000],
];

function Browse() {
  const [all, setAll] = useState<CatalogProgram[] | null>(null);
  const [err, setErr] = useState(false);
  const [text, setText] = useState("");
  const [platform, setPlatform] = useState("");
  const [category, setCategory] = useState("");
  const [minB, setMinB] = useState(0);
  const [bountyOnly, setBountyOnly] = useState(false);
  const [win, setWin] = useState(0);
  const [shown, setShown] = useState(PAGE);

  useEffect(() => {
    loadCatalog()
      .then((c) => {
        setAll(c.programs.filter((p) => p.s === "open").sort((a, b) => b.L - a.L));
        document.getElementById("browse-static")?.setAttribute("hidden", "");
      })
      .catch(() => setErr(true));
  }, []);

  const platforms = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of all ?? []) m.set(p.p, p.pn);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [all]);
  const categories = useMemo(() => [...new Set((all ?? []).flatMap((p) => p.cat))].sort(), [all]);

  const rows = useMemo(() => {
    const t = text.trim().toLowerCase();
    return (all ?? []).filter((p) => {
      if (platform && p.p !== platform) return false;
      if (category && !p.cat.includes(category)) return false;
      if (bountyOnly && !p.b) return false;
      if (minB && p.usd < minB) return false;
      if (win === 7 && p.n7 < 1) return false;
      if (win === 14 && p.n14 < 1) return false;
      if (win === 30 && p.n30 < 1) return false;
      if (
        t &&
        !(
          p.n.toLowerCase().includes(t) ||
          p.pn.toLowerCase().includes(t) ||
          (p.sc ?? []).some((s) => s.toLowerCase().includes(t))
        )
      )
        return false;
      return true;
    });
  }, [all, text, platform, category, minB, bountyOnly, win]);

  if (err) return null; // static table stays visible
  if (!all) return <Status>Loading filters…</Status>;
  const reset = () => setShown(PAGE);
  return (
    <section aria-label="Filter programs">
      <form class="filters panel" onSubmit={(e) => e.preventDefault()}>
        <label>
          Text
          <input
            type="search"
            value={text}
            onInput={(e) => {
              setText((e.target as HTMLInputElement).value);
              reset();
            }}
          />
        </label>
        <label>
          Platform
          <select
            value={platform}
            onChange={(e) => {
              setPlatform((e.target as HTMLSelectElement).value);
              reset();
            }}
          >
            <option value="">All</option>
            {platforms.map(([k, n]) => (
              <option key={k} value={k}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label>
          Category
          <select
            value={category}
            onChange={(e) => {
              setCategory((e.target as HTMLSelectElement).value);
              reset();
            }}
          >
            <option value="">All</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label>
          Min bounty
          <select
            value={minB}
            onChange={(e) => {
              setMinB(Number((e.target as HTMLSelectElement).value));
              reset();
            }}
          >
            {BOUNTIES.map(([l, v]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label>
          New scope in
          <select
            value={win}
            onChange={(e) => {
              setWin(Number((e.target as HTMLSelectElement).value));
              reset();
            }}
          >
            {WINDOWS.map(([l, v]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label class="check">
          <input
            type="checkbox"
            checked={bountyOnly}
            onChange={(e) => {
              setBountyOnly((e.target as HTMLInputElement).checked);
              reset();
            }}
          />
          Bounty only
        </label>
      </form>
      <Status>{`${rows.length} of ${all.length} open programs`}</Status>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Program</th>
              <th scope="col">Platform</th>
              <th scope="col">Max reward</th>
              <th scope="col">Categories</th>
              <th scope="col" class="num">
                In scope
              </th>
              <th scope="col" class="num">
                New 30d
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, shown).map((p) => (
              <tr key={p.id}>
                <td>
                  <a href={p.path}>{p.n}</a>
                </td>
                <td>{p.pn}</td>
                <td>{p.b ? p.mx || "—" : "VDP"}</td>
                <td>{p.cat.join(", ")}</td>
                <td class="num">{p.na}</td>
                <td class="num">{p.n30}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > shown && (
        <button type="button" class="btn" onClick={() => setShown(shown + PAGE)}>
          Show more
        </button>
      )}
    </section>
  );
}

export default function mount(el: HTMLElement) {
  el.textContent = "";
  render(<Browse />, el);
}
