/**
 * The App Store icon, drawn from the starter art: a house on grass with a
 * character at its door and trees around it. It is laid out on a 128 px
 * canvas and scaled 8x with no smoothing, so every art pixel is a crisp
 * block. 1024 x 1024 with no alpha channel, as Apple requires.
 *
 * Run with: npm run app-icon
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodeRgbPng } from './png.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const starter = path.join(root, 'public/starter/ninja-adventure');
const out = path.join(root, 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png');

const ground = decodePng(path.join(starter, 'ground.png'));
const houses = decodePng(path.join(starter, 'houses.png'));
const nature = decodePng(path.join(starter, 'nature.png'));
const boy = decodePng(path.join(starter, 'characters/boy.png'));

/** The plainest fully opaque green square on the ground page. */
function plainGrass() {
  let found = null;
  let best = Infinity;
  for (let ty = 0; ty < ground.height / 16; ty++) {
    for (let tx = 0; tx < ground.width / 16; tx++) {
      const px = [];
      let opaque = true;
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          const o = ((ty * 16 + y) * ground.width + tx * 16 + x) * 4;
          if (ground.data[o + 3] < 255) opaque = false;
          px.push([ground.data[o], ground.data[o + 1], ground.data[o + 2]]);
        }
      }
      const mean = [0, 1, 2].map((c) => px.reduce((s, p) => s + p[c], 0) / px.length);
      if (!opaque || mean[1] < mean[0] * 1.1 || mean[1] < mean[2] * 1.3) continue;
      const spread = px.reduce((s, p) => s + Math.abs(p[0] - mean[0]) + Math.abs(p[1] - mean[1]) + Math.abs(p[2] - mean[2]), 0);
      if (spread < best) {
        best = spread;
        found = { x: tx * 16, y: ty * 16 };
      }
    }
  }
  if (!found) throw new Error('No plain grass square on the ground page');
  return found;
}

const S = 128;
const canvas = new Float32Array(S * S * 3);
function blit(img, sx, sy, w, h, dx, dy) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const X = dx + x;
      const Y = dy + y;
      if (X < 0 || Y < 0 || X >= S || Y >= S) continue;
      const s = ((sy + y) * img.width + sx + x) * 4;
      const a = img.data[s + 3] / 255;
      if (a === 0) continue;
      const d = (Y * S + X) * 3;
      for (let c = 0; c < 3; c++) canvas[d + c] = img.data[s + c] * a + canvas[d + c] * (1 - a);
    }
  }
}

const grass = plainGrass();
for (let y = 0; y < S; y += 16) for (let x = 0; x < S; x += 16) blit(ground, grass.x, grass.y, 16, 16, x, y);
// Trees around the house, from the top row of the nature page.
blit(nature, 0, 0, 32, 32, -6, 20);
blit(nature, 32, 0, 32, 32, 102, 20);
blit(nature, 32, 0, 32, 32, -10, 76);
blit(nature, 0, 0, 32, 32, 106, 80);
// The first house on the houses page, 64 x 48, in the middle.
const hx = 32;
const hy = 36;
blit(houses, 0, 0, 64, 48, hx, hy);
// The boy's first frame, facing down, at the door, whose middle is 24 px in.
blit(boy, 0, 0, 16, 16, hx + 24 - 8, hy + 46);

const Z = 8;
const W = S * Z;
const rgb = new Uint8Array(W * W * 3);
for (let y = 0; y < W; y++) {
  for (let x = 0; x < W; x++) {
    const s = (((y / Z) | 0) * S + ((x / Z) | 0)) * 3;
    rgb.set([canvas[s], canvas[s + 1], canvas[s + 2]], (y * W + x) * 3);
  }
}
fs.writeFileSync(out, encodeRgbPng(W, W, rgb));
console.log(`wrote ${path.relative(root, out)} (${W}x${W}, no alpha)`);
