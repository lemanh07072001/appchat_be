import { BadRequestException } from '@nestjs/common';
import { ConnectorDefinition, validateConnectorDefinition } from './connector-definition';

/** Verified read-only endpoints. Purchase is intentionally absent until its contract is verified. */
export function homeproxyReadOnlyTemplate(): ConnectorDefinition {
  return validateConnectorDefinition({
    baseUrl: 'https://api.homeproxy.vn/api', auth: { type: 'bearer' },
    actions: { check: { operation: 'check' }, catalog: { operation: 'catalog' }, fetch: { operation: 'fetch' } },
    operations: {
      check: { method: 'GET', path: '/merchant/products', effect: 'read', timeoutMs: 20000,
        request: { query: { page: { literal: 1 }, limit: { literal: 1 } } },
        response: { success: { path: '$.data', type: 'array' } } },
      catalog: { method: 'GET', path: '/merchant/products', effect: 'read', timeoutMs: 20000,
        response: { success: { path: '$.data', type: 'array' } },
        pagination: { pageParameter: 'page', pageSizeParameter: 'limit', pageSize: 100, maxPages: 50, hasNextPath: '$.hasNextPage' },
        output: { items: { path: '$.data', fields: {
          id: { path: '$.id', type: 'string', required: true },
          name: { path: '$.name', type: 'string', required: true },
          price: { path: '$.price', type: 'number', required: true },
        } } } },
      fetch: { method: 'GET', path: '/merchant/proxies', effect: 'read', timeoutMs: 20000,
        request: { query: { filter: { concat: [{ literal: 'orderId:$eq:string:' }, { path: '$.input.orderId' }] } } },
        response: { success: { path: '$.data', type: 'array' } },
        pagination: { pageParameter: 'page', pageSizeParameter: 'limit', pageSize: 100, maxPages: 50, hasNextPath: '$.hasNextPage' },
        output: { items: { path: '$.data', fields: {
          orderId: { path: '$.orderId', type: 'string', required: true },
          host: { path: '$.proxy.ipaddress.ip', type: 'string', required: true },
          port: { path: '$.proxy.port', type: 'number', required: true },
          username: { path: '$.proxy.username', type: 'string', required: true },
          password: { path: '$.proxy.password', type: 'string', required: true },
          protocol: { path: '$.protocol', type: 'string', required: true, values: [
            { from: 'HTTP', to: 'http' }, { from: 'HTTPS', to: 'https' },
            { from: 'SOCKS', to: 'socks5' }, { from: 'SOCKS5', to: 'socks5' },
          ] },
        } } } },
    },
  });
}

/** Purchase candidate matching the legacy adapter, NOT a live purchase certification.
 * One immutable ISP/protocol pair per definition; never reuse for rotating/combo/monthly.
 */
export function homeproxyPurchaseCandidate(provider: 'VIETTEL' | 'VNPT' | 'FPT' = 'VIETTEL',
  protocol: 'http' | 'socks5' = 'http'): ConnectorDefinition {
  if (!['VIETTEL', 'VNPT', 'FPT'].includes(provider) || !['http', 'socks5'].includes(protocol)) {
    throw new BadRequestException('Unsupported HomeProxy static purchase selection');
  }
  const definition = homeproxyReadOnlyTemplate();
  definition.purchasePolicy = { protocols: [protocol], requiredTextInputs: ['username', 'password'],
    credentialGeneration: 'hex-pair-v1', catalog: [
    { field: 'provider', equals: provider },
    { field: 'categoryType', equals: 1 },
    { field: 'billingUnit', equals: 'ngày' },
    { field: 'statusId', equals: 1 },
  ] };
  Object.assign(definition.operations.catalog.output!.items!.fields, {
    provider: { path: '$.provider', type: 'string' },
    categoryType: { path: '$.category.categorytype.id', type: 'number', required: true },
    billingUnit: { path: '$.category.unit', type: 'string', required: true },
    statusId: { path: '$.status.id', type: 'number' },
  });
  definition.operations.fetch.output!.items!.fields.expiresAt = { path: '$.expiredAt', type: 'unixMilliseconds', required: true };
  // Per-proxy identity upstream, required to act on one proxy later (renewal takes userProxyIds).
  definition.operations.fetch.output!.items!.fields.id = { path: '$.id', type: 'number', required: true };
  // Hostname alias for the same proxy. Optional: some IPs are delivered without one.
  definition.operations.fetch.output!.items!.fields.domain = { path: '$.proxy.ipaddress.domain', type: 'string' };
  // Where the IP actually sits. Display only; eligibility still comes from purchasePolicy.
  definition.operations.fetch.output!.items!.fields.isp = { path: '$.proxy.ipaddress.provider', type: 'string' };
  definition.operations.fetch.output!.items!.fields.location = { path: '$.proxy.ipaddress.location', type: 'string' };
  definition.operations.buy = {
    method: 'POST', path: '/merchant/orders', effect: 'write', timeoutMs: 30000,
    request: { body: { paymentMethod: { literal: 'WALLET' }, products: { array: [{ object: {
      isCdk: { literal: false }, dayOfUse: { path: '$.input.durationDays' }, rotateInterval: { literal: 0 },
      user: { path: '$.input.username' }, password: { path: '$.input.password' },
       protocolType: { literal: protocol === 'socks5' ? 'SOCKS' : 'HTTP' }, provider: { literal: provider },
      quantity: { path: '$.input.quantity' }, product: { object: { id: { path: '$.input.packageId' } } },
    } }] } } },
    response: { success: { path: '$.id', type: 'nonemptyString' } },
    output: { fields: { provider_order_id: { path: '$.id', type: 'string', required: true } } },
  };
  definition.actions.buy = { operation: 'buy' };
  // Immediate renewal of specific proxies. The provider retired auto-renewal: it answers 422
  // `isRenewal: autoRenewalDisabled` unless isRenewal is false with dayOfRenewal > 0. Verified
  // 2026-10-30: 201 `{"status":"success"}` extended one proxy by exactly 24h from its old expiry.
  definition.operations.renew = {
    method: 'POST', path: '/merchant/orders/renewal-proxies', effect: 'write', timeoutMs: 30000,
    request: { body: {
      userProxyIds: { path: '$.input.providerProxyIds' },
      dayOfRenewal: { path: '$.input.durationDays' },
      isRenewal: { literal: false },
      categoryTypeId: { literal: 1 },
    } },
    response: { success: { path: '$.status', equals: 'success' } },
    output: { fields: { success: { path: '$.status', type: 'boolean', required: true,
      values: [{ from: 'success', to: true }] } } },
  };
  definition.actions.renew = { operation: 'renew' };
  return validateConnectorDefinition(definition);
}
