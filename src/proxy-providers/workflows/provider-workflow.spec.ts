import { ProviderWorkflow, ProviderWorkflowRunner, WorkflowRun, WorkflowStore, readWorkflowPath, validateProviderWorkflow } from './provider-workflow';

describe('Declarative provider workflow safety', () => {
  const definition: ProviderWorkflow = {
    version: 1, entry: 'buy',
    steps: [
      { id: 'buy', operation: 'purchase', effect: 'write', input: {},
        success: { path: '$.ok', equals: true }, save: { orderId: '$.orderId' }, next: 'fetch' },
      { id: 'fetch', operation: 'details', effect: 'read',
        input: { orderId: { path: '$.variables.orderId' } }, save: { proxies: '$.proxies' },
        success: { path: '$.status', equals: 'ready' },
        pending: { path: '$.status', equals: 'processing' }, pollAfterMs: 5000,
        rejected: { path: '$.status', equals: 'failed' } },
    ],
    output: { orderId: { path: '$.variables.orderId' }, proxies: { path: '$.variables.proxies' } },
  };

  function setup() {
    let state: WorkflowRun = { id: 'run', definitionVersion: 1, step: 'buy', status: 'ready', variables: {} };
    const store: WorkflowStore = {
      acquire: async (_id, now) => {
        if (!['ready', 'waiting'].includes(state.status) || (state.nextCheckAt ?? 0) > now) return null;
        state.status = 'running';
        return structuredClone(state);
      },
      commit: async run => { state = structuredClone(run); },
    };
    const execute = jest.fn();
    return { runner: new ProviderWorkflowRunner(store, { execute }), execute, state: () => state };
  }

  it('persists order ID, polls without buying again, and completes', async () => {
    const fixture = setup();
    fixture.execute.mockResolvedValueOnce({ ok: true, orderId: 'upstream-1' })
      .mockResolvedValueOnce({ status: 'processing' })
      .mockResolvedValueOnce({ status: 'ready', proxies: [{ host: 'example.com', port: 8080 }] });
    await fixture.runner.tick('run', definition, 0);
    expect(fixture.state()).toMatchObject({ step: 'fetch', status: 'ready', variables: { orderId: 'upstream-1' } });
    await fixture.runner.tick('run', definition, 1);
    expect(fixture.state()).toMatchObject({ status: 'waiting', nextCheckAt: 5001 });
    await fixture.runner.tick('run', definition, 1000);
    expect(fixture.execute).toHaveBeenCalledTimes(2);
    await fixture.runner.tick('run', definition, 5001);
    expect(fixture.state().status).toBe('completed');
    expect(fixture.execute.mock.calls.map(call => call[0])).toEqual(['purchase', 'details', 'details']);
    expect(fixture.execute.mock.calls[2][1]).toEqual({ orderId: 'upstream-1' });
  });

  it('does not retry an uncertain purchase', async () => {
    const fixture = setup();
    fixture.execute.mockRejectedValue(new Error('timeout'));
    await fixture.runner.tick('run', definition);
    await fixture.runner.tick('run', definition);
    expect(fixture.state().status).toBe('unknown');
    expect(fixture.execute).toHaveBeenCalledTimes(1);
  });

  it('does not execute concurrently for the same run', async () => {
    const fixture = setup();
    fixture.execute.mockResolvedValue({ ok: true, orderId: 'one' });
    await Promise.all([fixture.runner.tick('run', definition), fixture.runner.tick('run', definition)]);
    expect(fixture.execute).toHaveBeenCalledTimes(1);
  });

  it('supports immediate delivery as a single-step workflow', async () => {
    const fixture = setup();
    fixture.execute.mockResolvedValue({ ok: true, orderId: 'one', proxies: ['proxy'] });
    const immediate = structuredClone(definition);
    immediate.steps = [{ ...immediate.steps[0], next: undefined, save: { orderId: '$.orderId', proxies: '$.proxies' } }];
    await fixture.runner.tick('run', immediate);
    expect(fixture.state()).toMatchObject({ status: 'completed', output: { orderId: 'one', proxies: ['proxy'] } });
  });

  it('quarantines unrecognized responses instead of retrying', async () => {
    const fixture = setup();
    fixture.execute.mockResolvedValue({ unexpected: true });
    await fixture.runner.tick('run', definition);
    expect(fixture.state().status).toBe('unknown');
  });

  it('rejects purchase loops and polling paid operations', () => {
    const cyclic = structuredClone(definition);
    cyclic.steps[1].next = 'buy';
    expect(() => validateProviderWorkflow(cyclic)).toThrow('cycles');
    const unsafe = structuredClone(definition);
    unsafe.steps[1].effect = 'write';
    expect(() => validateProviderWorkflow(unsafe)).toThrow('Polling');
  });

  it('does not expose inherited fields', () => {
    expect(() => readWorkflowPath({}, '$.__proto__.token')).toThrow();
    expect(() => readWorkflowPath({}, '$.missing.__proto__.token')).toThrow();
    expect(readWorkflowPath({}, '$.toString')).toBeUndefined();
  });
});
