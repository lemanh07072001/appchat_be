import { ConnectorWriteExecutor } from './connector-write-executor';
import { validateConnectorDefinition } from './connector-definition';

describe('Fenced generic write execution', () => {
  const id = '507f1f77bcf86cd799439011';
  const identity = { reference: `buy:${id}`, orderId: id, accountId: id, connectorCode: 'example', connectorVersion: 1, action: 'buy' };
  function fixture() {
    const definition = validateConnectorDefinition({ baseUrl: 'https://api.example.com', auth: { type: 'bearer' },
      operations: { buy: { method: 'POST', path: '/orders', effect: 'write', timeoutMs: 1000,
        request: { body: { amount: { path: '$.input.quantity' } } },
        response: { success: { path: '$.ok', equals: true } },
        output: { fields: { provider_order_id: { path: '$.id', type: 'string', required: true } } } } },
      actions: { buy: { operation: 'buy' } } });
    const events: string[] = [];
    const dispatches = {
      claim: jest.fn(async () => { events.push('claim'); return { acquired: true, id, owner: 'owner' }; }),
      submitted: jest.fn(async () => { events.push('submitted'); }),
      complete: jest.fn(async () => { events.push('complete'); }),
      saveResult: jest.fn(async () => { events.push('save-result'); }),
      unknown: jest.fn(async () => { events.push('unknown'); }),
    };
    const http = { execute: jest.fn(async () => { events.push('http'); return { ok: true, id: 'order1' }; }) };
    const persistResult = jest.fn(async () => { events.push('persist'); });
    const executor = new ConnectorWriteExecutor(dispatches as any, http as any);
    const request = { identity, definition, input: { quantity: 1 }, token: 'account-secret', persistResult };
    return { executor, request, dispatches, http, events, persistResult };
  }
  it('persists submission before network and results before completion', async () => {
    const f = fixture();
    expect(await f.executor.execute(f.request)).toEqual({ dispatchId: id, result: { fields: { provider_order_id: 'order1' } } });
    expect(f.events).toEqual(['claim', 'submitted', 'http', 'save-result', 'persist', 'complete']);
    expect(f.http.execute).toHaveBeenCalledWith(f.request.definition, 'buy', { quantity: 1 }, 'account-secret', true);
  });
  it('does not dispatch when request preparation or durable submission fails', async () => {
    const f = fixture();
    await expect(f.executor.execute({ ...f.request, input: {} })).rejects.toThrow('Missing provider input');
    expect(f.dispatches.claim).not.toHaveBeenCalled();
    f.dispatches.submitted.mockRejectedValue(new Error('db unavailable'));
    await expect(f.executor.execute(f.request)).rejects.toThrow();
    expect(f.http.execute).not.toHaveBeenCalled();
  });
  it('never sends a duplicate dispatch, regardless of prior outcome', async () => {
    const f = fixture();
    f.dispatches.claim.mockResolvedValue({ acquired: false, id, status: 'unknown' } as any);
    await expect(f.executor.execute(f.request)).rejects.toThrow('reconcile');
    expect(f.http.execute).not.toHaveBeenCalled();
  });
  it.each(['network', 'mapping', 'rejection', 'result-storage', 'persist', 'completion', 'credential'])(
    'quarantines %s failures without retries or leaking error contents', async failure => {
      const f = fixture();
      if (failure === 'network') f.http.execute.mockRejectedValue(new Error('account-secret'));
      if (failure === 'mapping') f.http.execute.mockResolvedValue({ ok: true } as any);
      if (failure === 'rejection') f.http.execute.mockResolvedValue({ ok: false } as any);
      if (failure === 'persist') f.persistResult.mockRejectedValue(new Error('private payload'));
      if (failure === 'result-storage') f.dispatches.saveResult.mockRejectedValue(new Error('db unavailable'));
      if (failure === 'completion') f.dispatches.complete.mockRejectedValue(new Error('db timeout'));
      if (failure === 'credential') f.http.execute.mockResolvedValue({ ok: true, id: 'account-secret' });
      await expect(f.executor.execute(f.request)).rejects.toThrow('requires reconciliation');
      expect(f.http.execute).toHaveBeenCalledTimes(1);
      expect(f.dispatches.unknown).toHaveBeenCalledWith(id, 'owner');
      if (['network', 'mapping', 'rejection', 'credential', 'result-storage'].includes(failure)) expect(f.persistResult).not.toHaveBeenCalled();
    });
  it('preserves the submission fence when quarantine storage is unavailable', async () => {
    const f = fixture();
    f.http.execute.mockRejectedValue(new Error('upstream timeout'));
    f.dispatches.unknown.mockRejectedValue(new Error('database unavailable'));
    await expect(f.executor.execute(f.request)).rejects.toThrow('do not retry automatically');
    expect(f.http.execute).toHaveBeenCalledTimes(1);
  });
});
