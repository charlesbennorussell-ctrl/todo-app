// Reads a source PNG, makes near-white pixels (R>240, G>240, B>240) fully
// transparent, and writes the result. Used once to clean the corners of the
// app icon (the rounded square sits on a white background in the source —
// platform icon files inherit those white corners as opaque blocks unless we
// strip them first). After running this, re-run `npm run tauri:icon ...` to
// regenerate all the platform-specific files from the cleaned PNG.
//
// Usage:  node scripts/make-icon-transparent.mjs <input.png> <output.png>

import sharp from 'sharp';

const [, , input, output] = process.argv;
if (!input || !output) {
  console.error('usage: node scripts/make-icon-transparent.mjs <input.png> <output.png>');
  process.exit(1);
}

const meta = await sharp(input).metadata();
const { width, height } = meta;
if (!width || !height) {
  console.error('Could not read input dimensions.');
  process.exit(1);
}

// ensureAlpha() guarantees a 4-channel buffer even if the source was RGB.
// raw().toBuffer() gives us the pixels as a flat Uint8 array (RGBA × W × H).
const pixels = await sharp(input).ensureAlpha().raw().toBuffer();

let stripped = 0;
for (let i = 0; i < pixels.length; i += 4) {
  const r = pixels[i];
  const g = pixels[i + 1];
  const b = pixels[i + 2];
  // Anything that's nearly pure white becomes transparent. Threshold is
  // generous so JPEG-style anti-aliasing fringe gets caught too.
  if (r > 240 && g > 240 && b > 240) {
    pixels[i + 3] = 0;
    stripped++;
  }
}

await sharp(pixels, { raw: { width, height, channels: 4 } })
  .png()
  .toFile(output);

console.log(`Wrote ${output} — made ${stripped.toLocaleString()} pixels transparent (of ${(width * height).toLocaleString()} total).`);
