// Double-click entry, via `npm run full`. Builds once, then serves that
// build so the page never reloads itself while you work. Port 5173 is the
// address the iPad uses; when it is taken, say so in plain text and still
// open the app (the copy already running, or the next free port).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FULL_PORT, inspectPort, planFullStart } from './full-port.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');

function openInBrowser(url) {
  // The .cmd launcher is the Windows double-click. Opening the page there
  // is how a second click still lands in the app.
  if (process.platform !== 'win32') return;
  const child = spawn('cmd', ['/c', 'start', '', url], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', () => {});
  child.unref();
}

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

const inspection = await inspectPort(FULL_PORT);
const plan = planFullStart(inspection);
for (const line of plan.lines) console.log(line);
if (plan.lines.length > 0) console.log('');

if (plan.action === 'already') {
  openInBrowser(`http://localhost:${FULL_PORT}`);
  process.exit(0);
}

const buildCode = await runNode([viteBin, 'build']);
if (buildCode !== 0) process.exit(buildCode);

// No --strictPort: if 5173 is taken, Vite prints the port it actually
// opened instead of throwing "Port 5173 is already in use".
const previewCode = await runNode([
  viteBin,
  'preview',
  '--host',
  '0.0.0.0',
  '--port',
  String(FULL_PORT),
]);
process.exit(previewCode);
