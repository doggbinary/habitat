import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * The full version: on this computer, `npm run full` also serves the bought
 * packs from a folder beside the project (or HABITAT_LIBRARY), at the same
 * `library/` address the app reads. They are licensed for your own use, so
 * they live outside the repo and never reach the website or the iPad app,
 * which carry only the starter pack.
 */
function localLibrary(): Plugin {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = path.resolve(process.env.HABITAT_LIBRARY ?? path.join(here, '../habitat-library'));
  const types: Record<string, string> = { '.png': 'image/png', '.json': 'application/json' };

  return {
    name: 'local-library',
    apply: 'serve',
    configureServer(server) {
      if (!fs.existsSync(dir)) {
        server.config.logger.info(`No library at ${dir}: running the app version, starter pack only.`);
        return;
      }
      server.config.logger.info(`Full version: serving your packs from ${dir}`);
      server.middlewares.use((req, res, next) => {
        let pathname = (req.url ?? '').split('?')[0];
        try {
          pathname = decodeURIComponent(pathname);
        } catch {
          next();
          return;
        }
        if (!pathname.startsWith('/library/')) {
          next();
          return;
        }
        const file = path.resolve(dir, pathname.slice('/library/'.length));
        // Nothing outside the library folder is ever served.
        if (!file.startsWith(dir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          next();
          return;
        }
        const type = types[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
        res.setHeader('content-type', type);
        // The list changes when packs are added; the pictures do not.
        res.setHeader('cache-control', type === 'application/json' ? 'no-cache' : 'public, max-age=86400');
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [localLibrary()],
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
