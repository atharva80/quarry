import { describe, expect, it } from "vitest";
import { programPaths } from "../src/paths";

// Expected values come from pipeline/src/quarry_pipeline/site.py program_path (Python), so both sides agree.
const CASES: [string, string][] = [
  ["h1:gitlab", "/p/h1/gitlab/"],
  ["standoff:Cap", "/p/standoff/Cap/"],
  ["intigriti:04aab402-3eb7-41b8-b146-b9344efc89ce", "/p/intigriti/04aab402-3eb7-41b8-b146-b9344efc89ce/"],
];

describe("program paths match the pipeline", () => {
  for (const [id, page] of CASES) it(id, () => expect(programPaths(id).page).toBe(page));
  it("hashes unsafe handles like Python", async () => {
    const { execFileSync } = await import("node:child_process");
    const ids = ["cantina:Weird Handle/../x", "x:ünïcødé handle"];
    const py = execFileSync(
      "uv",
      [
        "run",
        "python",
        "-c",
        `from quarry_pipeline.site import program_path\nfor i in ${JSON.stringify(ids)}: print(program_path(i)[0])`,
      ],
      { cwd: `${__dirname}/../..` },
    )
      .toString()
      .trim()
      .split("\n");
    expect(ids.map((i) => programPaths(i).page)).toEqual(py);
  });
});
