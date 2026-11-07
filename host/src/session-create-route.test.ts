import { it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHostServer } from './server.js';

it('Host session creation preserves pinned project scope and cookie without exposing bootstrap auth', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'host-create-'));
  const received: unknown[] = [];
  const host = await startHostServer({ dataDir: dir, realRuntime: {
    listSessions: async () => [], messages: async () => [],
    createSession: async request => {
      received.push({ projectId: new URL(request.url).searchParams.get('projectId'), cookie: request.headers.get('cookie'), authorization: request.headers.get('authorization'), body: await request.json() });
      return Response.json({ id: 'ses_created', projectId: 'project_a' });
    },
  } });
  try {
    const url = `http://127.0.0.1:${host.port}/v1/session-create?projectId=project_a`;
    expect((await fetch(url, { method: 'POST' })).status).toBe(401);
    expect(received).toEqual([]);
    const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${host.token}`, 'x-lectern-credential': 'muzhi_session=test-session', 'content-type': 'application/json' }, body: JSON.stringify({ isolate: true, requestId: 'req_create_test' }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 'ses_created' });
    expect(received).toEqual([{ projectId: 'project_a', cookie: 'muzhi_session=test-session', authorization: null, body: { isolate: true, requestId: 'req_create_test' } }]);
  } finally { await host.close(); await rm(dir, { recursive: true, force: true }); }
});
