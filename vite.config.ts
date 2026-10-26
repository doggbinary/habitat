import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { buildLibraryEntries, isLibrarySheet, libraryUrl, type LibraryFile } from './src/library.ts';

/**
 * Serves the object pages from the tileset folders next to this project.
 * Ground and wall grids are not included. The pictures stay on this computer;
 * they are not part of the site build.
 */
function assetLibrary(): Plugin {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../tilesets');
  const routes = new Map<string, string>();
  const found: LibraryFile[] = [];
  const located = new Map<string, string>();

  interface PackInfo {
    tile?: number;
    props?: string[];
    assets?: Record<string, { x: number; y: number; w: number; h: number }[]>;
  }

  const walk = (dir: string, folders: string[], pack: PackInfo) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), [...folders, entry.name], pack);
        continue;
      }
      if (!isLibrarySheet(folders, entry.name)) continue;
      const abs = path.join(dir, entry.name);
      const props = pack.props?.includes(entry.name) ?? false;
      const assets = pack.assets?.[entry.name];
      found.push({ folders, file: entry.name, tile: pack.tile, ...(props ? { props } : {}), ...(assets ? { assets } : {}) });
      located.set(libraryUrl(folders, entry.name), abs);
    }
  };

  // A pack that is not 48 px squares, or has pages of whole objects only,
  // says so in a pack.json beside its pages: { "tile": 32, "props": ["4.png"] }.
  const packInfo = (dir: string): PackInfo => {
    const file = path.join(dir, 'pack.json');
    if (!fs.existsSync(file)) return {};
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as PackInfo;
      return {
        tile: typeof raw.tile === 'number' && raw.tile > 0 ? raw.tile : undefined,
        props: Array.isArray(raw.props) ? raw.props.filter((name) => typeof name === 'string') : undefined,
        assets: raw.assets && typeof raw.assets === 'object' ? raw.assets : undefined,
      };
    } catch {
      return {};
    }
  };

  if (fs.existsSync(root)) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      walk(dir, [entry.name], packInfo(dir));
    }
  }
  const entries = buildLibraryEntries(found);
  for (const entry of entries) {
    const file = located.get(entry.url);
    if (file) routes.set(`/${decodeURIComponent(entry.url)}`, file);
  }
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
