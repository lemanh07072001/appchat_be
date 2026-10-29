import { Logger } from '@nestjs/common';
import { HomeproxyProvider } from '../proxy-providers/impl/homeproxy.provider';
import { homeproxyPurchaseCandidate } from './homeproxy-template';
import { buildConnectorRequest } from './connector-request';
import { connectorSucceeded } from './connector-success';
import { mapConnectorOutput } from './connector-output';
import { assertPurchasePackage } from './connector-purchase-policy';

/** Execute the actual legacy adapter against a mock transport, never a live purchase. */
describe('HomeProxy legacy purchase compatibility', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 201,
      json: async () => ({ id: 'sample-provider-order' }) });
    global.fetch = fetchMock;
  });
  afterEach(() => { global.fetch = realFetch; jest.restoreAllMocks(); });

  it.each([{ days: 1, quantity: 1 }, { days: 7, quantity: 2 }, { days: 30, quantity: 10 }])(
    'matches the actual legacy URL, method, auth and JSON for $days days / $quantity proxies', async ({ days, quantity }) => {
      await new HomeproxyProvider().buy({ token_api: 'sample-token', quantity, duration_days: days,
        id_service: 'sample-product', protocol: 'http', isp: 'VIETTEL', proxy_type: 'static',
        username: 'sample-user', password: 'sample-password' });
      const [url, init] = fetchMock.mock.calls[0];
      const request = buildConnectorRequest(homeproxyPurchaseCandidate(), 'buy', {
        packageId: 'sample-product', quantity, durationDays: days, protocol: 'http',
        username: 'sample-user', password: 'sample-password',
      }, 'sample-token');
      expect(request.url.href).toBe(url);
      expect(request.method).toBe(init.method);
      expect(request.headers.Authorization).toBe(init.headers.Authorization);
      expect(JSON.parse(request.body!)).toEqual(JSON.parse(init.body));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  it('maps an accepted string order ID consistently with the legacy adapter', async () => {
    const legacy = await new HomeproxyProvider().buy({ token_api: 'sample-token', quantity: 1,
      duration_days: 1, id_service: 'sample-product', username: 'sample-user', password: 'sample-password' });
    const operation = homeproxyPurchaseCandidate().operations.buy;
    const response = { id: 'sample-provider-order' };
    expect(connectorSucceeded(response, operation.response!.success)).toBe(true);
    expect(mapConnectorOutput(operation.output!, response).fields.provider_order_id).toBe(legacy.provider_order_id);
    expect(legacy.proxies).toEqual([]);
  });
  it('keeps request construction strict: credential generation belongs to checkout preparation', async () => {
    await new HomeproxyProvider().buy({ token_api: 'sample-token', quantity: 1,
      duration_days: 1, id_service: 'sample-product' });
    const product = JSON.parse(fetchMock.mock.calls[0][1].body).products[0];
    expect(product.user).toMatch(/^u[0-9a-f]{12}$/);
    expect(product.password).toMatch(/^p[0-9a-f]{24}$/);
    expect(() => buildConnectorRequest(homeproxyPurchaseCandidate(), 'buy', {
      packageId: 'sample-product', quantity: 1, durationDays: 1, protocol: 'http',
    }, 'sample-token')).toThrow('Missing provider input');
  });
  const combinations = (['VIETTEL', 'VNPT', 'FPT'] as const).flatMap(provider =>
    (['http', 'socks5'] as const).map(protocol => ({ provider, protocol })));
  it.each(combinations)('matches legacy static $provider / $protocol without provider or protocol fallback', async ({ provider, protocol }) => {
    await new HomeproxyProvider().buy({ token_api: 'sample-token', quantity: 2, duration_days: 7,
      id_service: 'sample-product', protocol, isp: provider, proxy_type: 'static',
      username: 'sample-user', password: 'sample-password' });
    const definition = homeproxyPurchaseCandidate(provider, protocol);
    const request = buildConnectorRequest(definition, 'buy', { packageId: 'sample-product', quantity: 2,
      durationDays: 7, protocol, username: 'sample-user', password: 'sample-password' }, 'sample-token');
    expect(JSON.parse(request.body!)).toEqual(JSON.parse(fetchMock.mock.calls[0][1].body));
    expect(definition.purchasePolicy!.protocols).toEqual([protocol]);
    expect(definition.purchasePolicy!.catalog).toContainEqual({ field: 'provider', equals: provider });
    const item = { provider, categoryType: 1, billingUnit: 'ngày', statusId: 1 };
    expect(() => assertPurchasePackage(definition.purchasePolicy, item)).not.toThrow();
    expect(() => assertPurchasePackage(definition.purchasePolicy, { ...item,
      provider: provider === 'VIETTEL' ? 'VNPT' : 'VIETTEL' })).toThrow();
    expect(() => assertPurchasePackage(definition.purchasePolicy, { ...item, categoryType: 2 })).toThrow();
    expect(() => buildConnectorRequest(definition, 'buy', { protocol: protocol === 'http' ? 'socks5' : 'http' },
      'sample-token')).toThrow('purchase policy');
  });
  it.each([{ provider: 'OTHER', protocol: 'http' }, { provider: 'VIETTEL', protocol: 'https' },
    { provider: 'HOMEPROXY', protocol: 'socks5' }])('rejects unsupported template selections %#', ({ provider, protocol }) => {
    expect(() => homeproxyPurchaseCandidate(provider as any, protocol as any)).toThrow('Unsupported');
  });
});
