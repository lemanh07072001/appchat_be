import { ConnectorDispatches, dispatchInputHash } from './connector-dispatch.service';
import { ConnectorDispatchSchema } from './connector-dispatch.schema';

describe('Permanent provider dispatch fence', () => {
  const id = '507f1f77bcf86cd799439011';
  const identity = { reference: `buy:${id}`, orderId: id, accountId: id, connectorCode: 'example', connectorVersion: 1, action: 'buy' };
  const input = { quantity: 2, packageId: 'package1' };
  function fixture() {
    const query = { select: jest.fn().mockReturnThis(), lean: jest.fn().mockReturnThis(), exec: jest.fn() };
    const model = { create: jest.fn(), findOne: jest.fn().mockReturnValue(query), updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }) };
    const secrets = { encrypt: jest.fn().mockReturnValue('ciphertext'), decrypt: jest.fn() };
    return { model, query, secrets, ledger: new ConnectorDispatches(model as any, secrets as any) };
  }
  it('hashes equivalent objects identically without storing request bodies', async () => {
    expect(dispatchInputHash(input)).toBe(dispatchInputHash({ packageId: 'package1', quantity: 2 }));
    const f = fixture(); f.model.create.mockImplementation(async row => ({ ...row, _id: id }));
    expect(await f.ledger.claim(identity, input)).toMatchObject({ acquired: true });
    expect(f.model.create.mock.calls[0][0]).not.toHaveProperty('input');
  });
  it('never reacquires duplicate claims, including unknown and crashed attempts', async () => {
    for (const status of ['claimed', 'submitted', 'unknown', 'completed']) {
      const f = fixture(); f.model.create.mockRejectedValue({ code: 11000 });
      f.query.exec.mockResolvedValue({ ...identity, _id: id, inputHash: dispatchInputHash(input), status });
      expect(await f.ledger.claim(identity, input)).toMatchObject({ acquired: false, status });
    }
  });
  it('rejects changes to account, input or connector version for the same reference', async () => {
    const f = fixture(); f.model.create.mockRejectedValue({ code: 11000 });
    f.query.exec.mockResolvedValue({ ...identity, inputHash: dispatchInputHash(input), _id: id });
    await expect(f.ledger.claim({ ...identity, connectorVersion: 2 }, input)).rejects.toThrow('different request');
    await expect(f.ledger.claim(identity, { quantity: 3 })).rejects.toThrow('different request');
  });
  it('fences transitions with owner and previous state', async () => {
    const f = fixture(); await f.ledger.submitted(id, 'owner');
    expect(f.model.updateOne).toHaveBeenCalledWith({ _id: id, owner: 'owner', status: 'claimed' }, { $set: { status: 'submitted', submittedAt: expect.any(Date) } });
    f.model.updateOne.mockResolvedValue({ modifiedCount: 0 });
    await expect(f.ledger.complete(id, 'stale-owner')).rejects.toThrow('state changed');
  });
  it('rejects credentials and unsupported input types', () => {
    for (const input of [{ apiKey: 'secret' }, { x: undefined }, { x: NaN }, { x: new Date() }]) {
      expect(() => dispatchInputHash(input)).toThrow();
    }
  });
  it('uses a globally unique reference without TTL expiry', () => {
    expect(ConnectorDispatchSchema.indexes()).toContainEqual([{ reference: 1 }, { unique: true }]);
    expect(ConnectorDispatchSchema.indexes().some(([, options]) => options.expireAfterSeconds !== undefined)).toBe(false);
  });
  it('saves encrypted results exactly once under dispatch ownership', async () => {
    const f = fixture();
    const result = { fields: { provider_order_id: 'paid-order' } };
    await f.ledger.saveResult(id, 'owner', result);
    expect(f.secrets.encrypt).toHaveBeenCalledWith(JSON.stringify(result), `dispatch:${id}`);
    expect(f.model.updateOne).toHaveBeenCalledWith(
      { _id: id, owner: 'owner', status: 'submitted', resultSavedAt: { $exists: false } },
      { $set: { encryptedResult: 'ciphertext', resultSavedAt: expect.any(Date) } });
    expect(JSON.stringify(f.model.updateOne.mock.calls)).not.toContain('paid-order');
    f.model.updateOne.mockResolvedValue({ modifiedCount: 0 });
    await expect(f.ledger.saveResult(id, 'owner', result)).rejects.toThrow('already saved');
  });
  it.each(['submitted', 'unknown', 'completed'])('recovers %s results without reopening dispatch', async status => {
    const f = fixture();
    f.query.exec.mockResolvedValue({ ...identity, _id: id, status, encryptedResult: 'ciphertext', resultSavedAt: new Date() });
    f.secrets.decrypt.mockReturnValue(JSON.stringify({ fields: { provider_order_id: 'paid-order' } }));
    expect(await f.ledger.recoverResult(identity)).toEqual({ dispatchId: id, status, result: { fields: { provider_order_id: 'paid-order' } } });
    expect(f.secrets.decrypt).toHaveBeenCalledWith('ciphertext', `dispatch:${id}`);
    expect(f.model.updateOne).not.toHaveBeenCalled();
    expect(f.model.create).not.toHaveBeenCalled();
  });
  it('does not decrypt when the recovery identity differs', async () => {
    const f = fixture();
    f.query.exec.mockResolvedValue({ ...identity, _id: id, encryptedResult: 'ciphertext' });
    await expect(f.ledger.recoverResult({ ...identity, accountId: '507f1f77bcf86cd799439012' })).rejects.toThrow('identity mismatch');
    expect(f.secrets.decrypt).not.toHaveBeenCalled();
  });
  it('rejects recovery when the pinned inputs differ from the original purchase', async () => {
    const f = fixture();
    f.query.exec.mockResolvedValue({ ...identity, _id: id, inputHash: dispatchInputHash(input), encryptedResult: 'ciphertext', resultSavedAt: new Date() });
    await expect(f.ledger.recoverResult(identity, { ...input, quantity: 99 })).rejects.toThrow('identity mismatch');
    expect(f.secrets.decrypt).not.toHaveBeenCalled();
  });
  it('returns no result for ambiguous upstream outcomes and rejects invalid recovered contracts', async () => {
    const f = fixture();
    f.query.exec.mockResolvedValue({ ...identity, _id: id, status: 'unknown' });
    expect(await f.ledger.recoverResult(identity)).toBeNull();
    f.query.exec.mockResolvedValue({ ...identity, _id: id, encryptedResult: 'ciphertext', resultSavedAt: new Date() });
    f.secrets.decrypt.mockReturnValue(JSON.stringify({ fields: {} }));
    await expect(f.ledger.recoverResult(identity)).rejects.toThrow('contract');
  });
});
