// Generates icons/icon{16,32,48,128}.png: a dark terminal tile split into
// panes with a green tmux status line. No dependencies (zlib + hand-rolled PNG).

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
type Rgb = readonly [r: number, g: number, b: number];
type Rgba = readonly [r: number, g: number, b: number, a: number];
type PixelFn = (x: number, y: number, s: number) => Rgba;

const crc32 = (buf: Uint8Array): number => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function png(size: number, pixel: PixelFn): Buffer {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5, size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const BG: Rgb = [24, 24, 27];
const PANE: Rgb = [40, 42, 54];
const GREEN: Rgb = [80, 250, 123];
const BORDER: Rgb = [98, 114, 164];

function pixel(x: number, y: number, s: number): Rgba {
  const u = x / s, v = y / s;
  // Rounded-square mask.
  const r = 0.18, cx = Math.min(Math.max(u, r), 1 - r), cy = Math.min(Math.max(v, r), 1 - r);
  const d = Math.hypot(u - cx, v - cy);
  const edge = 1 / s;
  const alpha = Math.max(0, Math.min(1, (r - d) / edge + 0.5));
  if (alpha <= 0) return [0, 0, 0, 0];
  const a = Math.round(alpha * 255);
  const pad = 0.12, bar = 0.2;
  const line = Math.max(1 / s, 0.04);
  let c: Rgb = BG;
  if (v > 1 - pad - bar && v < 1 - pad && u > pad && u < 1 - pad) c = GREEN; // status line
  else if (u > pad && u < 1 - pad && v > pad && v < 1 - pad - bar - line) {
    c = PANE;
    if (Math.abs(u - 0.5) < line / 2) c = BORDER; // vertical split
    if (u > 0.5 && Math.abs(v - (pad + (1 - 2 * pad - bar - line) / 2)) < line / 2) c = BORDER; // horizontal split
  }
  return [...c, a];
}

mkdirSync(join(root, 'icons'), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(root, 'icons', `icon${size}.png`), png(size, pixel));
}
console.log('icons written');
