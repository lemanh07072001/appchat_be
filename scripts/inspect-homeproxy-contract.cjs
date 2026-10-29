/* Evidence collection only: upstream GET, sanitized aggregate output, no purchases. */
require('dotenv').config({ quiet: true });
require('ts-node/register/transpile-only');
const { createConnection } = require('mongoose');
const { ConnectorHttp } = require('../src/provider-connectors/connector-http.service');
const { homeproxyPurchaseCandidate } = require('../src/provider-connectors/homeproxy-template');
const { validateConnectorResult } = require('../src/provider-connectors/connector-contract');
const { mapConnectorOutput } = require('../src/provider-connectors/connector-output');
const { assertPurchasePackage } = require('../src/provider-connectors/connector-purchase-policy');

async function main() {
  const db = await createConnection(process.env.MONGO_URI, { serverSelectionTimeoutMS: 5000 }).asPromise();
  try {
    if (db.name !== 'fastproxy') throw Error();
    const partner = await db.collection('partners').findOne({ code: 'homeproxy' }, { projection: { token_api: 1 } });
    const http = new ConnectorHttp();
    const read = path => http.execute({ baseUrl: 'https://api.homeproxy.vn/api', auth: { type: 'bearer' }, actions: {},
      operations: { inspect: { method: 'GET', path, effect: 'read', timeoutMs: 20000,
        request: { query: { page: { literal: 1 }, limit: { literal: 100 } } } } } }, 'inspect', {}, partner.token_api.trim(), false);
    const products = await read('/merchant/products');
    const candidate = homeproxyPurchaseCandidate();
    const mappedCatalog = validateConnectorResult('catalog', mapConnectorOutput(candidate.operations.catalog.output, products));
    const eligible = mappedCatalog.items.filter(item => {
      try { assertPurchasePackage(candidate.purchasePolicy, item); return true; } catch { return false; }
    });
    console.log(JSON.stringify({ kind: 'candidate-live-catalog', mappedItems: mappedCatalog.items.length,
      eligibleItems: eligible.length, eligibleNames: eligible.map(item => item.name),
      hasNextPage: products.hasNextPage, durationLimitsVerified: false, writeAttempted: false }));
    const matrix = ['VIETTEL', 'VNPT', 'FPT'].flatMap(provider => ['http', 'socks5'].map(protocol => {
      const definition = homeproxyPurchaseCandidate(provider, protocol);
      const eligibleItems = mappedCatalog.items.filter(item => {
        try { assertPurchasePackage(definition.purchasePolicy, item); return true; } catch { return false; }
      });
      return { provider, protocol, eligibleCount: eligibleItems.length,
        catalogMatchOnly: true, protocolAvailabilityVerified: false, livePurchaseVerified: false };
    }));
    console.log(JSON.stringify({ kind: 'static-purchase-matrix', matrix, writeAttempted: false }));
    console.log(JSON.stringify({ kind: 'catalog', total: products.total, hasNextPage: products.hasNextPage,
      products: products.data.map(p => ({ id: p.id, name: p.name, provider: p.provider, price: p.price,
        status: p.status?.id, category: { name: p.category?.name, unit: p.category?.unit, period: p.category?.period, type: p.category?.categorytype?.id } })) }));
    const orders = await read('/merchant/orders');
    const lines = orders.data.flatMap(o => (o.products ?? []).map(p => ({
      dayOfUse: p.dayOfUse, quantity: p.quantity, provider: p.provider, protocolType: p.protocolType,
      price: p.price, originPrice: p.originPrice, isCdk: p.isCdk,
      productId: p.product?.id, productName: p.product?.name,
      orderStatus: o.status?.id, orderKeys: Object.keys(o),
    })));
    console.log(JSON.stringify({ kind: 'historical-order-contract', total: orders.total, hasNextPage: orders.hasNextPage,
      lines: lines.slice(0, 20) }));
    const proxies = await read('/merchant/proxies');
    const orderId = proxies.data.find(p => typeof p.orderId === 'string')?.orderId;
    if (orderId) {
      const fetched = validateConnectorResult('fetch', await http.readMapped(homeproxyPurchaseCandidate(), 'fetch',
        { orderId }, partner.token_api.trim()));
      console.log(JSON.stringify({ kind: 'candidate-live-fetch', itemCount: fetched.items.length,
        everyOrderMatches: fetched.items.every(p => p.orderId === orderId),
        everyExpiryMapped: fetched.items.every(p => typeof p.expiresAt === 'string' && Number.isFinite(Date.parse(p.expiresAt))),
        writeAttempted: false }));
    }
    const expiry = proxies.data.map(p => {
      const raw = p.expiredAt;
      const numeric = typeof raw === 'number';
      const seconds = numeric && raw >= 946684800 && raw < 4102444800;
      const milliseconds = numeric && raw >= 946684800000 && raw < 4102444800000;
      const start = Date.parse(p.createdAt);
      const end = seconds ? raw * 1000 : milliseconds ? raw : NaN;
      return { keys: Object.keys(p), expiryType: typeof raw, plausibleUnit: seconds ? 'unixSeconds' : milliseconds ? 'unixMilliseconds' : 'unverified',
        leaseDaysFromCreation: Number.isFinite(start) && Number.isFinite(end) ? Math.round((end - start) / 86400000 * 1000) / 1000 : null,
        expiryMatchesDateString: Object.entries(p).filter(([k, v]) => /expir|end/i.test(k) && typeof v === 'string' && Date.parse(v) === end).map(([k]) => k),
        protocol: p.protocol };
    });
    console.log(JSON.stringify({ kind: 'proxy-expiry-contract', total: proxies.total, hasNextPage: proxies.hasNextPage, samples: expiry.slice(0, 10) }));
    const units = expiry.reduce((result, item) => { result[item.plausibleUnit] = (result[item.plausibleUnit] ?? 0) + 1; return result; }, {});
    const leaseMatches = proxies.data.map(p => {
      const days = p.order?.products?.[0]?.dayOfUse;
      const created = Date.parse(p.createdAt);
      return { durationDays: days, actualDays: Number.isFinite(created) && typeof p.expiredAt === 'number'
        ? Math.round((p.expiredAt - created) / 86400000 * 1000) / 1000 : null };
    });
    console.log(JSON.stringify({ kind: 'expiry-summary', inspected: expiry.length, units, leaseSamples: leaseMatches.slice(0, 10) }));
    const services = await db.collection('services').find({ $or: [
      { partner: { $in: [partner._id, String(partner._id)] } },
      { id_service: { $in: products.data.map(product => product.id) } },
    ] }, { projection: {
      name: 1, id_service: 1, pricing: 1, protocol: 1, pricing_mode: 1, proxy_type: 1, connector_binding: 1,
    } }).toArray();
    console.log(JSON.stringify({ kind: 'service-cutover-audit', changed: false, services: services.map(service => {
      const product = products.data.find(p => p.id === service.id_service);
      const issues = [];
      if (!product) issues.push('package-not-in-live-catalog');
      if (product && (product.category?.categorytype?.id !== 1 || product.category?.unit !== 'ngày')) issues.push('not-static-daily-package');
      if (product && product.provider !== 'VIETTEL') issues.push('candidate-provider-is-viettel-only');
      if (service.pricing_mode !== 'duration') issues.push('not-duration-pricing');
      if ((service.protocol ?? []).some(p => p.toLowerCase() !== 'http')) issues.push('candidate-http-only');
      if (service.connector_binding) issues.push('already-bound-preserve-existing');
      const tiers = Object.entries(service.pricing ?? {}).map(([days, tier]) => ({ days: Number(days), salePrice: tier.price, configuredCost: tier.cost,
        catalogListCost: product?.category?.unit === 'ngày' ? Number(days) * product.price : null }));
      if (!tiers.length) issues.push('no-sale-tiers');
      return { name: service.name, productFound: !!product, productName: product?.name, issues, tiers, eligibleForAutomaticCutover: false };
    }) }));
  } finally { await db.close(); }
  for (const path of ['/docs', '/docs-json', '/swagger', '/api-json', '/api/docs-json']) {
    try {
      const response = await fetch('https://api.homeproxy.vn' + path, { signal: AbortSignal.timeout(10000), redirect: 'error' });
      console.log(JSON.stringify({ kind: 'public-docs', path, status: response.status, contentType: response.headers.get('content-type') }));
      await response.body?.cancel();
    } catch { console.log(JSON.stringify({ kind: 'public-docs', path, unavailable: true })); }
  }
}
main().catch(() => { console.error('Contract inspection failed; sensitive details suppressed'); process.exitCode = 1; });
