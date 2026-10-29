import { ConnectorDefinition, validateConnectorDefinition } from './connector-definition';

type Endpoint = [string, 'GET' | 'POST', string, 'read' | 'write'];

/** Inventory from existing adapters, NOT an assertion of API compatibility. */
export function legacyConnectorTemplates() {
  const template = (code: string, name: string, baseUrl: string, endpoints: Endpoint[], warnings: string[] = []) => {
    const definition: ConnectorDefinition = {
      baseUrl, auth: code === 'proxyvn' ? { type: 'query', name: 'key' } : { type: 'bearer' }, actions: {},
      operations: Object.fromEntries(endpoints.map(([id, method, path, effect]) => [id, { method, path, effect, timeoutMs: 30000 }])),
    };
    return { code, name, definition: validateConnectorDefinition(definition), warnings: [
      'Draft inventory only. Authentication, request/response mappings and workflows must be verified before use.',
      'No existing partner, credential, order or adapter is modified.', ...warnings,
    ] };
  };
  const orderEndpoints: Endpoint[] = [
    ['buy', 'POST', '/orders', 'write'],
    ['fetch', 'GET', '/orders/{orderId}/proxies', 'read'],
    ['usage', 'GET', '/orders/{orderId}/usage', 'read'],
    ['check', 'GET', '/me', 'read'],
    ['topup', 'POST', '/orders/{orderId}/extend', 'write'],
    ['renew', 'POST', '/orders/{orderId}/renew', 'write'],
  ];
  return [
    template('homeproxy', 'HomeProxy', 'https://api.homeproxy.vn/api', [
      ['check', 'GET', '/merchant/orders', 'read'], ['buy', 'POST', '/merchant/orders', 'write'],
      ['fetch', 'GET', '/merchant/proxies', 'read'], ['renew', 'POST', '/merchant/orders/renewal-proxies', 'write'],
    ], ['Proxy retrieval requires filtering by orderId and pagination.', 'Rotate/cancel in the old adapter are marked TODO and are intentionally not imported.']),
    template('omoproxy', 'OmoProxy', 'https://api.omoproxy.com/v1', orderEndpoints,
      ['Renew requires a preview before committing.']),
    template('gpnip', 'GPNIP', 'https://api.gpnip.com/api/v1/reseller', [
      ...orderEndpoints, ['catalog', 'GET', '/packages', 'read'],
      ['packageDetail', 'GET', '/packages/{packageId}', 'read'], ['orders', 'GET', '/orders', 'read'],
    ], ['Initial endpoint inventory is incomplete: geo, password, whitelist, stock and preflight need a separate verified migration.',
      'Existing GPNIP_BASE_URL environment overrides are not copied automatically.']),
    template('twoproxy', '2Proxy', 'https://app.2proxy.vn/api', [
      ['buy', 'GET', '/proxy.php', 'write'], ['fetch', 'GET', '/proxy.php', 'read'], ['renew', 'GET', '/proxy.php', 'write'],
    ], ['Requires query-string authentication and sukien parameters; Bearer is a placeholder, not the actual authentication.']),
    template('proxyvn', 'ProxyVN', 'https://proxy.vn/apiv2', [
      ['buy', 'GET', '/muaproxy.php', 'write'], ['renew', 'GET', '/giahanproxy.php', 'write'], ['fetch', 'GET', '/listproxy.php', 'read'],
    ], ['Requires query-string authentication; renew tracks each proxy independently.']),
    template('proxysieutoc', 'ProxySieuToc', 'https://proxysieutoc.com/api/apiv1', [
      ['buy', 'POST', '/buy.php', 'write'],
    ], ['Requires query parameters and provider-specific authentication.']),
    template('proxyseller', 'ProxySeller', 'https://proxy-seller.com/personal/api/v1', [
      ['renew', 'POST', '/{credential}/prolong/make/{type}', 'write'],
    ], ['Credential is part of the API path: unsupported by the current transport.',
      'Only a partial inventory is supplied; purchase types and proxy retrieval require verified mapping.']),
    template('proxyv6', 'ProxyV6 — unverified', 'https://api.proxyv6.com/v1', [
      ['buy', 'POST', '/orders/buy', 'write'], ['renew', 'POST', '/orders/renew', 'write'],
      ['rotate', 'POST', '/orders/rotate', 'write'], ['cancel', 'POST', '/orders/cancel', 'write'],
    ], ['Old adapter explicitly contains a placeholder URL. Do not publish without real provider documentation.']),
  ];
}
