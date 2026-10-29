import { ConnectorWorkflowsService } from './connector-workflows.service';
import { ConnectorDefinition } from './connector-definition';
import { WorkflowRun } from '../proxy-providers/workflows/provider-workflow';

/** Service + real declarative runner; persistence and upstream network are simulated. */
describe('Connector workflow execution across worker ticks', () => {
  const id = '507f1f77bcf86cd799439011';
  const accountId = '507f1f77bcf86cd799439012';

  function fixture() {
    const definition: ConnectorDefinition = {
      baseUrl: 'https://api.example.com', auth: { type: 'bearer' },
      operations: {
        inspect: { method: 'GET', path: '/account', effect: 'read', timeoutMs: 5000 },
        details: { method: 'GET', path: '/details', effect: 'read', timeoutMs: 5000 },
      },
      workflows: { inspect: { version: 1, entry: 'inspect', steps: [
        { id: 'inspect', operation: 'inspect', effect: 'read', input: {},
          save: { reference: '$.reference' }, success: { path: '$.status', equals: 'ready' },
          pending: { path: '$.status', equals: 'pending' }, pollAfterMs: 1000, next: 'details' },
        { id: 'details', operation: 'details', effect: 'read',
          input: { reference: { path: '$.variables.reference' } }, save: { balance: '$.balance' },
          success: { path: '$.ok', equals: true }, rejected: { path: '$.ok', equals: false } },
      ], output: { balance: { path: '$.variables.balance' } } } },
      actions: { check: { workflow: 'inspect' } },
    };
    let state: WorkflowRun = { id, definitionVersion: 1, step: 'inspect', status: 'ready', variables: {} };
    const runQuery = { lean: () => runQuery, exec: async () => ({ ...structuredClone(state),
      accountId, connectorCode: 'example', workflow: 'inspect' }) };
    const account = { enabled: true, connectorCode: 'example', connectorVersion: 1, credential: 'encrypted-v1' };
    const accountQuery = { select: jest.fn().mockReturnThis(), lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockImplementation(async () => ({ ...account })) };
    const store = {
      acquire: jest.fn().mockImplementation(async (_id: string, now: number) => {
        if (!['ready', 'waiting'].includes(state.status) || (state.nextCheckAt ?? 0) > now) return null;
        state.status = 'running';
        return { ...structuredClone(state), leaseOwner: 'owner' };
      }),
      commit: jest.fn().mockImplementation(async (run: WorkflowRun) => { state = structuredClone(run); }),
    };
    const secrets = { decrypt: jest.fn().mockImplementation((value: string) => `decrypted:${value}`) };
    const http = { execute: jest.fn() };
    const service = new ConnectorWorkflowsService({ findById: () => accountQuery } as any,
      { findById: () => runQuery } as any, { publishedDefinition: async () => definition } as any,
      secrets as any, http as any, store as any);
    return { service, http, account, secrets, store, state: () => state };
  }

  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date('2026-01-01T00:00:00Z')); });
  afterEach(() => jest.useRealTimers());

  it('persists pending state, resumes later and passes only mapped values to the next step', async () => {
    const f = fixture();
    f.http.execute.mockResolvedValueOnce({ status: 'pending', privateKey: 'not-for-storage' })
      .mockResolvedValueOnce({ status: 'ready', reference: 'ref-1', privateKey: 'not-for-storage' })
      .mockResolvedValueOnce({ ok: true, balance: 42, password: 'not-for-storage' });
    await f.service.tick(id);
    expect(f.state()).toMatchObject({ status: 'waiting', variables: {} });
    await f.service.tick(id);
    expect(f.http.execute).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1000);
    await f.service.tick(id);
    expect(f.state()).toMatchObject({ status: 'ready', step: 'details', variables: { reference: 'ref-1' } });
    // Simulate key rotation between worker invocations.
    f.account.credential = 'encrypted-v2';
    await f.service.tick(id);
    expect(f.http.execute.mock.calls[2].slice(1)).toEqual(['details', { reference: 'ref-1' }, 'decrypted:encrypted-v2', false]);
    expect(f.state()).toMatchObject({ status: 'completed', output: { balance: 42 } });
    expect(JSON.stringify(f.state())).not.toMatch(/not-for-storage|encrypted|decrypted/);
    await f.service.tick(id);
    expect(f.http.execute).toHaveBeenCalledTimes(3);
  });

  it('stops before network access if an account is disabled after run creation', async () => {
    const f = fixture(); f.account.enabled = false;
    await f.service.tick(id);
    expect(f.state().status).toBe('unknown');
    expect(f.secrets.decrypt).not.toHaveBeenCalled();
    expect(f.http.execute).not.toHaveBeenCalled();
  });

  it('quarantines a timed-out request instead of replaying it on the next tick', async () => {
    const f = fixture(); f.http.execute.mockRejectedValue(new Error('timeout with sensitive URL'));
    await f.service.tick(id);
    await f.service.tick(id);
    expect(f.state().status).toBe('unknown');
    expect(f.http.execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.state())).not.toContain('sensitive');
  });

  it('records an explicit upstream rejection as terminal', async () => {
    const f = fixture();
    f.http.execute.mockResolvedValueOnce({ status: 'ready', reference: 'ref-1' })
      .mockResolvedValueOnce({ ok: false });
    await f.service.tick(id);
    await f.service.tick(id);
    expect(f.state().status).toBe('rejected');
    expect(f.state().output).toBeUndefined();
  });
});
