import { ConnectorAccountsService } from './connector-accounts.service';

describe('Pinned account version upgrade', () => {
  const id = '507f1f77bcf86cd799439011';
  const query = (value: any) => ({ select: jest.fn().mockReturnThis(), lean: jest.fn().mockReturnThis(), exec: jest.fn().mockResolvedValue(value) });
  function fixture() {
    const source = { _id: id, name: 'Provider', connectorCode: 'example', connectorVersion: 1, revision: 3, credential: 'old-cipher', enabled: true };
    const accounts = { findById: jest.fn().mockReturnValue(query(source)), findOne: jest.fn().mockReturnValue(query(null)), create: jest.fn(async row => row) };
    const connectors = { publishedDefinition: jest.fn().mockResolvedValue({ baseUrl: 'https://api.example.com', auth: { type: 'bearer' } }) };
    const secrets = { decrypt: jest.fn().mockReturnValue('secret'), encrypt: jest.fn().mockReturnValue('new-cipher') };
    return { source, accounts, connectors, secrets, service: new ConnectorAccountsService(accounts as any, connectors as any, secrets as any, {} as any) };
  }
  it('creates a disabled successor and re-encrypts the key for its new identity', async () => {
    const f = fixture(); const result = await f.service.upgrade(id, { revision: 3, targetVersion: 2 });
    expect(result).toMatchObject({ enabled: false, connectorVersion: 2, originalAccountUnchanged: true, ordersUnchanged: true });
    expect(f.secrets.encrypt).toHaveBeenCalledWith('secret', result.id);
    expect(f.accounts.create).toHaveBeenCalledWith(expect.objectContaining({ credential: 'new-cipher', enabled: false, connectorVersion: 2 }));
    expect(f.source.connectorVersion).toBe(1); expect(f.source.enabled).toBe(true);
    expect(JSON.stringify(result)).not.toContain('cipher');
  });
  it('preserves an existing successor without replacing its key', async () => {
    const f = fixture(); f.accounts.findOne.mockReturnValue(query({ _id: id, connectorVersion: 2, enabled: true }));
    expect((await f.service.upgrade(id, { revision: 3, targetVersion: 2 })).enabled).toBe(true);
    expect(f.secrets.decrypt).not.toHaveBeenCalled(); expect(f.accounts.create).not.toHaveBeenCalled();
  });
  it.each(['legacyPartnerId', 'sourcePartnerId'])('inherits provider identity from %s without duplicating migration receipts', async field => {
    const f = fixture();
    (f.source as any)[field] = id;
    await f.service.upgrade(id, { revision: 3, targetVersion: 2 });
    const created = f.accounts.create.mock.calls[0][0];
    expect(created.sourcePartnerId).toBe(id);
    expect(created.legacyPartnerId).toBeUndefined();
  });
  it('refuses a previously created successor missing its source identity without overwriting it', async () => {
    const f = fixture();
    (f.source as any).legacyPartnerId = id;
    f.accounts.findOne.mockReturnValue(query({ _id: id, connectorVersion: 2, enabled: false }));
    await expect(f.service.upgrade(id, { revision: 3, targetVersion: 2 })).rejects.toThrow('source provider');
    expect(f.accounts.create).not.toHaveBeenCalled();
  });
  it.each([
    { baseUrl: 'https://other.example.com', auth: { type: 'bearer' } },
    { baseUrl: 'https://api.example.com', auth: { type: 'query', name: 'key' } },
    null,
  ])('refuses changed destination/auth or unpublished target %#', target => {
    const f = fixture(); f.connectors.publishedDefinition.mockResolvedValueOnce({ baseUrl: 'https://api.example.com', auth: { type: 'bearer' } }).mockResolvedValueOnce(target);
    return expect(f.service.upgrade(id, { revision: 3, targetVersion: 2 })).rejects.toThrow('same API');
  });
  it('refuses stale source and downgrades', async () => {
    const f = fixture();
    await expect(f.service.upgrade(id, { revision: 2, targetVersion: 2 })).rejects.toThrow('changed');
    await expect(f.service.upgrade(id, { revision: 3, targetVersion: 1 })).rejects.toThrow('newer');
    expect(f.accounts.create).not.toHaveBeenCalled();
  });
});
