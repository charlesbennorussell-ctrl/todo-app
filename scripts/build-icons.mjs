// Regenerates every WEB icon from one source PNG, preserving transparency.
//
//   node scripts/build-icons.mjs <source.png>
//
// Then regenerate the desktop set from the same square master this writes:
//   npx tauri icon src-tauri/icons/icon-source-1024.png
//
// DO NOT run scripts/make-icon-transparent.mjs on the current artwork. That one
// punches out near-white pixels, which was right for a mark sitting on a white
// card and would erase most of a mark that IS near-white.
//
// Two framings come out of here, because they answer to different rules:
//   • normal   — content occupies ~86% of the tile, matching how the artwork was
//                composed (its own content-to-frame ratio is 87%).
//   • maskable — Android crops to an arbitrary shape and only guarantees the inner
//                80% CIRCLE. Content is scaled so its DIAGONAL fits that circle,
//                which is the only way a non-square mark survives every mask. It
//                therefore looks smaller, and that is correct, not a mistake.
// Both keep their alpha: the icons ship with no tile of their own, so each surface
// supplies its own ground (the manifest's background_color on Android, black on iOS,
// the page behind the favicon).

import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';

const [, , input] = process.argv;
if (!input) {
  console.error('usage: node scripts/build-icons.mjs <source.png>');
  process.exit(1);
}

const OUT = 'public/icons';

// Visible = alpha OR emitted light. This artwork is a glow render, so a few pixels
// carry colour where alpha has already fallen to zero; trimming on alpha alone would
// nick the bloom.
async function contentBox(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H } = info;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const vis = Math.max(data[i + 3], (data[i] + data[i + 1] + data[i + 2]) / 3);
      if (vis > 6) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** Trimmed content, centred on a transparent square whose side is `size`, occupying `fill`. */
async function frame(trimmed, box, size, fill) {
  const scale = (size * fill) / Math.max(box.width, box.height);
  const w = Math.max(1, Math.round(box.width * scale));
  const h = Math.max(1, Math.round(box.height * scale));
  const art = await sharp(trimmed)
    .resize(w, h, { kernel: 'lanczos3', fit: 'fill' })
    .toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: art, left: Math.round((size - w) / 2), top: Math.round((size - h) / 2) }])
    .png()
    .toBuffer();
}

const box = await contentBox(input);
const meta = await sharp(input).metadata();
console.log(`source ${meta.width}x${meta.height} — content ${box.width}x${box.height} at ${box.left},${box.top}`);

// Extract once; every output is framed from this, so the recentring happens exactly once.
const trimmed = await sharp(input).extract(box).png().toBuffer();

// Diagonal must fit the maskable safe circle (80% of the tile).
const diag = Math.hypot(box.width, box.height);
const MASKABLE_FILL = (0.8 * Math.max(box.width, box.height)) / diag;
const NORMAL_FILL = 0.86;
console.log(`normal fill ${(NORMAL_FILL * 100).toFixed(0)}%, maskable fill ${(MASKABLE_FILL * 100).toFixed(1)}% (diagonal inside the 80% safe circle)`);

await mkdir(OUT, { recursive: true });

const jobs = [
  ['icon-512.png', 512, NORMAL_FILL],
  ['icon-192.png', 192, NORMAL_FILL],
  ['icon-maskable-512.png', 512, MASKABLE_FILL],
  ['icon-maskable-192.png', 192, MASKABLE_FILL],
  // iOS flattens any alpha to BLACK behind the home-screen icon, which suits a mark
  // built to glow on a dark ground — but it means the tile is black, not the page colour.
  ['apple-touch-icon.png', 180, NORMAL_FILL],
  ['favicon-32.png', 32, NORMAL_FILL],
  ['favicon-16.png', 16, NORMAL_FILL],
  // Square master for `tauri icon`, which wants one large square source. Written
  // beside the desktop icons rather than into public/, so it is not served to the web.
  ['../../src-tauri/icons/icon-source-1024.png', 1024, NORMAL_FILL],
];

for (const [name, size, fill] of jobs) {
  const buf = await frame(trimmed, box, size, fill);
  await sharp(buf).png({ compressionLevel: 9 }).toFile(`${OUT}/${name}`);
  console.log(`  ${name.padEnd(24)} ${size}x${size}`);
}

console.log('\nwrote web icons. Next:');
console.log('  npx tauri icon src-tauri/icons/icon-source-1024.png');
