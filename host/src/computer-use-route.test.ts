import { it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHostServer } from './server.js';

it('CUA is authenticated at Host and preserves service status and body', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'host-cua-'));
  const received: unknown[] = [];
  const host = await startHostServer({ dataDir: dir, realRuntime: {
    listSessions: async () => [], messages: async () => [],
    computerUse: async request => { received.push(await request.json()); return Response.json({ error: 'wrong lease' }, { status: 403 }); },
    browserQa: async request => Response.json({ received: await request.json(), via: 'host' }),
  } });
  try {
    const endpoint = `http://127.0.0.1:${host.port}/v1/computer-use`;
    const body = JSON.stringify({ sessionId: 'ses_a', action: 'observe', leaseId: 'lease_a' });
    expect((await fetch(endpoint, { method: 'POST', body })).status).toBe(401);
    expect(received).toHaveLength(0);
    const response = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${host.token}`, 'content-type': 'application/json' }, body });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'wrong lease' });
    expect(received).toEqual([JSON.parse(body)]);
    const browser = await fetch(`http://127.0.0.1:${host.port}/v1/browser-qa`, { method: 'POST', headers: { authorization: `Bearer ${host.token}` }, body });
    expect(await browser.json()).toEqual({ received: JSON.parse(body), via: 'host' });
  } finally { await host.close(); await rm(dir, { recursive: true, force: true }); }
});
