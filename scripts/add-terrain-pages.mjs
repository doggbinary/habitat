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
const listed = new Set(manifest.map((entry) => decodeURIComponent(entry.url.replace(/^library\//, ''))));

const pngs = [];
const walk = (dir) => {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full);
    else if (name.toLowerCase().endsWith('.png')) pngs.push(path.relative(root, full));
  }
};
walk(root);

const terrain = /(?:^|[^a-z0-9])a[1-5](?:[^0-9]|$)/i;
let added = 0;
for (const file of pngs.sort()) {
  if (listed.has(file)) continue;
  const base = path.basename(file, path.extname(file));
  if (!terrain.test(base)) continue;
  if (file.split(path.sep).some((part) => /\(\d+\)$/.test(part))) continue;
  const folders = path.dirname(file).split(path.sep).filter((part) => part && part !== '.');
  manifest.push({
    name: `${folders.join(' ')} ${base}`.trim(),
    url: `library/${file.split(path.sep).map(encodeURIComponent).join('/')}`,
    terrain: true,
  });
  added += 1;
}

manifest.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
fs.writeFileSync(manifestPath, JSON.stringify(manifest));
console.log(`${root}: ${manifest.length} pages, ${added} terrain sheets added.`);
