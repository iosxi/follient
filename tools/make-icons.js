/**
 * アイコン生成スクリプト (依存なし)。
 *   node tools/make-icons.js
 * 角丸の背景に、白いフォルダのグリフを描いた PNG を書き出す。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function srgb(n) {
  return Math.max(0, Math.min(255, Math.round(n)));
}

/** 矩形の内側判定 (角丸つき)。距離を返してアンチエイリアスに使う。 */
function roundedRectCoverage(x, y, left, top, right, bottom, radius) {
  // 中心をコーナー円の中心へ寄せて距離を測る
  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  const dx = x - cx;
  const dy = y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (x < left || x > right || y < top || y > bottom) return 0;
  return Math.max(0, Math.min(1, radius - dist + 0.5));
}

function renderIcon(size) {
  const SS = 4; // スーパーサンプリング
  const W = size * SS;
  const pixels = new Float64Array(W * W * 4);

  const bgRadius = W * 0.22;

  for (let y = 0; y < W; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 4;
      const bg = roundedRectCoverage(x + 0.5, y + 0.5, 0, 0, W, W, bgRadius);
      if (bg <= 0) continue;

      // 斜めのグラデーション (紫 -> 青)
      const t = (x / W) * 0.55 + (y / W) * 0.45;
      pixels[i] = 122 + (74 - 122) * t;
      pixels[i + 1] = 96 + (93 - 96) * t;
      pixels[i + 2] = 249 + (249 - 249) * t;
      pixels[i + 3] = bg * 255;
    }
  }

  // フォルダのグリフ (白)
  const m = W * 0.22; // 余白
  const bodyTop = W * 0.38;
  const bodyBottom = W - m;
  const left = m;
  const right = W - m;
  const glyphRadius = W * 0.05;

  const tabRight = left + (right - left) * 0.46;
  const tabTop = W * 0.27;

  for (let y = 0; y < W; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const body = roundedRectCoverage(px, py, left, bodyTop, right, bodyBottom, glyphRadius);
      const tab = roundedRectCoverage(px, py, left, tabTop, tabRight, bodyTop + glyphRadius, glyphRadius);
      const cover = Math.max(body, tab);
      if (cover <= 0) continue;

      const i = (y * W + x) * 4;
      const a = cover;
      pixels[i] = pixels[i] * (1 - a) + 255 * a;
      pixels[i + 1] = pixels[i + 1] * (1 - a) + 255 * a;
      pixels[i + 2] = pixels[i + 2] * (1 - a) + 255 * a;
      pixels[i + 3] = Math.max(pixels[i + 3], a * 255);
    }
  }

  // ダウンサンプル
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const i = ((y * SS + sy) * W + (x * SS + sx)) * 4;
          const pa = pixels[i + 3] / 255;
          r += pixels[i] * pa;
          g += pixels[i + 1] * pa;
          b += pixels[i + 2] * pa;
          a += pa;
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      out[o] = srgb(a > 0 ? r / a : 0);
      out[o + 1] = srgb(a > 0 ? g / a : 0);
      out[o + 2] = srgb(a > 0 ? b / a : 0);
      out[o + 3] = srgb((a / n) * 255);
    }
  }
  return out;
}

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function toPng(rgba, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = path.join(__dirname, '..', 'src', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [48, 96]) {
  const file = path.join(outDir, 'icon-' + size + '.png');
  fs.writeFileSync(file, toPng(renderIcon(size), size));
  console.log('wrote', file);
}
