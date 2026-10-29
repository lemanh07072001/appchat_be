import { connectorActionReadiness, validateConnectorResult } from './connector-contract';
import { validateConnectorDefinition } from './connector-definition';

describe('Provider-independent action contracts', () => {
  it('accepts an asynchronous purchase only with a provider order ID', () => {
    expect(validateConnectorResult('buy', { fields: { provider_order_id: 'order1' } })).toBeDefined();
    expect(() => validateConnectorResult('buy', { fields: {} })).toThrow();
  });
  it('validates proxy protocol, host and port before delivery', () => {
    const proxy = { host: '1.2.3.4', port: 8080, protocol: 'http' };
    expect(validateConnectorResult('fetch', { fields: {}, items: [proxy] })).toBeDefined();
    for (const change of [{ port: 0 }, { port: 65536 }, { host: 'https://bad/path' }, { protocol: 'unknown' }]) {
      expect(() => validateConnectorResult('fetch', { fields: {}, items: [{ ...proxy, ...change }] })).toThrow();
    }
  });
  it('never treats an absent success result as a successful mutation', () => {
    for (const action of ['renew', 'cancel', 'topup', 'password', 'allowedIps'] as const) {
      expect(() => validateConnectorResult(action, { fields: {} })).toThrow();
      expect(validateConnectorResult(action, { fields: { success: true } })).toBeDefined();
    }
  });
  it('rejects negative usage and incomplete catalog items', () => {
    expect(() => validateConnectorResult('usage', { fields: { used_gb: -1 } })).toThrow();
    expect(() => validateConnectorResult('catalog', { fields: {}, items: [{ id: 'a' }] })).toThrow();
  });
  it('reports write actions as unavailable even with valid mappings', () => {
    const definition = validateConnectorDefinition({ baseUrl: 'https://api.example.com', auth: { type: 'bearer' },
      operations: { buy: { method: 'POST', path: '/orders', effect: 'write', timeoutMs: 1000,
        response: { success: { path: '$.ok', equals: true } }, output: { fields: {
          provider_order_id: { path: '$.id', type: 'string', required: true },
        } } } }, actions: { buy: { operation: 'buy' } } });
    expect(connectorActionReadiness(definition)).toEqual([{ action: 'buy', ready: false,
      issues: ['Paid/write execution is not connected to order ledger'] }]);
  });
});
