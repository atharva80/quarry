import type { ComponentChildren } from "preact";
import type { CatalogProgram } from "./lib";

export function Chips({ items, cls = "" }: { items: string[]; cls?: string }) {
  if (!items.length) return null;
  return (
    <ul class={`chips ${cls}`}>
      {items.map((x) => (
        <li key={x}>{x}</li>
      ))}
    </ul>
  );
}

export function Toggle({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: ComponentChildren;
}) {
  return (
    <button type="button" class={`chip-btn${on ? " on" : ""}`} aria-pressed={on} onClick={onClick}>
      {children}
    </button>
  );
}

export function Card({
  p,
  reasons,
  actions,
}: {
  p: CatalogProgram;
  reasons?: string[];
  actions?: ComponentChildren;
}) {
  return (
    <article class="card">
      <h3>
        <a href={p.path ?? "#"}>{p.n}</a>
      </h3>
      <p class="meta">
        {p.pn} · {p.b ? `max ${p.mx || "n/a"}` : "VDP"} · {p.na} in scope
      </p>
      {p.cat.length > 0 && <Chips items={p.cat} />}
      {reasons && reasons.length > 0 && <Chips items={reasons} cls="reasons" />}
      {actions && <div class="actions">{actions}</div>}
    </article>
  );
}

export function Status({ children }: { children?: ComponentChildren }) {
  return (
    <p class="status" role="status" aria-live="polite">
      {children}
    </p>
  );
}
