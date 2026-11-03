import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canListen, classifyPage, inspectPort, planFullStart } from './full-port.mjs';

const title = 'Habitat — Pixel World Editor';

function listen(server, host = '0.0.0.0') {
  server.listen(0, host);
  return once(server, 'listening').then(() => server.address().port);
}

describe('classifyPage', () => {
  it('reads the dev server page as the development server', () => {
    const index = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    expect(classifyPage(200, index)).toBe('dev');
  });

  it('reads the built page as the full version', () => {
    const built = `<title>${title}</title><script src="./assets/index-abc123.js"></script>`;
    expect(classifyPage(200, built)).toBe('preview');
  });

  it('ignores other sites and error pages', () => {
    expect(classifyPage(200, '<title>Something else</title>')).toBe('other');
    expect(classifyPage(404, `<title>${title}</title>`)).toBe('other');
    expect(classifyPage(200, '')).toBe('other');
  });
});

describe('planFullStart', () => {
  it('starts on 5173 when the port is free', () => {
    expect(planFullStart({ kind: 'free', page: null })).toEqual({ action: 'start', lines: [] });
  });

  it('keeps the copy already serving the built app', () => {
    const plan = planFullStart({ kind: 'busy', page: 'preview' });
    expect(plan.action).toBe('already');
    expect(plan.lines.join('\n')).toContain('http://localhost:5173');
    expect(plan.lines.join('\n')).toContain('already running');
  });

  it('still starts when the development server holds the port, and says the address will change', () => {
    const plan = planFullStart({ kind: 'busy', page: 'dev' });
    expect(plan.action).toBe('start');
    expect(plan.lines[0]).toContain('development server');
    expect(plan.lines.join('\n')).toContain('next free port');
  });

  it('still starts when a stranger holds the port', () => {
    const plan = planFullStart({ kind: 'busy', page: 'other' });
    expect(plan.action).toBe('start');
    expect(plan.lines[0]).toBe('Port 5173 is already in use.');
  });

  it('still starts when the port is blocked and nothing answers', () => {
    const plan = planFullStart({ kind: 'busy', page: null });
    expect(plan.action).toBe('start');
    expect(plan.lines[0]).toBe('Port 5173 is already in use.');
  });
});

describe('inspectPort', () => {
  it('reports a free port', async () => {
    const probe = net.createServer();
    const port = await listen(probe, '127.0.0.1');
    probe.close();
    await once(probe, 'close');
    expect(await canListen(port)).toBe(true);
    expect(await inspectPort(port)).toEqual({ kind: 'free', page: null });
  });

  it('reports the built app when that page is already being served', async () => {
    const server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(`<title>${title}</title><script src="./assets/index-abc123.js"></script>`);
    });
    const port = await listen(server);
    try {
      expect(await inspectPort(port)).toEqual({ kind: 'busy', page: 'preview' });
    } finally {
      server.close();
    }
  });

  it('reports a blocked port that does not speak HTTP', async () => {
    const server = net.createServer((socket) => socket.end('nope'));
    const port = await listen(server);
    try {
      expect(await inspectPort(port)).toEqual({ kind: 'busy', page: null });
    } finally {
      server.close();
    }
  });
});
