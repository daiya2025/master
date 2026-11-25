// Generates build/icon.png (256x256) and build/icon.ico (PNG-compressed) without external tools.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const SIZE = 256;
const px = new Uint8Array(SIZE * SIZE * 4);
const set = (x, y, r, g, b, a = 255) => {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  // alpha blend over existing
  const da = px[i + 3] / 255;
  const sa = a / 255;
  const oa = sa + da * (1 - sa);
  px[i] = Math.round((r * sa + px[i] * da * (1 - sa)) / (oa || 1));
  px[i + 1] = Math.round((g * sa + px[i + 1] * da * (1 - sa)) / (oa || 1));
  px[i + 2] = Math.round((b * sa + px[i + 2] * da * (1 - sa)) / (oa || 1));
  px[i + 3] = Math.round(oa * 255);
};
const smooth = (d) => Math.max(0, Math.min(1, 0.5 - d)); // 1px anti-alias
// Rounded dark square
const R = 56;
for (let y = 0; y < SIZE; y++)
  for (let x = 0; x < SIZE; x++) {
    const cx = Math.max(R, Math.min(SIZE - R, x + 0.5));
    const cy = Math.max(R, Math.min(SIZE - R, y + 0.5));
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - R;
    const a = smooth(d);
    if (a > 0) {
      const t = y / SIZE;
      set(x, y, Math.round(30 + 10 * t), Math.round(31 + 12 * t), Math.round(38 + 30 * t), Math.round(255 * a));
    }
  }
// Ink drop: a big circle with a brush-like tail (墨)
const ink = (cx, cy, r, color) => {
  for (let y = Math.floor(cy - r - 2); y <= cy + r + 2; y++)
    for (let x = Math.floor(cx - r - 2); x <= cx + r + 2; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - r;
      const a = smooth(d);
      if (a > 0) set(x, y, ...color, Math.round(255 * a));
    }
};
const paper = [244, 240, 228];
ink(128, 140, 62, paper);
for (let i = 0; i < 40; i++) ink(128 + i * 1.6, 78 - i * 1.1, 14 - i * 0.3, paper);
// Cursor block in the accent color
for (let y = 118; y < 162; y++) for (let x = 112; x < 144; x++) set(x, y, 228, 166, 87, 255);
// A couple of "text lines" to the left of the cursor
for (let y = 124; y < 130; y++) for (let x = 84; x < 108; x++) set(x, y, 30, 31, 38, 255);
for (let y = 136; y < 142; y++) for (let x = 84; x < 108; x++) set(x, y, 30, 31, 38, 255);

// --- PNG encode
const crcTable = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
mkdirSync("build", { recursive: true });
writeFileSync("build/icon.png", png);

// --- ICO with a single PNG entry (Windows Vista+ supports PNG-compressed 256x256 icons)
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
const entry = Buffer.alloc(16);
entry[0] = 0; entry[1] = 0; // 256 encoded as 0
entry[2] = 0; entry[3] = 0;
entry.writeUInt16LE(1, 4);
entry.writeUInt16LE(32, 6);
entry.writeUInt32LE(png.length, 8);
entry.writeUInt32LE(22, 12);
writeFileSync("build/icon.ico", Buffer.concat([header, entry, png]));
console.log("wrote build/icon.png and build/icon.ico");
