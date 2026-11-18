import "./app.css";

type Loader = () => Promise<{ default: (el: HTMLElement) => void }>;

const ISLANDS: Record<string, Loader> = {
  foryou: () => import("./islands/foryou"),
  search: () => import("./islands/search"),
  browse: () => import("./islands/browse"),
  changes: () => import("./islands/changes"),
  "program-tools": () => import("./islands/program-tools"),
  chat: () => import("./islands/chat"),
  alerts: () => import("./islands/alerts"),
};

function boot() {
  for (const el of document.querySelectorAll<HTMLElement>("[data-island]")) {
    const load = ISLANDS[el.dataset.island ?? ""];
    if (!load) continue;
    load()
      .then((m) => m.default(el))
      .catch(() => {
        el.setAttribute("data-island-error", "1");
      });
  }
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
