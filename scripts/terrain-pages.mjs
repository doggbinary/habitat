// Lists the RPG Maker floor, roof and wall sheets in a library folder as
// terrain pages beside the object pages its manifest already has. Shared by
// scripts/add-terrain-pages.mjs, which writes the result back, and the full
// version's server, which adds them as it serves the manifest so a library
// copied in from elsewhere needs no extra step.
import fs from 'node:fs';
import path from 'node:path';

const terrain = /(?:^|[^a-z0-9])a([1-5])(?:[^0-9]|$)/i;
const kinds = { 1: 'Water', 2: 'Floors', 3: 'Roofs', 4: 'Walls', 5: 'Tiles' };

/** The manifest's object pages, untouched, plus one terrain page per A-sheet, sorted by name. */
export function withTerrainPages(root, manifest) {
  const pngs = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (name.toLowerCase().endsWith('.png')) pngs.push(path.relative(root, full));
    }
  };
  walk(root);

  const listedObject = (file) =>
    manifest.some((entry) => !entry.terrain && decodeURIComponent(entry.url.replace(/^library\//, '')) === file);
  // Terrain pages are listed afresh each time, so renamed or removed sheets never linger.
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
  const packOf = (file) => path.dirname(file).split(path.sep).filter((part) => part && part !== '.').join(' ');
  const counts = new Map();
  for (const { file, kind } of found) {
    const key = `${packOf(file)}|${kind}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const seen = new Map();
  for (const { file, kind } of found) {
    const pack = packOf(file);
    const key = `${pack}|${kind}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    const page = counts.get(key) > 1 ? `${kind} ${n}` : kind;
    pages.push({
      name: pack ? `${pack} — ${page}` : page,
      url: `library/${file.split(path.sep).map(encodeURIComponent).join('/')}`,
      terrain: true,
    });
  }
  pages.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { pages, added: found.length };
}
