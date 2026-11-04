// Adds the RPG Maker floor, roof and wall sheets in the local library to its
// manifest, so the full version builds them as connected terrain. Object
// pages already listed are left exactly as they are. The library itself is
// never committed: it is licensed for personal use and lives in
// public/library (or HABITAT_LIBRARY). The full version's server adds these
// pages by itself as it serves the manifest; this writes them into the file.
//
//   node scripts/add-terrain-pages.mjs
import fs from 'node:fs';
import path from 'node:path';
import { withTerrainPages } from './terrain-pages.mjs';

const root = process.env.HABITAT_LIBRARY
  ? path.resolve(process.env.HABITAT_LIBRARY)
  : path.resolve('public/library');
const manifestPath = path.join(root, 'manifest.json');

if (!fs.existsSync(root)) {
  console.error(`No library at ${root}. The full version keeps packs there, outside the published app.`);
  process.exit(1);
}

const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : [];
const { pages, added } = withTerrainPages(root, manifest);
fs.writeFileSync(manifestPath, JSON.stringify(pages));
console.log(`${root}: ${pages.length} pages, ${added} of them terrain.`);
