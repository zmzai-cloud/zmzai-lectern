import { it, expect, vi } from 'vitest';
const state = vi.hoisted(() => ({ lease: null as null | { leaseId: string }, active: 0, max: 0 }));
vi.mock('./runtime', () => ({ sessionRuntime: () => ({ store: { task: { getActiveTask: async () => ({ id: 'task' }) } } }) }));
vi.mock('./delivery', () => ({ resolveOwner: () => ({}), getDeliveryForSession: () => null, getActiveAttempt: () => null, recordCommandRun: vi.fn() }));
vi.mock('./computer-use-macos', () => ({ createMacOsCuaAdapter: () => ({}), setAdapterTarget: vi.fn() }));
vi.mock('./computer-use', () => ({ listActionsForLease: () => [], reconcileInterruptedActions: () => ({ reconciled: 0 }), ComputerUseBroker: class {
  acquireLease() { state.lease = { leaseId: 'lease' }; return { ok: true, lease: state.lease }; }
  leaseStatus() { return state.lease; }
  async act() { state.active++; state.max = Math.max(state.max, state.active); await new Promise(r => setTimeout(r, 15)); state.active--; return { ok: true }; }
} }));
import { handleComputerUse } from './computer-use-service';
const request = (body: unknown) => new Request('http://localhost/api/deliveries/computer-use', { method: 'POST', body: JSON.stringify(body) });

it('lease belongs to the acquiring session and adapter actions are serialized', async () => {
  expect((await handleComputerUse(request({ action: 'acquire', sessionId: 'ses_owner', targetApp: 'Fixture' }))).status).toBe(200);
  expect((await handleComputerUse(request({ action: 'act', sessionId: 'ses_other', leaseId: 'lease' }))).status).toBe(403);
  expect((await handleComputerUse(request({ action: 'act', sessionId: 'ses_owner', leaseId: 'wrong' }))).status).toBe(403);
  const body = { action: 'act', sessionId: 'ses_owner', leaseId: 'lease', kind: 'click' };
  const responses = await Promise.all([handleComputerUse(request(body)), handleComputerUse(request(body))]);
  expect(responses.map(r => r.status)).toEqual([200, 200]);
  expect(state.max).toBe(1);
});
