import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { rank } from "../../../ranking/score";
import {
  ASSET_TYPES,
  type CatalogProgram,
  loadCatalog,
  loadProfile,
  type Profile,
  postJson,
  SKILLS,
  saveProfile,
  uid,
} from "../lib";
import { Card, Status, Toggle } from "../ui";

const BOUNTIES = [0, 100, 500, 1000, 5000];
const HOURS = [2, 5, 10, 20, 40];
const REASONS = ["too competitive", "not my stack", "low pay"];
const bountyLabel = (n: number) => (n === 0 ? "Any" : n >= 1000 ? `$${n / 1000}k+` : `$${n}+`);

function toggle(list: string[], v: string): string[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

function Onboarding({
  initial,
  platforms,
  onDone,
}: {
  initial: Profile;
  platforms: [string, string][];
  onDone: (p: Profile) => void;
}) {
  const [p, setP] = useState<Profile>({
    skills: [],
    assets: [],
    platforms: [],
    min_bounty: 0,
    vdp_ok: true,
    exclude: [],
    exclude_platforms: [],
    hours_per_week: 10,
    ...initial,
  });
  const set = (patch: Partial<Profile>) => setP((prev) => ({ ...prev, ...patch }));
  const flip = (key: "skills" | "assets" | "platforms" | "exclude", v: string) =>
    setP((prev) => ({ ...prev, [key]: toggle((prev[key] as string[] | undefined) ?? [], v) }));
  const skills = p.skills ?? [];
  const assets = p.assets ?? [];
  const plats = p.platforms ?? [];
  const exclude = p.exclude ?? [];
  return (
    <form
      class="panel onboard"
      onSubmit={(e) => {
        e.preventDefault();
        onDone({ ...p, hard: ["platforms", "min_bounty", "vdp_ok", "exclude"] });
      }}
    >
      <h2>Tell Quarry what you hunt</h2>
      <p class="muted">Takes about 30 seconds. Stored only in this browser unless you use chat or alerts.</p>
      <fieldset>
        <legend>Skills</legend>
        <div class="chip-row">
          {SKILLS.map((s) => (
            <Toggle key={s} on={skills.includes(s)} onClick={() => flip("skills", s)}>
              {s}
            </Toggle>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>Asset types</legend>
        <div class="chip-row">
          {ASSET_TYPES.map((s) => (
            <Toggle key={s} on={assets.includes(s)} onClick={() => flip("assets", s)}>
              {s}
            </Toggle>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>Platforms (none selected = any)</legend>
        <div class="chip-row">
          {platforms.map(([k, n]) => (
            <Toggle key={k} on={plats.includes(k)} onClick={() => flip("platforms", k)}>
              {n}
            </Toggle>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>Minimum max-bounty</legend>
        <div class="chip-row">
          {BOUNTIES.map((b) => (
            <Toggle key={b} on={p.min_bounty === b} onClick={() => set({ min_bounty: b })}>
              {bountyLabel(b)}
            </Toggle>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>Other</legend>
        <div class="chip-row">
          <Toggle on={p.vdp_ok !== false} onClick={() => set({ vdp_ok: p.vdp_ok === false })}>
            VDPs (no bounty) ok
          </Toggle>
          <Toggle on={exclude.includes("contract")} onClick={() => flip("exclude", "contract")}>
            no web3
          </Toggle>
          <Toggle on={exclude.includes("hardware")} onClick={() => flip("exclude", "hardware")}>
            no hardware
          </Toggle>
          <Toggle on={exclude.includes("desktop")} onClick={() => flip("exclude", "desktop")}>
            no desktop
          </Toggle>
        </div>
      </fieldset>
      <fieldset>
        <legend>Hours per week</legend>
        <div class="chip-row">
          {HOURS.map((h) => (
            <Toggle key={h} on={p.hours_per_week === h} onClick={() => set({ hours_per_week: h })}>
              {h}
            </Toggle>
          ))}
        </div>
      </fieldset>
      <button type="submit" class="btn primary">
        Show my feed
      </button>
    </form>
  );
}

function Feed({
  profile,
  setProfile,
  programs,
  onEdit,
}: {
  profile: Profile;
  setProfile: (p: Profile) => void;
  programs: CatalogProgram[];
  onEdit: () => void;
}) {
  const byId = useMemo(() => new Map(programs.map((x) => [x.id, x])), [programs]);
  const ranked = useMemo(() => rank(programs, profile, Date.now() / 1000, 30), [programs, profile]);
  const [asking, setAsking] = useState<string | null>(null);
  const act = (id: string, action: "save" | "dismiss", reason?: string) => {
    const next: Profile = { ...profile };
    if (action === "save") next.saved = [...new Set([...(profile.saved ?? []), id])];
    else next.dismissed = [...(profile.dismissed ?? []), { id, reason, ts: Math.floor(Date.now() / 1000) }];
    saveProfile(next);
    setProfile(next);
    setAsking(null);
    postJson("/api/feedback", { uid: uid(), program: id, action, reason }, 5000).catch(() => {});
  };
  const saved = (profile.saved ?? []).map((id) => byId.get(id)).filter((x): x is CatalogProgram => !!x);
  return (
    <section aria-label="Your feed">
      <div class="row between">
        <h2>For you</h2>
        <div class="row">
          <a class="btn" href="/chat/">
            Ask Quarry
          </a>
          <button type="button" class="btn" onClick={onEdit}>
            Edit profile
          </button>
        </div>
      </div>
      {saved.length > 0 && (
        <details class="saved">
          <summary>{saved.length} saved</summary>
          <ul class="plain">
            {saved.map((s) => (
              <li key={s.id}>
                <a href={s.path}>{s.n}</a> <span class="muted">{s.pn}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {ranked.length === 0 && <p>No open programs match your hard filters. Edit your profile to loosen them.</p>}
      <div class="grid">
        {ranked.map((r) => {
          const p = byId.get(r.id);
          if (!p) return null;
          return (
            <Card
              key={r.id}
              p={p}
              reasons={r.reasons}
              actions={
                asking === r.id ? (
                  <fieldset class="chip-row">
                    <legend class="sr-only">{`Why dismiss ${p.n}?`}</legend>
                    {REASONS.map((x) => (
                      <button key={x} type="button" class="chip-btn" onClick={() => act(r.id, "dismiss", x)}>
                        {x}
                      </button>
                    ))}
                    <button type="button" class="chip-btn" onClick={() => act(r.id, "dismiss")}>
                      other
                    </button>
                    <button type="button" class="chip-btn" onClick={() => setAsking(null)}>
                      cancel
                    </button>
                  </fieldset>
                ) : (
                  <>
                    <button type="button" class="btn sm" onClick={() => act(r.id, "save")}>
                      Save
                    </button>
                    <button type="button" class="btn sm" onClick={() => setAsking(r.id)}>
                      Dismiss
                    </button>
                  </>
                )
              }
            />
          );
        })}
      </div>
    </section>
  );
}

function App() {
  const [profile, setProfile] = useState<Profile | null>(() => loadProfile());
  const [editing, setEditing] = useState(false);
  const [programs, setPrograms] = useState<CatalogProgram[] | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    loadCatalog()
      .then((c) => setPrograms(c.programs))
      .catch(() => setErr(true));
  }, []);
  const platforms = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of programs ?? []) m.set(p.p, p.pn);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [programs]);

  if (err) return <p role="alert">Could not load the program catalog. The lists on this page still work without it.</p>;
  if (!programs) return <Status>Loading programs…</Status>;
  if (!profile || profile.skills === undefined || editing)
    return (
      <Onboarding
        initial={profile ?? {}}
        platforms={platforms}
        onDone={(p) => {
          const next = { ...p, saved: profile?.saved ?? [], dismissed: profile?.dismissed ?? [] };
          saveProfile(next);
          setProfile(next);
          setEditing(false);
        }}
      />
    );
  return <Feed profile={profile} setProfile={setProfile} programs={programs} onEdit={() => setEditing(true)} />;
}

export default function mount(el: HTMLElement) {
  el.textContent = "";
  render(<App />, el);
}
