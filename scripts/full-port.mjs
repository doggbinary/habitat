// `npm run full` serves the built app on port 5173 so the iPad address stays
// put. That port is often already taken: a previous double-click still
// running, the dev server, or Windows holding the port with nothing you can
// close. Vite's strict port mode then prints a stack trace into the
// double-click window. These helpers decide what to do instead.
import { createServer } from 'node:net';

export const FULL_PORT = 5173;

/** Title in index.html. An em dash, matching the page itself. */
const APP_MARKER = 'Habitat — Pixel World Editor';
/** The source entry the dev server leaves in the page. */
const DEV_MARKER = '/src/main.ts';
/** The built script name Vite writes into dist/index.html. */
const PREVIEW_MARKER = 'assets/index-';

/**
 * What answered on the port, from the HTML it returned.
 * `dev` is `npm run dev`. `preview` is the built app `npm run full` serves.
 * `other` answered, but it is not this app.
 */
export function classifyPage(status, body) {
  if (status < 200 || status >= 400) return 'other';
  const text = String(body ?? '');
  if (!text.includes(APP_MARKER)) return 'other';
  if (text.includes(DEV_MARKER)) return 'dev';
  if (text.includes(PREVIEW_MARKER)) return 'preview';
  return 'other';
}

/** True when this process can bind the port Vite is about to use. */
export function canListen(port) {
  return new Promise((resolve) => {
    const server = createServer();
    let settled = false;
    const finish = (free) => {
      if (settled) return;
      settled = true;
      if (!server.listening) {
        resolve(free);
        return;
      }
      server.close(() => resolve(free));
    };
    server.once('error', () => finish(false));
    server.listen({ port, host: '0.0.0.0' }, () => finish(true));
  });
}

/** The page on the port, or null when nothing HTTP answers in time. */
export async function readPage(port, timeoutMs = 800) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
    const body = (await response.text()).slice(0, 100_000);
    return classifyPage(response.status, body);
  } catch {
    return null;
  }
}

/** Whether 5173 is free, already serving the built app, or held by something else. */
export async function inspectPort(port = FULL_PORT) {
  if (await canListen(port)) return { kind: 'free', page: null };
  return { kind: 'busy', page: await readPage(port) };
}

/**
 * `already`: the built app is up, so a second copy would only move the iPad
 * to a different port. `start`: run the build and preview. Vite is allowed
 * to step to the next free port; the lines say so when 5173 is busy.
 */
export function planFullStart(inspection) {
  if (inspection.kind === 'free') return { action: 'start', lines: [] };
  if (inspection.page === 'preview') {
    return {
      action: 'already',
      lines: [
        `Habitat is already running on port ${FULL_PORT}.`,
        '',
        `On this computer, open http://localhost:${FULL_PORT}`,
        'On the iPad, use the Network address from the window that is already open (it ends in :5173).',
        '',
        'Close that window, then start Habitat again, to pick up a fresh copy.',
      ],
    };
  }
  const why =
    inspection.page === 'dev'
      ? 'Port 5173 is already in use by the development server, which reloads the page while you work.'
      : 'Port 5173 is already in use.';
  return {
    action: 'start',
    lines: [
      why,
      'Habitat will use the next free port.',
      'On the iPad, open the Network address shown below.',
    ],
  };
}
