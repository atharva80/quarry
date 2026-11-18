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

/** Top-k rows by int8 dot product. O(N*D) integer multiply-adds; ~0.9M for 3.4k x 256. */
export function topK(
  m: Matrix,
  query: { q: Int8Array; scale: number },
  k: number,
  allow?: (i: number) => boolean,
): { i: number; score: number }[] {
  const { n, d, data, scales } = m;
  const q = query.q;
  const scores = new Float32Array(n);
  for (let r = 0; r < n; r++) {
    let s = 0;
    const off = r * d;
    for (let j = 0; j < d; j++) s += data[off + j] * q[j];
    scores[r] = s * scales[r];
  }
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
