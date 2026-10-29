import { ConnectorDefinition, validateConnectorDefinition } from './connector-definition';
import { buildConnectorRequest } from './connector-request';

describe('Declarative provider filter assembly', () => {
  function definition(): ConnectorDefinition {
    return { baseUrl: 'https://api.homeproxy.vn/api', auth: { type: 'bearer' }, actions: { fetch: { operation: 'fetch' } },
      operations: { fetch: { method: 'GET', path: '/merchant/proxies', effect: 'read', timeoutMs: 30000,
        request: { query: { filter: { concat: [{ literal: 'orderId:$eq:string:' }, { path: '$.input.orderId' }] } } } } } };
  }
  it('builds HomeProxy order filters with no provider-specific runtime branch', () => {
    const request = buildConnectorRequest(definition(), 'fetch', { orderId: 'order-123' }, 'account-token');
    expect(request.url.searchParams.get('filter')).toBe('orderId:$eq:string:order-123');
    expect(request.url.pathname).toBe('/api/merchant/proxies');
  });
  it('URL-encodes the complete filter once without allowing query injection', () => {
    const request = buildConnectorRequest(definition(), 'fetch', { orderId: 'x&key=stolen#fragment' }, 'account-token');
    expect([...request.url.searchParams.keys()]).toEqual(['filter']);
    expect(request.url.searchParams.get('filter')).toBe('orderId:$eq:string:x&key=stolen#fragment');
    expect(request.url.hash).toBe('');
  });
  it.each([undefined, {}, [], Infinity])('rejects missing or nonscalar filter input %#', orderId => {
    expect(() => buildConnectorRequest(definition(), 'fetch', { orderId }, 'token')).toThrow();
  });
  it.each([
    { concat: [] }, { concat: Array(21).fill({ literal: 'x' }) },
    { concat: [{ path: '$.credentials.token' }] }, { concat: [{ concat: [{ literal: 'x' }] }] },
    { concat: [{ literal: {} }] }, { concat: [{ literal: 'x', path: '$.input.x' }] },
  ])('refuses unsafe filter expressions %#', expression => {
    const d = definition(); d.operations.fetch.request!.query!.filter = expression as any;
    expect(() => validateConnectorDefinition(d)).toThrow();
  });
  it('bounds assembled filter length', () => {
    expect(() => buildConnectorRequest(definition(), 'fetch', { orderId: 'x'.repeat(8192) }, 'token')).toThrow('limit');
  });
});
