/** Must match pipeline/src/quarry_pipeline/site.py program_path (tested in test/paths.test.ts). */
export function programPaths(id: string): { page: string; json: string } {
  const i = id.indexOf(":");
  const plat = id.slice(0, i);
  const handle = id.slice(i + 1);
  let seg =
    handle
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/\.{2,}/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "") || "x";
  if (seg !== handle) {
    let h = 0;
    for (const ch of handle) h = (Math.imul(h, 31) + (ch.codePointAt(0) ?? 0)) >>> 0;
    seg = `${seg}-${h % 100000}`;
  }
  return { page: `/p/${plat}/${seg}/`, json: `/data/p/${plat}/${seg}.json` };
}
