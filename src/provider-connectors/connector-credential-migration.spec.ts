import { Types } from 'mongoose';
import { ConnectorCredentialMigration } from './connector-credential-migration.service';

describe('No-overwrite credential migration', () => {
  const partnerId = String(new Types.ObjectId());
  const body = { connectorCode: 'verified', connectorVersion: 1, expectedOrigin: 'https://api.example.com' };
  const query = (value: unknown) => ({ select: jest.fn().mockReturnThis(), lean: jest.fn().mockReturnThis(), exec: jest.fn().mockResolvedValue(value) });
  function fixture() {
    const partners = { findById: jest.fn().mockReturnValue(query({ name: 'Provider', token_api: 'legacy-secret' })) };
    const accounts = { findOne: jest.fn().mockReturnValue(query(null)), create: jest.fn().mockImplementation(async row => row) };
    const connectors = { publishedDefinition: jest.fn().mockResolvedValue({ baseUrl: 'https://api.example.com/api' }) };
    const secrets = { encrypt: jest.fn().mockReturnValue('encrypted-key') };
    return { partners, accounts, connectors, secrets,
      service: new ConnectorCredentialMigration(partners as any, accounts as any, connectors as any, secrets as any) };
  }
  it('copies into an encrypted disabled account without returning any credential', async () => {
    const f = fixture(); const result = await f.service.copy(partnerId, body);
    expect(result).toMatchObject({ enabled: false, legacyUnchanged: true, servicesUnchanged: true, ordersUnchanged: true });
    expect(f.accounts.create).toHaveBeenCalledWith(expect.objectContaining({ enabled: false,
      credential: 'encrypted-key', legacyPartnerId: new Types.ObjectId(partnerId) }));
    expect(f.secrets.encrypt).toHaveBeenCalledWith('legacy-secret', expect.stringMatching(/^[a-f0-9]{24}$/));
    expect(JSON.stringify(result)).not.toMatch(/legacy-secret|encrypted-key/);
  });
  it('replays the existing migration without replacing its key or enabled state', async () => {
    const f = fixture();
    f.accounts.findOne.mockReturnValue(query({ _id: new Types.ObjectId(), ...body, enabled: true }));
    expect((await f.service.copy(partnerId, body)).enabled).toBe(true);
    expect(f.partners.findById).not.toHaveBeenCalled();
    expect(f.secrets.encrypt).not.toHaveBeenCalled(); expect(f.accounts.create).not.toHaveBeenCalled();
  });
  it('refuses to overwrite a copy pinned to another version', async () => {
    const f = fixture();
    f.accounts.findOne.mockReturnValue(query({ ...body, connectorVersion: 2 }));
    await expect(f.service.copy(partnerId, body)).rejects.toThrow('preserved');
    expect(f.accounts.create).not.toHaveBeenCalled();
  });
  it('recovers a concurrent unique-index winner without rewriting it', async () => {
    const f = fixture();
    const winner = { _id: new Types.ObjectId(), ...body, enabled: false };
    f.accounts.findOne.mockReturnValueOnce(query(null)).mockReturnValueOnce(query(winner));
    f.accounts.create.mockRejectedValueOnce({ code: 11000 });
    expect((await f.service.copy(partnerId, body)).accountId).toBe(String(winner._id));
  });
  it('requires a published template and confirmed destination origin before reading the key', async () => {
    const f = fixture();
    await expect(f.service.copy(partnerId, { ...body, expectedOrigin: 'https://other.example.com' })).rejects.toThrow('origin');
    expect(f.partners.findById).not.toHaveBeenCalled(); expect(f.accounts.create).not.toHaveBeenCalled();
    f.connectors.publishedDefinition.mockResolvedValueOnce(null as any);
    await expect(f.service.copy(partnerId, body)).rejects.toThrow('Published');
  });
  it.each(['', '   ', 'key\nsecret', 'x'.repeat(8193)])('refuses invalid source credentials %#', token_api => {
    const f = fixture(); f.partners.findById.mockReturnValue(query({ name: 'Provider', token_api }));
    return expect(f.service.copy(partnerId, body)).rejects.toThrow('credential');
  });
  it('does not accept arbitrary fields or malformed IDs', async () => {
    const f = fixture();
    await expect(f.service.copy('not-id', body)).rejects.toThrow('Invalid');
    await expect(f.service.copy(partnerId, { ...body, enabled: true } as any)).rejects.toThrow('Invalid');
    expect(f.connectors.publishedDefinition).not.toHaveBeenCalled();
  });
});
