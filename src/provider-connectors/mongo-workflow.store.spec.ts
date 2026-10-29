import { MongoWorkflowStore } from './mongo-workflow.store';
import { validateConnectorDefinition } from './connector-definition';

describe('Durable workflow ownership', () => {
  const id = '507f1f77bcf86cd799439011';
  function fixture(row: unknown = null, modifiedCount = 1) {
    const query = { lean: jest.fn().mockReturnThis(), exec: jest.fn().mockResolvedValue(row) };
    const model = { findOneAndUpdate: jest.fn().mockReturnValue(query),
      updateOne: jest.fn().mockReturnValue({ exec: async () => ({ modifiedCount }) }),
      updateMany: jest.fn().mockReturnValue({ exec: async () => ({ modifiedCount: 1 }) }) };
    return { store: new MongoWorkflowStore(model as any), model };
  }
  it('atomically acquires only eligible work and assigns a fencing token', async () => {
    const f = fixture({ _id: id, definitionVersion: 1, step: 'buy', variables: { quantity: 1 } });
    const run = await f.store.acquire(id, 1000);
    expect(run?.leaseOwner).toEqual(expect.any(String));
    expect(f.model.findOneAndUpdate.mock.calls[0][0]).toMatchObject({ status: { $in: ['ready', 'waiting'] }, deadlineAt: { $gt: 1000 } });
    expect(f.model.findOneAndUpdate.mock.calls[0][1].$set.leaseUntil).toBe(91000);
  });
  it('rejects commits from stale owners instead of overwriting another worker', async () => {
    const f = fixture(null, 0);
    await expect(f.store.commit({ id, definitionVersion: 1, step: 'fetch', status: 'ready', variables: {}, leaseOwner: 'old' })).rejects.toThrow('lease lost');
    expect(f.model.updateOne.mock.calls[0][0]).toMatchObject({ status: 'running', leaseOwner: 'old' });
  });
  it('quarantines abandoned work instead of resetting it for purchase retry', async () => {
    const f = fixture();
    await f.store.quarantineExpired(1000);
    expect(f.model.updateMany.mock.calls[0][1].$set).toEqual({ status: 'unknown' });
  });
});

describe('Operation → workflow → action contract', () => {
  const definition = {
    baseUrl: 'https://api.example.com', auth: { type: 'bearer' },
    operations: { purchase: { method: 'POST', path: '/orders', effect: 'write', timeoutMs: 10000 } },
    workflows: { purchaseFlow: { version: 1, entry: 'buy', steps: [
      { id: 'buy', operation: 'purchase', effect: 'write', input: {}, save: { orderId: '$.id' }, success: { path: '$.ok', equals: true } },
    ], output: { orderId: { path: '$.variables.orderId' } } } },
    actions: { buy: { workflow: 'purchaseFlow' } },
  };
  it('accepts an action referencing a validated workflow', () => {
    expect(validateConnectorDefinition(definition).actions.buy).toEqual({ workflow: 'purchaseFlow' });
  });
  it('rejects unknown operations and mismatched effect classifications', () => {
    const mismatch = structuredClone(definition);
    mismatch.workflows.purchaseFlow.steps[0].effect = 'read';
    expect(() => validateConnectorDefinition(mismatch)).toThrow();
    const missing = structuredClone(definition);
    missing.workflows.purchaseFlow.steps[0].operation = 'missing';
    expect(() => validateConnectorDefinition(missing)).toThrow();
  });
  it('does not allow a read-only action to run a paid workflow', () => {
    expect(() => validateConnectorDefinition({ ...definition, actions: { check: { workflow: 'purchaseFlow' } } })).toThrow();
  });
});
