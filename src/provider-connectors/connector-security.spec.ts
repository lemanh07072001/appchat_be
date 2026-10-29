import { ConfigService } from '@nestjs/config';
import { ConnectorSecrets } from './connector-secrets.service';
import { ConnectorHttp, isPublicConnectorAddress } from './connector-http.service';
import { validateConnectorDefinition } from './connector-definition';
import { ConnectorAccountsService } from './connector-accounts.service';

describe('Connector account security', () => {
  const vault = () => new ConnectorSecrets(new ConfigService({ CONNECTOR_ENCRYPTION_KEY: 'ab'.repeat(32) }));

  it('encrypts with randomized authenticated encryption bound to the account', () => {
    const secrets = vault();
    const first = secrets.encrypt('private-api-key', 'account-1');
    const second = secrets.encrypt('private-api-key', 'account-1');
    expect(first).not.toEqual(second);
    expect(first).not.toContain('private-api-key');
    expect(secrets.decrypt(first, 'account-1')).toBe('private-api-key');
    expect(() => secrets.decrypt(first, 'account-2')).toThrow();
    const parts = first.split('.');
    parts[2] = Buffer.alloc(16).toString('base64');
    expect(() => secrets.decrypt(parts.join('.'), 'account-1')).toThrow();
  });

  it('fails closed without a dedicated encryption key', () => {
    expect(() => new ConnectorSecrets(new ConfigService()).encrypt('key', 'id')).toThrow('CONNECTOR_ENCRYPTION_KEY');
  });

  it('blocks private, metadata, mapped IPv6 and reserved destinations', () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.0.1',
      '169.254.169.254', '100.64.0.1', '198.18.0.1', '192.0.2.1', '203.0.113.1',
      '224.0.0.1', '::1', '::ffff:127.0.0.1', '2001:4860:4860::8888']) {
      expect(isPublicConnectorAddress(address)).toBe(false);
    }
    expect(isPublicConnectorAddress('8.8.8.8')).toBe(true);
    expect(isPublicConnectorAddress('1.1.1.1')).toBe(true);
  });

  it('refuses mutating checks before making a network call', async () => {
    const definition = validateConnectorDefinition({
      baseUrl: 'https://api.example.com', auth: { type: 'bearer' },
      operations: { account: { method: 'POST', path: '/account', effect: 'read', timeoutMs: 1000 } },
      actions: { check: { operation: 'account' } },
    });
    await expect(new ConnectorHttp().check(definition, 'key')).rejects.toThrow('read-only GET');
  });

  it('returns only mapped account fields, never the raw provider response', async () => {
    const id = '507f1f77bcf86cd799439011';
    const account = { credential: vault().encrypt('private-api-key', id), enabled: true, connectorCode: 'example', connectorVersion: 1 };
    const query = { select: jest.fn().mockReturnThis(), lean: jest.fn().mockReturnThis(), exec: jest.fn().mockResolvedValue(account) };
    const definition = validateConnectorDefinition({
      baseUrl: 'https://api.example.com', auth: { type: 'bearer' },
      operations: { account: { method: 'GET', path: '/account', effect: 'read', timeoutMs: 1000,
        response: { success: { path: '$.ok', equals: true }, account: '$.data.name', balance: '$.data.balance' } } },
      actions: { check: { operation: 'account' } },
    });
    const http = { check: jest.fn().mockResolvedValue({ ok: true, data: { name: 'reseller', balance: 100, token: 'private-api-key' } }) };
    const service = new ConnectorAccountsService({ findById: () => query } as any,
      { publishedDefinition: async () => definition } as any, vault(), http as any);
    const result = await service.check(id);
    expect(result).toMatchObject({ ok: true, account: 'reseller', balance: 100 });
    expect(JSON.stringify(result)).not.toContain('private-api-key');
    http.check.mockResolvedValue({ ok: true, data: { name: 'private-api-key', balance: 100 } });
    await expect(service.check(id)).rejects.toThrow('mapping');
  });
});
