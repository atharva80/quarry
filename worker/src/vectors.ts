/**
 * Brute-force cosine search over a static int8 matrix (N x D, row-normalised before quantisation).
 *
 * File format (`/data/vectors.bin`, built by the pipeline):
 *   bytes 0..3   magic "QVEC"
 *   bytes 4..7   uint32 N (rows)       bytes 8..11 uint32 D (dims)
 *   then N float32 per-row scales, then N*D int8 values
 *   (rows are L2-normalised, then symmetric-quantised: q = round(x / maxabs_row * 127), scale = maxabs_row / 127)
 * Row ids are in `/data/vectors.ids.json` (same order).
 *
 * cosine(row, query) ~= (sum q_row * q_query) * scale_row * scale_query. The loss from int8 + 256 dims is
 * measured in evals/results (search eval: "float 768" vs "int8 256").
 */
export interface Matrix {
  n: number;
  d: number;
  scales: Float32Array;
  data: Int8Array;
  ids: string[];
}

export function parseMatrix(buf: ArrayBuffer, ids: string[]): Matrix {
  const head = new DataView(buf, 0, 12);
  const magic = String.fromCharCode(head.getUint8(0), head.getUint8(1), head.getUint8(2), head.getUint8(3));
  if (magic !== "QVEC") throw new Error("bad vector file");
  const n = head.getUint32(4, true);
  const d = head.getUint32(8, true);
  if (ids.length !== n) throw new Error(`ids (${ids.length}) != rows (${n})`);
  return { n, d, scales: new Float32Array(buf, 12, n), data: new Int8Array(buf, 12 + 4 * n, n * d), ids };
}

/** Quantise a float query to int8 after L2 normalisation (same scheme as the documents). */
export function quantiseQuery(q: ArrayLike<number>): { q: Int8Array; scale: number } {
  let norm = 0;
  for (let i = 0; i < q.length; i++) norm += q[i] * q[i];
  norm = Math.sqrt(norm) || 1;
  let maxAbs = 0;
  for (let i = 0; i < q.length; i++) maxAbs = Math.max(maxAbs, Math.abs(q[i] / norm));
  const out = new Int8Array(q.length);
  const s = maxAbs ? 127 / maxAbs : 0;
  for (let i = 0; i < q.length; i++) out[i] = Math.round((q[i] / norm) * s);
  return { q: out, scale: maxAbs / 127 };
}

/** Raw int8 dot products in plain JS (reference implementation; also used where WASM is unavailable). */
export function dotsJS(m: Matrix, q: Int8Array): Int32Array {
  const { n, d, data } = m;
  const out = new Int32Array(n);
  for (let r = 0; r < n; r++) {
    let s = 0;
    const off = r * d;
    for (let j = 0; j < d; j++) s += data[off + j] * q[j];
    out[r] = s;
  }
  return out;
}

interface DotKernel {
  mem: WebAssembly.Memory;
  dots: (mat: number, q: number, n: number, d: number, out: number) => void;
}

/**
 * The same dot products in WebAssembly SIMD (src/dot.wat). On the Free plan most requests land on isolates
 * whose JS hasn't been JIT-optimised yet; measured in M0 the JS loop cost p95 20 ms CPU, the WASM kernel is
 * compiled ahead of time (see docs/decisions.md, test a).
 */
export class WasmDots {
  private k: DotKernel;
  private qPtr = 0;
  private outPtr = 0;
  private matPtr = 0;
  private loadedFor: Matrix | null = null;

  constructor(module: WebAssembly.Module) {
    const inst = new WebAssembly.Instance(module, {});
    this.k = { mem: inst.exports.mem as WebAssembly.Memory, dots: inst.exports.dots as DotKernel["dots"] };
  }

  private load(m: Matrix) {
    const need = m.n * m.d + m.d + 4 * m.n + 64;
    const have = this.k.mem.buffer.byteLength;
    if (need > have) this.k.mem.grow(Math.ceil((need - have) / 65536));
    this.matPtr = 0;
    this.qPtr = m.n * m.d;
    this.outPtr = (this.qPtr + m.d + 15) & ~15;
    new Int8Array(this.k.mem.buffer, this.matPtr, m.n * m.d).set(m.data);
    this.loadedFor = m;
  }

  dots(m: Matrix, q: Int8Array): Int32Array {
    if (this.loadedFor !== m) this.load(m);
    new Int8Array(this.k.mem.buffer, this.qPtr, m.d).set(q);
    this.k.dots(this.matPtr, this.qPtr, m.n, m.d, this.outPtr);
    return new Int32Array(this.k.mem.buffer, this.outPtr, m.n);
  }
}

/** Top-k rows by cosine, from int8 dot products (WASM when given, else JS). */
export function topK(
  m: Matrix,
  query: { q: Int8Array; scale: number },
  k: number,
  allow?: (i: number) => boolean,
  kernel?: WasmDots,
): { i: number; score: number }[] {
  const { n, scales } = m;
  const raw = kernel ? kernel.dots(m, query.q) : dotsJS(m, query.q);
  const scores = new Float32Array(n);
  for (let r = 0; r < n; r++) scores[r] = raw[r] * scales[r];
  // partial selection: keep a small sorted buffer
  const best: { i: number; score: number }[] = [];
  let floor = -Infinity;
  for (let r = 0; r < n; r++) {
    const s = scores[r];
    if (best.length >= k && s <= floor) continue;
    if (allow && !allow(r)) continue;
    best.push({ i: r, score: s });
    if (best.length > k) {
      best.sort((a, b) => b.score - a.score);
      best.length = k;
      floor = best[k - 1].score;
    } else if (best.length === k) {
      best.sort((a, b) => b.score - a.score);
      floor = best[k - 1].score;
    }
  }
  best.sort((a, b) => b.score - a.score);
  return best.map((b) => ({ i: b.i, score: b.score * query.scale }));
}
