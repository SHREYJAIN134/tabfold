// Development helper: regenerates icons/icon-{16,32,48,128}.png. Not needed to run the extension (the PNGs are checked in).
//   node tools/make-icons.mjs
// Pure Node (zlib only): a charcoal rounded square with a lime folded-corner tab, drawn with 4x4 supersampling.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHARCOAL = [21, 23, 22];
const LIME = [200, 242, 58];
const LIME_DARK = [150, 190, 28];

const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const inTri = (x, y, a, b, c) => {
  const s = (p, q, r) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]);
  const p = [x, y];
  const d1 = s(p, a, b), d2 = s(p, b, c), d3 = s(p, c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};

/** Colour and coverage of one sample point in unit coordinates. */
function sample(x, y) {
  if (!inRoundRect(x, y, 0, 0, 1, 1, 0.22)) return null; // outside the icon
  const body = inRoundRect(x, y, 0.17, 0.35, 0.83, 0.80, 0.07);
  const tab = inRoundRect(x, y, 0.17, 0.20, 0.52, 0.45, 0.06);
  if (!(body || tab)) return CHARCOAL;
  // the folded corner: a corner of the body is cut away and a darker triangle is folded over it
  const cut = inTri(x, y, [0.60, 0.35], [0.84, 0.35], [0.84, 0.59]);
  const fold = inTri(x, y, [0.60, 0.35], [0.60, 0.59], [0.84, 0.59]);
  if (fold) return LIME_DARK;
  if (cut) return CHARCOAL;
  return LIME;
}

function render(size) {
  const SS = 4;
  const px = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sj = 0; sj < SS; sj++) for (let si = 0; si < SS; si++) {
      const c = sample((i + (si + 0.5) / SS) / size, (j + (sj + 0.5) / SS) / size);
      if (c) { r += c[0]; g += c[1]; b += c[2]; a += 1; }
    }
    const o = (j * size + i) * 4;
    if (a) { px[o] = Math.round(r / a); px[o + 1] = Math.round(g / a); px[o + 2] = Math.round(b / a); }
    px[o + 3] = Math.round((a / (SS * SS)) * 255);
  }
  return px;
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size) {
  const px = render(size);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
mkdirSync(out, { recursive: true });
for (const size of [16, 32, 48, 128]) { writeFileSync(join(out, `icon-${size}.png`), png(size)); console.log(`icons/icon-${size}.png`); }
