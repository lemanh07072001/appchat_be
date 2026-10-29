import { ConnectorDefinition, validateConnectorDefinition } from './connector-definition';
import { buildConnectorRequest } from './connector-request';

describe('Declarative provider request mapping', () => {
  function definition(): ConnectorDefinition {
    return { baseUrl: 'https://api.example.com/v1', auth: { type: 'bearer' },
      operations: { buy: { method: 'POST', path: '/orders/{packageId}', effect: 'write', timeoutMs: 10000,
        request: { path: { packageId: { path: '$.input.packageId' } }, query: { mode: { literal: 'reseller' } },
          body: { quantity: { path: '$.input.quantity' }, days: { path: '$.input.days' } } } } }, actions: {} };
  }
  it('builds path, query and JSON from explicit mappings without coercing typed input', () => {
    const result = buildConnectorRequest(definition(), 'buy', { packageId: 'abc', quantity: 2, days: 30 }, 'secret');
    expect(result.url.href).toBe('https://api.example.com/v1/orders/abc?mode=reseller');
    expect(result.headers.Authorization).toBe('Bearer secret');
    expect(JSON.parse(result.body!)).toEqual({ quantity: 2, days: 30 });
  });
  it('supports query authentication and form-encoded request bodies', () => {
    const d = definition();
    d.auth = { type: 'query', name: 'key' };
    d.operations.buy.request!.encoding = 'form';
    const result = buildConnectorRequest(d, 'buy', { packageId: 'abc', quantity: 2, days: 30 }, 'a+b&c');
    expect(result.url.searchParams.get('key')).toBe('a+b&c');
    expect(result.headers.Authorization).toBeUndefined();
    expect(result.body).toBe('quantity=2&days=30');
  });
  it('supports credential placeholders without changing the origin', () => {
    const d = definition(); d.auth = { type: 'path', name: 'credential' };
    d.operations.buy.path = '/{credential}/orders/{packageId}';
    expect(buildConnectorRequest(d, 'buy', { packageId: 'abc', quantity: 1, days: 30 }, 'secret').url.pathname).toBe('/v1/secret/orders/abc');
  });
  it('rejects missing fields and path traversal before any HTTP call', () => {
    for (const packageId of ['..', '.', '../admin', '%2e%2e', 'a?b', '//host', 'a\\b']) {
      expect(() => buildConnectorRequest(definition(), 'buy', { packageId, quantity: 1, days: 30 }, 'secret')).toThrow();
    }
    expect(() => buildConnectorRequest(definition(), 'buy', { packageId: 'abc' }, 'secret')).toThrow('Missing');
  });
  it('does not permit mappings into credentials or inherited properties', () => {
    const d = definition();
    d.operations.buy.request!.body = { token: { path: '$.credentials.token' } };
    expect(() => validateConnectorDefinition(d)).toThrow();
    d.operations.buy.request!.body = { token: { path: '$.input.missing.__proto__' } };
    expect(() => validateConnectorDefinition(d)).toThrow();
  });
  it('rejects body-bearing GET and object query parameters', () => {
    const d = definition(); d.operations.buy.method = 'GET';
    expect(() => validateConnectorDefinition(d)).toThrow();
    const other = definition(); other.operations.buy.request!.query = { bad: { literal: {} } };
    expect(() => buildConnectorRequest(other, 'buy', { packageId: 'abc', quantity: 1, days: 30 }, 'secret')).toThrow('scalar');
  });
});
