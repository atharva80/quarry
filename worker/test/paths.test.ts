import { describe, expect, it } from "vitest";
import { programPaths } from "../src/paths";

// Expected values were computed by pipeline/src/quarry_pipeline/site.py program_path (Python), so both sides agree.
const CASES: [string, string][] = [
  ["h1:gitlab", "/p/h1/gitlab/"],
  ["standoff:Cap", "/p/standoff/Cap/"],
  ["intigriti:04aab402-3eb7-41b8-b146-b9344efc89ce", "/p/intigriti/04aab402-3eb7-41b8-b146-b9344efc89ce/"],
  ...([
    ["cantina:Weird Handle/../x", "/p/cantina/Weird-Handle---x-83517/"],
    ["x:\u00fcn\u00efc\u00f8d\u00e9 handle", "/p/x/n-c-d-handle-48945/"],
  ] as [string, string][]),
];

describe("program paths match the pipeline", () => {
  for (const [id, page] of CASES) it(id, () => expect(programPaths(id).page).toBe(page));
});
