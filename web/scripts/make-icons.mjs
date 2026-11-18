// Generates the PWA icons into web/public using only Node built-ins. Run: node web/scripts/make-icons.mjs
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const out = (f) => fileURLToPath(new URL(`../public/${f}`, import.meta.url));
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};

const BG = [11, 92, 173];
const FG = [255, 255, 255];

// A "Q": ring plus a diagonal tail, antialiased by 3x3 supersampling.
function pixel(x, y, s) {
  const cx = s / 2, cy = s / 2;
  const R = s * 0.3, r = s * 0.19;
  const dx = x - cx, dy = y - cy;
  const d = Math.hypot(dx, dy);
  if (d <= R && d >= r) return true;
  // tail: segment from (0.55,0.55) to (0.76,0.76) of the canvas, thickness 0.075s
  const ax = s * 0.54, ay = s * 0.54, bx = s * 0.78, by = s * 0.78;
  const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
  return Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay))) <= s * 0.04;
}

function png(size) {
  const rows = [];
  const corner = size * 0.18;
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      let cover = 0;
      for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) if (pixel(x + (sx + 0.5) / 3, y + (sy + 0.5) / 3, size)) cover++;
      const k = cover / 9;
      // rounded-corner alpha
      const ex = Math.max(corner - x - 0.5, 0, x + 0.5 - (size - corner));
      const ey = Math.max(corner - y - 0.5, 0, y + 0.5 - (size - corner));
      const a = Math.hypot(ex, ey) > corner ? 0 : 255;
      const o = 1 + x * 4;
      for (let i = 0; i < 3; i++) row[o + i] = Math.round(BG[i] * (1 - k) + FG[i] * k);
      row[o + 3] = a;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

writeFileSync(out("icon-192.png"), png(192));
writeFileSync(out("icon-512.png"), png(512));
writeFileSync(out("apple-touch-icon.png"), png(180));
const p32 = png(32);
const ico = Buffer.alloc(22);
ico.writeUInt16LE(1, 2);
ico.writeUInt16LE(1, 4);
ico[6] = 32;
ico[7] = 32;
ico.writeUInt16LE(1, 10);
ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(p32.length, 14);
ico.writeUInt32LE(22, 18);
writeFileSync(out("favicon.ico"), Buffer.concat([ico, p32]));
