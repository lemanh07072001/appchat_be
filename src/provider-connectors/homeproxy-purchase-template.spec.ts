import { homeproxyPurchaseCandidate } from './homeproxy-template';
import { buildConnectorRequest } from './connector-request';
import { connectorSucceeded } from './connector-success';
import { mapConnectorOutput } from './connector-output';
import { validateConnectorResult } from './connector-contract';

describe('HomeProxy purchase candidate, no live writes', () => {
  it('builds the documented nested WALLET request with typed day count and quantity', () => {
    const request = buildConnectorRequest(homeproxyPurchaseCandidate(), 'buy', { packageId: 'viettel-product',
      quantity: 2, durationDays: 1, protocol: 'http', username: 'sample-user', password: 'sample-password' }, 'sample-token');
    expect(request.method).toBe('POST');
    expect(request.url.pathname).toBe('/api/merchant/orders');
    expect(JSON.parse(request.body!)).toEqual({ paymentMethod: 'WALLET', products: [{ isCdk: false,
      dayOfUse: 1, rotateInterval: 0, user: 'sample-user', password: 'sample-password', protocolType: 'HTTP',
      provider: 'VIETTEL', quantity: 2, product: { id: 'viettel-product' } }] });
  });
  it.each([{}, { id: null }, { id: '' }, { id: '  ' }, { id: 42 }, { message: 'notEnoughProxy' }])('rejects missing/invalid acceptance identity %#', response => {
    expect(connectorSucceeded(response, homeproxyPurchaseCandidate().operations.buy.response!.success)).toBe(false);
  });
  it('accepts a real string ID and maps it through the generic contract', () => {
    const operation = homeproxyPurchaseCandidate().operations.buy;
    const sample = { id: 'sample-upstream-order' };
    expect(connectorSucceeded(sample, operation.response!.success)).toBe(true);
    expect(validateConnectorResult('buy', mapConnectorOutput(operation.output!, sample)).fields.provider_order_id).toBe(sample.id);
  });
  it('requires credentials rather than sending missing input to the provider', () => {
    expect(() => buildConnectorRequest(homeproxyPurchaseCandidate(), 'buy', { packageId: 'p', quantity: 1, durationDays: 1, protocol: 'http' }, 'token')).toThrow('Missing provider input');
  });
  it.each([undefined, null, '', '   ', 123, false, 'secret\nvalue', 'a'.repeat(8193)])(
    'rejects absent or invalid credential text %# without exposing it', value => {
      for (const field of ['username', 'password']) {
        expect(() => buildConnectorRequest(homeproxyPurchaseCandidate(), 'buy', {
          packageId: 'p', quantity: 1, durationDays: 1, protocol: 'http',
          username: 'sample-user', password: 'sample-password', [field]: value,
        }, 'token')).toThrow(`Missing provider input or invalid text: ${field}`);
      }
    });
  it('maps millisecond expiry exactly and rejects absent expiry', () => {
    const output = homeproxyPurchaseCandidate().operations.fetch.output!;
    const item = { id: 1457674, orderId: 'sample-order', expiredAt: 1800000000000, protocol: 'HTTP',
      proxy: { port: 8080, username: 'sample-user', password: 'sample-pass', ipaddress: { ip: 'proxy.example.com' } } };
    expect(mapConnectorOutput(output, { data: [item] }).items![0].expiresAt).toBe(new Date(item.expiredAt).toISOString());
    expect(() => mapConnectorOutput(output, { data: [{ ...item, expiredAt: undefined }] })).toThrow();
    // Renewal acts per proxy, so a delivery without the provider's own proxy id is unusable.
    expect(() => mapConnectorOutput(output, { data: [{ ...item, id: undefined }] })).toThrow();
    expect(mapConnectorOutput(output, { data: [item] }).items![0].id).toBe(item.id);
  });
  it('builds the verified renewal request and only accepts the provider success envelope', () => {
    const definition = homeproxyPurchaseCandidate();
    const request = buildConnectorRequest(definition, 'renew',
      { providerProxyIds: [1683054, 1683055], durationDays: 7 }, 'token');
    expect(JSON.parse(request.body as string)).toEqual({ userProxyIds: [1683054, 1683055],
      dayOfRenewal: 7, isRenewal: false, categoryTypeId: 1 });
    expect(String(request.url)).toBe('https://api.homeproxy.vn/api/merchant/orders/renewal-proxies');
    const output = definition.operations.renew!.output!;
    expect(validateConnectorResult('renew', mapConnectorOutput(output, { status: 'success' })).fields.success).toBe(true);
    for (const body of [{ status: 'pending' }, { status: true }, {}, { status: 'Success' }]) {
      expect(() => validateConnectorResult('renew', mapConnectorOutput(output, body))).toThrow();
    }
  });
  it('refuses a renewal without proxy identities or duration', () => {
    for (const input of [{ durationDays: 1 }, { providerProxyIds: [1] }]) {
      expect(() => buildConnectorRequest(homeproxyPurchaseCandidate(), 'renew', input, 'token')).toThrow('Missing provider input');
    }
  });
  it('maps a mixed catalog without accepting null-provider combo packages', () => {
    const definition = homeproxyPurchaseCandidate();
    const mapped = mapConnectorOutput(definition.operations.catalog.output!, { data: [
      { id: 'static', name: 'VIETTEL', price: 1000, provider: 'VIETTEL', status: { id: 1 },
        category: { unit: 'ngày', categorytype: { id: 1 } } },
      { id: 'combo', name: 'Combo', price: 100000, provider: null, status: { id: 1 },
        category: { unit: 'ngày', categorytype: { id: 4 } } },
    ] });
    expect(mapped.items).toHaveLength(2);
    expect(mapped.items![0]).toMatchObject({ provider: 'VIETTEL', statusId: 1 });
    expect(mapped.items![1]).not.toHaveProperty('provider');
  });
});
