import { validateConnectorDefinition } from './connector-definition';
import { buildConnectorRequest } from './connector-request';
import { ConnectorHttp } from './connector-http.service';
import { validateConnectorResult } from './connector-contract';

/** Adapter-derived synthetic samples, NOT a verified provider template or live API test. */
describe('HomeProxy-shaped declarative contract compatibility (offline)', () => {
  function definition() {
    return validateConnectorDefinition({ baseUrl: 'https://api.homeproxy.vn/api', auth: { type: 'bearer' },
      actions: { buy: { operation: 'buy' }, fetch: { operation: 'fetch' } }, operations: {
        buy: { method: 'POST', path: '/merchant/orders', effect: 'write', timeoutMs: 30000,
          request: { body: { paymentMethod: { literal: 'WALLET' }, products: { array: [{ object: {
            isCdk: { literal: false }, dayOfUse: { path: '$.input.durationDays' }, rotateInterval: { literal: 0 },
            user: { path: '$.input.username' }, password: { path: '$.input.password' },
            protocolType: { literal: 'SOCKS' }, provider: { literal: 'VIETTEL' },
            quantity: { path: '$.input.quantity' }, product: { object: { id: { path: '$.input.packageId' } } },
          } }] } } },
        },
        fetch: { method: 'GET', path: '/merchant/proxies', effect: 'read', timeoutMs: 30000,
          request: { query: { filter: { concat: [{ literal: 'orderId:$eq:string:' }, { path: '$.input.orderId' }] } } },
          // Explicit synthetic marker. Actual provider success semantics remain unverified.
          response: { success: { path: '$.sampleSuccess', equals: true } },
          pagination: { pageParameter: 'page', pageSizeParameter: 'limit', pageSize: 100, maxPages: 50, hasNextPath: '$.hasNextPage' },
          output: { items: { path: '$.data', fields: {
            host: { path: '$.proxy.ipaddress.ip', type: 'string', required: true },
            port: { path: '$.proxy.port', type: 'number', required: true },
            username: { path: '$.proxy.username', type: 'string', required: true },
            password: { path: '$.proxy.password', type: 'string', required: true },
            protocol: { path: '$.protocol', type: 'string', required: true,
              values: [{ from: 'SOCKS', to: 'socks5' }, { from: 'HTTP', to: 'http' }] },
          } } },
        },
      } });
  }
  const sample = (host: string) => ({ protocol: 'SOCKS', proxy: { port: 1080, username: 'proxy-user',
    password: 'proxy-password', ipaddress: { ip: host } } });

  it('constructs the nested purchase request without executing a write', () => {
    const request = buildConnectorRequest(definition(), 'buy', { packageId: 'sample-product', durationDays: 30,
      quantity: 2, username: 'proxy-user', password: 'proxy-password' }, 'account-secret');
    expect(JSON.parse(request.body!)).toEqual({ paymentMethod: 'WALLET', products: [{ isCdk: false,
      dayOfUse: 30, rotateInterval: 0, user: 'proxy-user', password: 'proxy-password', protocolType: 'SOCKS',
      provider: 'VIETTEL', quantity: 2, product: { id: 'sample-product' } }] });
  });
  it('combines order filtering, pagination and protocol normalization into the generic delivery contract', async () => {
    const http = new ConnectorHttp();
    const execute = jest.spyOn(http, 'execute').mockResolvedValueOnce({ sampleSuccess: true, hasNextPage: true, data: [sample('proxy1.example.com')] })
      .mockResolvedValueOnce({ sampleSuccess: true, hasNextPage: false, data: [sample('proxy2.example.com')] });
    const result = validateConnectorResult('fetch', await http.readMapped(definition(), 'fetch', { orderId: 'sample-order' }, 'account-secret'));
    expect(result.items).toHaveLength(2);
    expect(result.items!.map(proxy => proxy.protocol)).toEqual(['socks5', 'socks5']);
    for (const [index, call] of execute.mock.calls.entries()) {
      const request = buildConnectorRequest(call[0], call[1], call[2], call[3]);
      expect(request.url.searchParams.get('filter')).toBe('orderId:$eq:string:sample-order');
      expect(request.url.searchParams.get('page')).toBe(String(index + 1));
      expect(request.url.searchParams.get('limit')).toBe('100');
      expect(call[4]).toBe(false);
    }
  });
  it('does not return a partial delivery when a later page has an unknown protocol', async () => {
    const http = new ConnectorHttp();
    jest.spyOn(http, 'execute').mockResolvedValueOnce({ sampleSuccess: true, hasNextPage: true, data: [sample('proxy1.example.com')] })
      .mockResolvedValueOnce({ sampleSuccess: true, hasNextPage: false, data: [{ ...sample('proxy2.example.com'), protocol: 'UNKNOWN' }] });
    await expect(http.readMapped(definition(), 'fetch', { orderId: 'sample-order' }, 'account-secret')).rejects.toThrow('does not match');
  });
});
