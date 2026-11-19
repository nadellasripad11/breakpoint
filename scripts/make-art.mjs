// Cuts the capybara + rock scenery out of the three reference mock-ups and "heals"
// every overlaid UI element (text, buttons, orbit lines, alert slashes) so the art
// can be used as clean background layers. Run: node scripts/make-art.mjs
import sharp from 'sharp';

const OUT = 'public/art';

async function load(n) {
  const { data, info } = await sharp(`art/${n}.webp`).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: Buffer.from(data), w: info.width, h: info.height };
}
const get = (im, x, y) => {
  const i = (y * im.w + x) * 3;
  return [im.data[i], im.data[i + 1], im.data[i + 2]];
};
const set = (im, x, y, c) => {
  const i = (y * im.w + x) * 3;
  im.data[i] = c[0]; im.data[i + 1] = c[1]; im.data[i + 2] = c[2];
};
// average of a few neighbouring pixels along x to dodge grain
const soft = (im, x, y) => {
  let r = 0, g = 0, b = 0, n = 0;
  for (let dx = -2; dx <= 2; dx++) {
    const xx = Math.min(im.w - 1, Math.max(0, x + dx));
    const [pr, pg, pb] = get(im, xx, y);
    r += pr; g += pg; b += pb; n++;
  }
  return [r / n, g / n, b / n];
};
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

/** vertical heal: columns x0..x1, rows y0..y1, interpolated between ref rows */
function healV(im, x0, x1, y0, y1, refTop, refBot) {
  for (let x = x0; x <= x1; x++) {
    const top = soft(im, x, refTop), bot = soft(im, x, refBot);
    for (let y = y0; y <= y1; y++) {
      const t = (y - refTop) / (refBot - refTop);
      set(im, x, y, mix(top, bot, t));
    }
  }
}
/** horizontal heal for one row: interpolate between xa and xb */
function healRow(im, y, xa, xb) {
  const L = get(im, Math.max(0, xa), y), R = get(im, Math.min(im.w - 1, xb), y);
  for (let x = xa + 1; x < xb; x++) set(im, x, y, mix(L, R, (x - xa) / (xb - xa)));
}
/** follow a polyline [[y, xCenter], ...] and heal +-hw px around it row by row */
function healLine(im, pts, hw, y0, y1) {
  for (let y = y0; y <= y1; y++) {
    let c = pts[0][1];
    for (let i = 0; i < pts.length - 1; i++) {
      const [ya, xa] = pts[i], [yb, xb] = pts[i + 1];
      if (y >= ya && y <= yb) c = xa + ((xb - xa) * (y - ya)) / (yb - ya);
      else if (y > yb && i === pts.length - 2) c = xb + ((xb - xa) / (yb - ya)) * (y - yb);
    }
    const x = Math.round(c);
    healRow(im, y, x - hw, x + hw);
  }
}

/** crop a region out of a raw image, returns RGBA raw buffer with feathered edges */
async function cropFeather(im, { x, y, w, h }, feather = {}) {
  const { top = 0, bottom = 0, left = 0, right = 0 } = feather;
  const rgb = await sharp(im.data, { raw: { width: im.w, height: im.h, channels: 3 } })
    .extract({ left: x, top: y, width: w, height: h })
    .toBuffer();
  const rgba = Buffer.alloc(w * h * 4);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const s = (j * w + i) * 3, d = (j * w + i) * 4;
      rgba[d] = rgb[s]; rgba[d + 1] = rgb[s + 1]; rgba[d + 2] = rgb[s + 2];
      let a = 1;
      if (top) a = Math.min(a, Math.min(1, j / top));
      if (bottom) a = Math.min(a, Math.min(1, (h - 1 - j) / bottom));
      if (left) a = Math.min(a, Math.min(1, i / left));
      if (right) a = Math.min(a, Math.min(1, (w - 1 - i) / right));
      a = a * a * (3 - 2 * a); // smoothstep
      rgba[d + 3] = Math.round(a * 255);
    }
  }
  return { data: rgba, w, h };
}
const toWebp = (img, name, q = 92) =>
  sharp(img.data, { raw: { width: img.w, height: img.h, channels: 4 } })
    .webp({ quality: q, alphaQuality: 100, effort: 6 })
    .toFile(`${OUT}/${name}`);

// ---------------------------------------------------------------- hero strip
{
  const im = await load(1);
  // CTA buttons + their glow (they overlap the top of the band)
  healV(im, 130, 724, 538, 622, 492, 626);
  // "Works with" row (text + 3 logos) -> sits over smooth sky
  healV(im, 138, 890, 622, 684, 619, 688);
  // alert slashes beside the capybara (re-drawn as animated SVG in the page)
  healV(im, 1459, 1522, 526, 586, 524, 588);
  // thin orbit arc that dips into the band
  healLine(im, [[538, 912], [550, 928], [560, 947], [570, 973.5], [580, 1003]], 9, 538, 590);
  const strip = await cropFeather(im, { x: 0, y: 538, w: 1672, h: 225 }, { top: 34 });
  await toWebp(strip, 'hero-landscape.webp');
}

// ----------------------------------------------------------------- cta strip
{
  const im = await load(3);
  // "Try Breakpoint" button + its glow
  healV(im, 540, 1124, 646, 782, 642, 786);
  // alert slashes
  healV(im, 1428, 1482, 650, 704, 647, 707);
  // closing ring running past the capybara's ear
  healLine(im, [[640, 1431], [700, 1428]], 6, 640, 697);
  // faint closing-ring lines on the left
  healLine(im, [[640, 242], [650, 246], [680, 258], [720, 280], [740, 293]], 8, 640, 745);
  healLine(im, [[640, 314], [650, 318.5], [680, 331], [700, 340]], 8, 640, 705);
  const strip = await cropFeather(im, { x: 0, y: 640, w: 1672, h: 301 }, { top: 40 });
  await toWebp(strip, 'cta-landscape.webp');
}

// ------------------------------------------------------------ light landscape
{
  const im = await load(2);
  // capybara alert slashes (re-drawn in SVG)
  healV(im, 204, 252, 700, 742, 697, 746);

  const W = 1672, H = 251, Y0 = 690;
  const bg = [251, 248, 242];
  const canvas = sharp({ create: { width: W, height: H, channels: 4, background: { r: bg[0], g: bg[1], b: bg[2], alpha: 0 } } });

  // stop short of the first card's border (x=332) and let the haze take over
  const left = await cropFeather(im, { x: 0, y: Y0, w: 322, h: H }, { top: 46, right: 34 });
  const strip = await cropFeather(im, { x: 0, y: 878, w: 1672, h: 63 }, { top: 40 });
  const right = await cropFeather(im, { x: 1612, y: 770, w: 60, h: 171 }, { top: 40, left: 20 });

  const png = (img) => sharp(img.data, { raw: { width: img.w, height: img.h, channels: 4 } }).png().toBuffer();
  const out = await canvas
    .composite([
      { input: await png(strip), left: 0, top: 878 - Y0 },
      { input: await png(right), left: 1612, top: 770 - Y0 },
      { input: await png(left), left: 0, top: 0 },
    ])
    .webp({ quality: 92, alphaQuality: 100, effort: 6 })
    .toFile(`${OUT}/light-landscape.webp`);
  console.log('light', out.width, out.height);
}

console.log('art done');
