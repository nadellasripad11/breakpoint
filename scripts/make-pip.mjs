// builds the onboarding art from the generated pip render (art/pip/*.png, git-ignored: 6mb each)
//   pip-cutout.webp  – background-removed capybara for the welcome screen
//   pip-photo.webp   – head-and-shoulders crop used inside the polaroid
//   ob-rocks.webp    – mossy rock strip (mirrored from the landing page scenery)
import sharp from 'sharp';

const OUT = 'public/art';

// 1 · cutout: trim to the capybara, keep a little air for the soft edge
await sharp('art/pip/pip-cutout.png')
  .extract({ left: 900, top: 120, width: 1110, height: 1226 })
  .webp({ quality: 92, alphaQuality: 100, effort: 6 })
  .toFile(`${OUT}/pip-cutout.webp`);

// 2 · polaroid photo: the original dark-background render, cropped to head + chest
await sharp('art/pip/pip-upscaled.png')
  .extract({ left: 880, top: 90, width: 1060, height: 1010 })
  .sharpen({ sigma: 0.6, m1: 0.5, m2: 1 })
  .webp({ quality: 90, effort: 6 })
  .toFile(`${OUT}/pip-photo.webp`);

// 3 · rocks: left part of the closing-section strip (no capybara) + its mirror, so it spans any width
const src = sharp(`${OUT}/cta-landscape.webp`);
const meta = await src.metadata(); // 3344 x 602 (2x)
const cropW = 1400; // 700px of the 1x scenery, ending in the low mossy valley so the mirror seam is a dip, not a peak
const left = await sharp(`${OUT}/cta-landscape.webp`).extract({ left: 0, top: 0, width: cropW, height: meta.height }).png().toBuffer();
const right = await sharp(left).flop().png().toBuffer();
await sharp({ create: { width: cropW * 2, height: meta.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: left, left: 0, top: 0 }, { input: right, left: cropW, top: 0 }])
  .webp({ quality: 88, alphaQuality: 100, effort: 6 })
  .toFile(`${OUT}/ob-rocks.webp`);

console.log('pip art done');
