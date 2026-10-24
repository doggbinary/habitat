import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { isLibrarySheet, librarySheetName, type LibraryEntry } from './src/library.ts';

/**
 * Serves the object pages from the tileset folders next to this project.
 * Ground and wall grids are not included. The pictures stay on this computer;
 * they are not part of the site build.
 */
function assetLibrary(): Plugin {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../tilesets');
  const routes = new Map<string, string>();
  const entries: LibraryEntry[] = [];

  const walk = (dir: string, folders: string[]) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), [...folders, entry.name]);
        continue;
      }
      if (!isLibrarySheet(folders, entry.name)) continue;
      const url = `library/${[...folders, entry.name].map(encodeURIComponent).join('/')}`;
      routes.set(`/${decodeURIComponent(url)}`, path.join(dir, entry.name));
      entries.push({ name: librarySheetName(folders, entry.name), url });
    }
  };

  if (fs.existsSync(root)) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(root, entry.name), [entry.name]);
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const manifest = JSON.stringify(entries);

  return {
    name: 'asset-library',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        let pathname = (req.url ?? '').split('?')[0];
        try {
          pathname = decodeURIComponent(pathname);
        } catch {
          next();
          return;
        }
        if (pathname === '/library/manifest.json') {
          res.setHeader('content-type', 'application/json');
          res.end(manifest);
          return;
        }
        const file = routes.get(pathname);
        if (!file) {
          next();
          return;
        }
        res.setHeader('content-type', 'image/png');
        res.setHeader('cache-control', 'public, max-age=86400');
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [assetLibrary()],
  base: './',
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
  },
  build: {
    target: 'es2020',
    assetsInlineLimit: 0,
  },
  test: {
    // The editing core is plain data and maths, so it runs in Node with no
    // browser at all. Anything that genuinely needs a canvas stays out of
    // these tests rather than being faked.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
