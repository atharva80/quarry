import { BenchAgent, benchAgent, benchVectors } from "./bench";

export { BenchAgent };

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/_bench/")) {
      if (req.headers.get("x-bench") !== env.BENCH_TOKEN) return new Response("forbidden", { status: 403 });
      if (url.pathname === "/api/_bench/vec") return benchVectors(env, req);
      if (url.pathname === "/api/_bench/agent") return benchAgent(env, req);
    }
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
