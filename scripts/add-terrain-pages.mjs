// Adds the RPG Maker floor, roof and wall sheets in the local library to its
// manifest, so the full version builds them as connected terrain. Object
// pages already listed are left exactly as they are. The library itself is
// never committed: it is licensed for personal use and lives in
// public/library (or HABITAT_LIBRARY).
//
//   node scripts/add-terrain-pages.mjs
import fs from 'node:fs';
import path from 'node:path';

const root = process.env.HABITAT_LIBRARY
  ? path.resolve(process.env.HABITAT_LIBRARY)
  : path.resolve('public/library');
const manifestPath = path.join(root, 'manifest.json');

if (!fs.existsSync(root)) {
  console.error(`No library at ${root}. The full version keeps packs there, outside the published app.`);
  process.exit(1);
}

const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : [];

const pngs = [];
const walk = (dir) => {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full);
    else if (name.toLowerCase().endsWith('.png')) pngs.push(path.relative(root, full));
  }
};
walk(root);

const terrain = /(?:^|[^a-z0-9])a([1-5])(?:[^0-9]|$)/i;
const kinds = { 1: 'Water', 2: 'Floors', 3: 'Roofs', 4: 'Walls', 5: 'Tiles' };
// Terrain pages are listed afresh each run, so renamed or removed sheets never linger.
const pages = manifest.filter((entry) => !entry.terrain);
const found = [];
for (const file of pngs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
  const base = path.basename(file, path.extname(file));
  const match = terrain.exec(base);
  if (!match || listedObject(file)) continue;
  if (file.split(path.sep).some((part) => /\(\d+\)$/.test(part))) continue;
  found.push({ file, kind: kinds[match[1]] });
}
// "Autumn Forest — Floors 1": the pack name first, so the page sits with its pack.
const counts = new Map();
for (const { file, kind } of found) {
  const pack = path.dirname(file).split(path.sep).filter((part) => part && part !== '.').join(' ');
  const key = `${pack}|${kind}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
const seen = new Map();
let added = 0;
for (const { file, kind } of found) {
  const pack = path.dirname(file).split(path.sep).filter((part) => part && part !== '.').join(' ');
  const key = `${pack}|${kind}`;
  const n = (seen.get(key) ?? 0) + 1;
  seen.set(key, n);
  const page = counts.get(key) > 1 ? `${kind} ${n}` : kind;
  pages.push({
    name: pack ? `${pack} — ${page}` : page,
    url: `library/${file.split(path.sep).map(encodeURIComponent).join('/')}`,
    terrain: true,
  });
  added += 1;
}

function listedObject(file) {
  return manifest.some((entry) => !entry.terrain && decodeURIComponent(entry.url.replace(/^library\//, '')) === file);
}

pages.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
fs.writeFileSync(manifestPath, JSON.stringify(pages));
console.log(`${root}: ${pages.length} pages, ${added} of them terrain.`);
