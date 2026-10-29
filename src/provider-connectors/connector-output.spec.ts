import { ConnectorOutput, mapConnectorOutput, validateConnectorOutput } from './connector-output';
import { validateConnectorDefinition } from './connector-definition';
import { ConnectorHttp } from './connector-http.service';

describe('Configuration-driven provider response mapping', () => {
  const mapping: ConnectorOutput = {
    fields: { provider_order_id: { path: '$.data.id', type: 'string', required: true } },
    items: { path: '$.data.proxies', fields: {
      host: { path: '$.ip', type: 'string', required: true },
      port: { path: '$.port', type: 'number', required: true },
      password: { path: '$.password', type: 'string' },
      expiresAt: { path: '$.expires', type: 'isoDate' },
    } },
  };
  it('normalizes only explicitly mapped scalar fields and proxy lists', () => {
    expect(mapConnectorOutput(mapping, { data: { id: 'order1', secret: 'not-copied', proxies: [
      { ip: '1.2.3.4', port: 8080, password: 'proxy-password', expires: '2026-10-28T12:00:00+07:00', extra: 'not-copied' },
    ] } })).toEqual({ fields: { provider_order_id: 'order1' }, items: [
      { host: '1.2.3.4', port: 8080, password: 'proxy-password', expiresAt: '2026-10-28T05:00:00.000Z' },
    ] });
  });
  it('fails closed on missing fields, invalid list, coercion and ambiguous dates', () => {
    for (const data of [ {}, { id: 'x', proxies: {} }, { id: 'x', proxies: [{ ip: 'a', port: '8080' }] },
      { id: 'x', proxies: [{ ip: 'a', port: 80, expires: 123 }] } ]) {
      expect(() => mapConnectorOutput(mapping, { data })).toThrow('does not match');
    }
  });
  it('rejects unsafe paths and credential target fields', () => {
    for (const fields of [ { host: { path: '$.__proto__.x', type: 'string' } },
      { apiKey: { path: '$.key', type: 'string' } }, { host: { path: '$.x', type: 'script' } } ]) {
      expect(() => validateConnectorOutput({ fields })).toThrow();
    }
  });
  const definition = () => validateConnectorDefinition({ baseUrl: 'https://api.example.com', auth: { type: 'bearer' },
    operations: { fetch: { method: 'GET', path: '/proxies', effect: 'read', timeoutMs: 1000, output: mapping,
      response: { success: { path: '$.ok', equals: true } } } }, actions: { fetch: { operation: 'fetch' } } });
  it('executes a mapped read without allowing writes', async () => {
    const http = new ConnectorHttp();
    const execute = jest.spyOn(http, 'execute').mockResolvedValue({ ok: true, data: { id: 'x', proxies: [] } });
    expect(await http.readMapped(definition(), 'fetch', {}, 'account-secret')).toEqual({ fields: { provider_order_id: 'x' }, items: [] });
    expect(execute).toHaveBeenCalledWith(expect.anything(), 'fetch', {}, 'account-secret', false);
  });
  it('rejects upstream rejection and API-key disclosure', async () => {
    const http = new ConnectorHttp();
    const execute = jest.spyOn(http, 'execute').mockResolvedValue({ ok: false });
    await expect(http.readMapped(definition(), 'fetch', {}, 'secret')).rejects.toThrow('did not confirm');
    execute.mockResolvedValue({ ok: true, data: { id: 'secret', proxies: [] } });
    await expect(http.readMapped(definition(), 'fetch', {}, 'secret')).rejects.toThrow('credential');
  });
  it('refuses missing success/output mappings and write operations before network access', async () => {
    const http = new ConnectorHttp();
    const execute = jest.spyOn(http, 'execute');
    const missing = definition(); delete missing.operations.fetch.output;
    await expect(http.readMapped(missing, 'fetch', {}, 'secret')).rejects.toThrow('mappings');
    const write = definition(); write.operations.fetch.effect = 'write';
    await expect(http.readMapped(write, 'fetch', {}, 'secret')).rejects.toThrow('mappings');
    expect(execute).not.toHaveBeenCalled();
  });
});
