// The iPad app ships only the starter pack. The wider library in
// public/library is for the web copy; those packs are licensed for use, not
// for passing on inside the app, so they are taken out of the native build.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
for (const name of ['library', 'maps', 'sw.js']) {
  fs.rmSync(path.join(dist, name), { recursive: true, force: true });
}
console.log('Native build: starter pack only');
