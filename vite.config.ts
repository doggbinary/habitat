import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import { configFromEnv, createVisionClient, VisionError, type VisionRequest } from './src/ai/vision';

/**
 * The full version: on this computer, `npm run full` builds the app once and
 * serves that build, which never reloads the page while you work, and also
 * serves the bought packs from a folder beside the project (or
 * HABITAT_LIBRARY), at the same `library/` address the app reads. They are
 * licensed for your own use, so they live outside the repo and never reach
 * the website or the iPad app, which carry only the starter pack.
 */
function localLibrary(): Plugin {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = path.resolve(process.env.HABITAT_LIBRARY ?? path.join(here, '../habitat-library'));
  const types: Record<string, string> = { '.png': 'image/png', '.json': 'application/json' };

  type Server = Parameters<NonNullable<Plugin['configurePreviewServer']>>[0];
  const serveLibrary = (server: Server) => {
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
  };

  return {
    name: 'local-library',
    // The dev server, for working on the app, and the built copy that
    // `npm run full` serves, which never reloads the page on its own.
    configureServer: serveLibrary,
    configurePreviewServer: serveLibrary,
  };
}

/**
 * AI Extract's model access for `npm run dev` and `npm run full`: the key
 * stays in this server's environment (or .env.local) and the page only ever
 * talks to /api/vision. The provider is picked by HABITAT_VISION_PROVIDER,
 * or by whichever of OPENAI_API_KEY, ANTHROPIC_API_KEY or GEMINI_API_KEY is
 * set; HABITAT_VISION_MODEL picks the model.
 */
function visionProxy(env: Record<string, string | undefined>): Plugin {
  type Server = Parameters<NonNullable<Plugin['configurePreviewServer']>>[0];
  const send = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(body));
  };
  const serve = (server: Server) => {
    server.middlewares.use(async (req, res, next) => {
      const pathname = (req.url ?? '').split('?')[0];
      if (!pathname.endsWith('/api/vision/status') && !pathname.endsWith('/api/vision/complete')) {
        next();
        return;
      }
      let config;
      try {
        config = configFromEnv(env);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (pathname.endsWith('/status')) send(res, 200, { available: false, error: message });
        else send(res, 503, { code: 'no-key', error: { message } });
        return;
      }
      if (pathname.endsWith('/status')) {
        send(res, 200, { available: true, provider: config.provider, model: config.model });
        return;
      }
      if (req.method !== 'POST') {
        send(res, 405, { error: { message: 'POST only' } });
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          request: Omit<VisionRequest, 'images'> & { images: { label: string; png: string }[] };
        };
        const request: VisionRequest = {
          ...body.request,
          images: body.request.images.map((img) => ({ label: img.label, png: new Uint8Array(Buffer.from(img.png, 'base64')) })),
        };
        const text = await createVisionClient(config).complete(request);
        send(res, 200, { text });
      } catch (error) {
        const code = error instanceof VisionError ? error.code : 'http';
        const status = code === 'auth' ? 401 : code === 'no-key' ? 503 : 502;
        send(res, status, { code, error: { message: error instanceof Error ? error.message : String(error) } });
      }
    });
  };
  return { name: 'vision-proxy', configureServer: serve, configurePreviewServer: serve };
}

export default defineConfig(({ mode }) => ({
  plugins: [localLibrary(), visionProxy({ ...loadEnv(mode, process.cwd(), ''), ...process.env })],
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
}));
