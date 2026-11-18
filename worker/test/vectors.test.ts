import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dotsJS, type Matrix, quantiseQuery, topK, WasmDots } from "../src/vectors";

function randomMatrix(n: number, d: number, seed = 1): Matrix {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return (s / 0x7fffffff) * 2 - 1;
  };
  const data = new Int8Array(n * d);
  for (let i = 0; i < data.length; i++) data[i] = Math.round(rnd() * 127);
  const scales = new Float32Array(n).fill(1 / 127);
  return { n, d, data, scales, ids: Array.from({ length: n }, (_, i) => `p:${i}`) };
}

describe("vector search", () => {
  const wasm = new WebAssembly.Module(readFileSync(new URL("../src/dot.wasm", import.meta.url)));
  it("WASM SIMD dot products equal the JS reference", () => {
    const m = randomMatrix(500, 256);
    const q = quantiseQuery(Array.from({ length: 256 }, (_, i) => Math.sin(i))).q;
    const k = new WasmDots(wasm);
    expect(Array.from(k.dots(m, q))).toEqual(Array.from(dotsJS(m, q)));
  });
  it("topK returns the row itself first when querying with a row", () => {
    const m = randomMatrix(300, 256, 7);
    const row = Array.from(m.data.slice(42 * 256, 43 * 256));
    const res = topK(m, quantiseQuery(row), 5, undefined, new WasmDots(wasm));
    expect(res[0].i).toBe(42);
    expect(res[0].score).toBeGreaterThan(0.9);
    expect(res).toHaveLength(5);
  });
  it("respects the allow filter", () => {
    const m = randomMatrix(100, 256, 3);
    const res = topK(m, quantiseQuery(Array.from({ length: 256 }, () => 1)), 10, (i) => i % 2 === 0);
    expect(res.every((r) => r.i % 2 === 0)).toBe(true);
  });
});
