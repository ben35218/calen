// Generates householdcalendar.com's icon set from the app icon
// (mobile/assets/icon.png), so the favicon, touch icon and Open Graph card are
// literally the same artwork the App Store listing and home screen show.
//
//   node scripts/gen-web-icons.mjs      (or: npm run web:icons)
//
// Re-run it whenever the app icon or wordmark changes; the outputs are
// committed so the static site needs no build step. Pure Node (zlib only) —
// no ImageMagick/sharp dependency.
//
// Outputs into static/: favicon.ico (16/32/48), icon.svg, apple-touch-icon.png,
// icon-192.png, icon-512.png, og-image.png.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'static');

/* ---------- PNG decode ---------- */
function decodePng(file) {
  const buf = fs.readFileSync(file);
  let p = 8, w = 0, h = 0, bitDepth = 8, colorType = 6;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    }
    if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth} in ${file}`);
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!ch) throw new Error(`unsupported colour type ${colorType} in ${file}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const px = Buffer.alloc(h * stride);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[y * stride + x - ch] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= ch && y > 0 ? px[(y - 1) * stride + x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = v & 0xff;
    }
  }
  // normalise to RGBA
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const s = i * ch, d = i * 4;
    if (ch === 4) { rgba[d] = px[s]; rgba[d + 1] = px[s + 1]; rgba[d + 2] = px[s + 2]; rgba[d + 3] = px[s + 3]; }
    else if (ch === 3) { rgba[d] = px[s]; rgba[d + 1] = px[s + 1]; rgba[d + 2] = px[s + 2]; rgba[d + 3] = 255; }
    else if (ch === 2) { rgba[d] = rgba[d + 1] = rgba[d + 2] = px[s]; rgba[d + 3] = px[s + 1]; }
    else { rgba[d] = rgba[d + 1] = rgba[d + 2] = px[s]; rgba[d + 3] = 255; }
  }
  return { w, h, data: rgba };
}

/* ---------- PNG encode ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function encodePng({ w, h, data }, { opaque = false } = {}) {
  const ch = opaque ? 3 : 4;
  const stride = w * ch;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4, d = y * (stride + 1) + 1 + x * ch;
      raw[d] = data[s]; raw[d + 1] = data[s + 1]; raw[d + 2] = data[s + 2];
      if (!opaque) raw[d + 3] = data[s + 3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = opaque ? 2 : 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- resize (box filter, premultiplied) ---------- */
function resize(img, tw, th) {
  const out = Buffer.alloc(tw * th * 4);
  const sx = img.w / tw, sy = img.h / th;
  for (let y = 0; y < th; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.ceil((y + 1) * sy));
    for (let x = 0; x < tw; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.ceil((x + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < Math.min(y1, img.h); yy++) {
        for (let xx = x0; xx < Math.min(x1, img.w); xx++) {
          const s = (yy * img.w + xx) * 4, al = img.data[s + 3] / 255;
          r += img.data[s] * al; g += img.data[s + 1] * al; b += img.data[s + 2] * al;
          a += img.data[s + 3]; n++;
        }
      }
      const d = (y * tw + x) * 4;
      const am = a / n;
      const un = am > 0 ? 255 / a : 0;
      out[d] = Math.round(r * un); out[d + 1] = Math.round(g * un);
      out[d + 2] = Math.round(b * un); out[d + 3] = Math.round(am);
    }
  }
  return { w: tw, h: th, data: out };
}

/* ---------- squircle mask (Apple-style superellipse) ---------- */
function squircleAlpha(size, n = 5) {
  // 4x4 supersampled coverage of |x|^n + |y|^n <= 1 over the unit square.
  const a = new Float32Array(size * size);
  const S = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hit = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const u = ((x + (sx + 0.5) / S) / size) * 2 - 1;
          const v = ((y + (sy + 0.5) / S) / size) * 2 - 1;
          if (Math.abs(u) ** n + Math.abs(v) ** n <= 1) hit++;
        }
      }
      a[y * size + x] = hit / (S * S);
    }
  }
  return a;
}
function applySquircle(img) {
  const a = squircleAlpha(img.w);
  const out = Buffer.from(img.data);
  for (let i = 0; i < img.w * img.h; i++) out[i * 4 + 3] = Math.round(out[i * 4 + 3] * a[i]);
  return { w: img.w, h: img.h, data: out };
}

/* ---------- ICO ---------- */
function encodeIco(pngs) {
  const dir = Buffer.alloc(6 + 16 * pngs.length);
  dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(pngs.length, 4);
  let offset = dir.length;
  pngs.forEach(({ size, buf }, i) => {
    const e = 6 + i * 16;
    dir[e] = size >= 256 ? 0 : size;
    dir[e + 1] = size >= 256 ? 0 : size;
    dir[e + 2] = 0; dir[e + 3] = 0;
    dir.writeUInt16LE(1, e + 4); dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(buf.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += buf.length;
  });
  return Buffer.concat([dir, ...pngs.map((p) => p.buf)]);
}

/* ---------- contour trace → SVG path ---------- */
function traceGlyph(img) {
  const { w, h } = img;
  const on = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = img.data[i * 4], b = img.data[i * 4 + 2];
    on[i] = b - r > 40 ? 1 : 0;
  }
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : on[y * w + x]);
  const seen = new Uint8Array(w * h);
  const contours = [];
  // Moore-neighbour tracing, one contour per component (glyphs here have no holes).
  const NB = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!at(x, y) || seen[y * w + x]) continue;
      if (at(x, y - 1)) continue; // not a top edge
      const pts = [];
      // dir is the last step's direction; the backtrack is (dir+4)%8. Seeding
      // dir=2 (S) puts the backtrack due north — where we know there is no ink.
      let cx = x, cy = y, dir = 2;
      const startX = x, startY = y;
      let guard = 0;
      do {
        pts.push([cx, cy]);
        seen[cy * w + cx] = 1;
        let found = false;
        for (let k = 0; k < 8; k++) {
          const d = (dir + 5 + k) % 8; // start scanning from backtrack+1
          const nx = cx + NB[d][0], ny = cy + NB[d][1];
          if (at(nx, ny)) { cx = nx; cy = ny; dir = d; found = true; break; }
        }
        if (!found) break;
      } while ((cx !== startX || cy !== startY) && ++guard < w * h * 4);
      // flood the component so we don't restart inside it
      const stack = [[x, y]];
      while (stack.length) {
        const [px, py] = stack.pop();
        if (!at(px, py) || seen[py * w + px] === 2) continue;
        seen[py * w + px] = 2;
        stack.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]);
      }
      if (pts.length > 32) contours.push(pts);
    }
  }
  return contours;
}
function rdp(pts, eps) {
  if (pts.length < 3) return pts;
  const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1];
  let idx = -1, max = 0;
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / len;
    if (d > max) { max = d; idx = i; }
  }
  if (max <= eps) return [pts[0], pts[pts.length - 1]];
  return [...rdp(pts.slice(0, idx + 1), eps).slice(0, -1), ...rdp(pts.slice(idx), eps)];
}

/* ================= run ================= */
const icon = decodePng(path.join(ROOT, 'mobile/assets/icon.png'));
const wordmark = decodePng(path.join(ROOT, 'mobile/assets/calen-wordmark.png'));

// 1. Opaque square rasters — iOS masks apple-touch-icon itself; PWA icons stay square.
for (const [name, size] of [['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) {
  fs.writeFileSync(path.join(OUT, name), encodePng(resize(icon, size, size), { opaque: true }));
}
// 2. Rounded rasters for the browser tab (an app-shaped tab icon, not a white square).
const icoPngs = [16, 32, 48].map((size) => ({ size, buf: encodePng(applySquircle(resize(icon, size, size))) }));
fs.writeFileSync(path.join(OUT, 'favicon.ico'), encodeIco(icoPngs));

// 3. Vector favicon traced from the same artwork.
const contours = traceGlyph(icon);
const d = contours
  .map((c) => rdp(c, 1.6))
  .map((c) => 'M' + c.map(([x, y]) => `${x} ${y}`).join('L') + 'Z')
  .join('');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-label="Calen">
<defs>
<linearGradient id="b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#e7edf5"/></linearGradient>
<linearGradient id="g" x1="0" y1="0" x2="0" y2="1" gradientUnits="objectBoundingBox"><stop offset="0" stop-color="#61a1e7"/><stop offset="1" stop-color="#3d73b2"/></linearGradient>
</defs>
<rect width="1024" height="1024" rx="228" fill="url(#b)"/>
<path fill="url(#g)" d="${d}"/>
</svg>
`;
fs.writeFileSync(path.join(OUT, 'icon.svg'), svg);

// 4. Open Graph card: app icon + white wordmark on the brand gradient.
const OW = 1200, OH = 630;
const og = Buffer.alloc(OW * OH * 4);
for (let y = 0; y < OH; y++) {
  for (let x = 0; x < OW; x++) {
    const t = Math.min(1, Math.max(0, (x / OW) * 0.45 + (y / OH) * 0.55));
    const d0 = (y * OW + x) * 4;
    og[d0] = Math.round(0x63 + (0x3b - 0x63) * t);
    og[d0 + 1] = Math.round(0xa2 + (0x7f - 0xa2) * t);
    og[d0 + 2] = Math.round(0xe8 + (0xc9 - 0xe8) * t);
    og[d0 + 3] = 255;
  }
}
function blit(dst, dw, dh, src, ox, oy) {
  for (let y = 0; y < src.h; y++) {
    for (let x = 0; x < src.w; x++) {
      const px = ox + x, py = oy + y;
      if (px < 0 || py < 0 || px >= dw || py >= dh) continue;
      const s = (y * src.w + x) * 4, dd = (py * dw + px) * 4;
      const a = src.data[s + 3] / 255;
      if (a <= 0) continue;
      for (let k = 0; k < 3; k++) dst[dd + k] = Math.round(dst[dd + k] * (1 - a) + src.data[s + k] * a);
    }
  }
}
// crop the wordmark to its ink so the stack centres on the glyphs, not the canvas
let wx0 = wordmark.w, wx1 = 0, wy0 = wordmark.h, wy1 = 0;
for (let y = 0; y < wordmark.h; y++) {
  for (let x = 0; x < wordmark.w; x++) {
    if (wordmark.data[(y * wordmark.w + x) * 4 + 3] > 8) {
      if (x < wx0) wx0 = x; if (x > wx1) wx1 = x;
      if (y < wy0) wy0 = y; if (y > wy1) wy1 = y;
    }
  }
}
const cw = wx1 - wx0 + 1, chh = wy1 - wy0 + 1;
const cropped = { w: cw, h: chh, data: Buffer.alloc(cw * chh * 4) };
for (let y = 0; y < chh; y++) {
  wordmark.data.copy(cropped.data, y * cw * 4, ((y + wy0) * wordmark.w + wx0) * 4, ((y + wy0) * wordmark.w + wx1 + 1) * 4);
}
const mark = applySquircle(resize(icon, 200, 200));
const wmW = 440, wmH = Math.round((chh / cw) * wmW);
const wm = resize(cropped, wmW, wmH);
const gap = 56;
const totalH = mark.h + gap + wmH;
const top = Math.round((OH - totalH) / 2);
blit(og, OW, OH, mark, Math.round((OW - mark.w) / 2), top);
blit(og, OW, OH, wm, Math.round((OW - wmW) / 2), top + mark.h + gap);
fs.writeFileSync(path.join(OUT, 'og-image.png'), encodePng({ w: OW, h: OH, data: og }, { opaque: true }));

console.log('contours:', contours.map((c) => c.length), '→ path chars', d.length);
console.log('written:', fs.readdirSync(OUT).join(' '));
