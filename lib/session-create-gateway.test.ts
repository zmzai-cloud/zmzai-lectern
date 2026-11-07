import { it, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const project = vi.hoisted(() => ({ id: 'project_a' }));
vi.mock('./projects.js', () => ({ getActiveProject: () => ({ id: project.id }) }));

it('creation captures project before async request body work and forwards exactly once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'create-gateway-'));
  const received: string[] = [];
  const server = createServer((req, res) => { received.push(req.url!); req.resume(); res.setHeader('content-type', 'application/json'); res.end('{"id":"ses_created"}'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const old = process.env.LECTERN_HOST_GATEWAY;
  try {
    const file = join(dir, 'host.json');
    await writeFile(file, JSON.stringify({ port: (server.address() as { port: number }).port, token: 'test' }));
    process.env.LECTERN_HOST_GATEWAY = file;
    vi.resetModules();
    const { hostGateway } = await import('./host-gateway.js');
    project.id = 'project_a';
    const request = new Request('http://localhost/api/sessions', { method: 'POST', body: '{"requestId":"req_fixture"}' });
    const clone = request.clone.bind(request);
    vi.spyOn(request, 'clone').mockImplementation(() => { project.id = 'project_b'; return clone(); });
    const response = await hostGateway(request);
    expect(response?.status).toBe(200);
    expect(received).toEqual(['/v1/session-create?projectId=project_a']);
  } finally {
    if (old === undefined) delete process.env.LECTERN_HOST_GATEWAY; else process.env.LECTERN_HOST_GATEWAY = old;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
