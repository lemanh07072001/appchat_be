/* Read-only contract discovery. Never prints credentials, order IDs or proxy values. */
require('dotenv').config({ quiet: true });
require('ts-node/register/transpile-only');
const { createConnection } = require('mongoose');
const { ConnectorHttp } = require('../src/provider-connectors/connector-http.service');
const { mapConnectorOutput } = require('../src/provider-connectors/connector-output');
const { validateConnectorResult } = require('../src/provider-connectors/connector-contract');

function shape(value, depth = 0) {
  if (depth > 5) return typeof value;
  if (value === null) return 'null';
  if (Array.isArray(value)) return { type: 'array', sample: value.length ? shape(value[0], depth + 1) : null };
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 80)
    .map(([key, item]) => [key, shape(item, depth + 1)]));
  return typeof value;
}

async function main() {
  if (!process.env.MONGO_URI) throw Error('MONGO_URI is required');
  const db = await createConnection(process.env.MONGO_URI, { serverSelectionTimeoutMS: 5000 }).asPromise();
  try {
    const partner = await db.collection('partners').findOne({ code: 'homeproxy' }, { projection: { token_api: 1 } });
    if (!partner || typeof partner.token_api !== 'string' || !partner.token_api.trim()) throw Error('HomeProxy credential unavailable');
    const http = new ConnectorHttp();
    let sampleOrderId;
    for (const [name, path] of [['orders', '/merchant/orders'], ['proxies', '/merchant/proxies'], ['products', '/merchant/products']]) {
      const definition = { baseUrl: 'https://api.homeproxy.vn/api', auth: { type: 'bearer' }, actions: {},
        operations: { inspect: { method: 'GET', path, effect: 'read', timeoutMs: 20000,
          request: { query: { page: { literal: 1 }, limit: { literal: 1 } } } } } };
      try {
        const response = await http.execute(definition, 'inspect', {}, partner.token_api.trim(), false);
        const markers = {};
        for (const key of ['success', 'statusCode', 'hasNextPage']) {
          if (typeof response?.[key] === 'boolean' || typeof response?.[key] === 'number') markers[key] = response[key];
        }
        console.log(JSON.stringify({ operation: name, ok: true, markers, shape: shape(response) }));
        if (name === 'orders' && typeof response?.data?.[0]?.id === 'string') sampleOrderId = response.data[0].id;
        if (name === 'proxies' && typeof response?.data?.[0]?.orderId === 'string') sampleOrderId = response.data[0].orderId;
        if (name === 'proxies' && sampleOrderId) {
          definition.operations.inspect.request.query.filter = { concat: [{ literal: 'orderId:$eq:string:' }, { path: '$.input.orderId' }] };
          const filtered = await http.execute(definition, 'inspect', { orderId: sampleOrderId }, partner.token_api.trim(), false);
          const items = filtered?.data;
          const matches = Array.isArray(items) && items.length > 0 && items.every(item => item.orderId === sampleOrderId);
          const knownProtocols = Array.isArray(items) && items.every(item => ['HTTP', 'HTTPS', 'SOCKS', 'SOCKS5'].includes(item.protocol));
          console.log(JSON.stringify({ operation: 'order-filter', ok: matches, nonempty: Array.isArray(items) && items.length > 0,
            allItemsMatchOrder: matches, protocolsInKnownSet: knownProtocols, continuationIsBoolean: typeof filtered?.hasNextPage === 'boolean' }));
          if (!matches) process.exitCode = 1;
          if (matches) {
            const mapping = { items: { path: '$.data', fields: {
              host: { path: '$.proxy.ipaddress.ip', type: 'string', required: true },
              port: { path: '$.proxy.port', type: 'number', required: true },
              username: { path: '$.proxy.username', type: 'string', required: true },
              password: { path: '$.proxy.password', type: 'string', required: true },
              protocol: { path: '$.protocol', type: 'string', required: true,
                values: [{ from: 'SOCKS', to: 'socks5' }, { from: 'HTTP', to: 'http' }] },
            } } };
            try {
              validateConnectorResult('fetch', mapConnectorOutput(mapping, filtered));
              console.log(JSON.stringify({ operation: 'filtered-fetch-output-contract', ok: true, persisted: false }));
            } catch {
              console.log(JSON.stringify({ operation: 'filtered-fetch-output-contract', ok: false, persisted: false }));
              process.exitCode = 1;
            }
          }
        }
      } catch {
        console.log(JSON.stringify({ operation: name, ok: false, message: 'Read-only generic transport rejected request; no response values logged' }));
        process.exitCode = 1;
      }
    }
  } finally { await db.close(); }
}
main().catch(() => { console.error('Read-only verification failed; sensitive details suppressed'); process.exitCode = 1; });
