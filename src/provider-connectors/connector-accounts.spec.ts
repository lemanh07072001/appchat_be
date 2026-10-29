import { ConnectorAccountsService } from './connector-accounts.service';

describe('Connector account updates', () => {
  const id = '507f1f77bcf86cd799439011';
  function fixture(result: unknown = { _id: id, revision: 2, enabled: false }) {
    const query = { select: jest.fn().mockReturnThis(), lean: jest.fn().mockReturnThis(), exec: jest.fn().mockResolvedValue(result) };
    const model = { findOneAndUpdate: jest.fn().mockReturnValue(query) };
    const secrets = { encrypt: jest.fn().mockReturnValue('encrypted') };
    return { service: new ConnectorAccountsService(model as any, {} as any, secrets as any, {} as any), model, secrets, query };
  }
  it('updates using optimistic concurrency and an explicit public projection', async () => {
    const f = fixture();
    await f.service.update(id, { revision: 1, enabled: false });
    expect(f.model.findOneAndUpdate).toHaveBeenCalledWith({ _id: id, revision: 1 },
      { $set: { enabled: false }, $inc: { revision: 1 } }, { new: true });
    expect(f.query.select).toHaveBeenCalledWith('_id name connectorCode connectorVersion enabled revision');
  });
  it('encrypts replacement keys and binds them to the canonical ID', async () => {
    const f = fixture();
    await f.service.update(id.toUpperCase(), { revision: 1, apiKey: ' key ' });
    expect(f.secrets.encrypt).toHaveBeenCalledWith('key', id);
    expect(f.model.findOneAndUpdate.mock.calls[0][1].$set).toEqual({ credential: 'encrypted' });
  });
  it('rejects conflicting updates', async () => {
    await expect(fixture(null).service.update(id, { revision: 1, enabled: false })).rejects.toThrow('reload');
  });
  it('rejects unknown fields, blank credentials and invalid booleans before writing', async () => {
    const f = fixture();
    for (const body of [{ revision: 0, apiKey: '' }, { revision: 0, enabled: 'false' },
      { revision: 0, connectorVersion: 2 }, { revision: -1, enabled: false }]) {
      await expect(f.service.update(id, body as any)).rejects.toThrow();
    }
    expect(f.model.findOneAndUpdate).not.toHaveBeenCalled();
  });
});
