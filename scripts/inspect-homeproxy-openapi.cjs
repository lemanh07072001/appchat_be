/* Public documentation only. No credentials, database access or upstream writes. */
const { createHash } = require('node:crypto');

function inspectDocument(document) {
  if (!document || typeof document !== 'object' || !document.paths || !document.components?.schemas) {
    throw new Error('Unsupported OpenAPI document');
  }
  const schemas = document.components.schemas;
  const line = schemas.CreateOrderProductsDto;
  const order = schemas.CreateOrdersDto;
  if (!line?.properties || !order?.properties) throw new Error('Purchase schemas unavailable');
  const properties = line?.properties ?? {};
  const bounds = (name, keys) => Object.fromEntries(keys.map(key => [key, properties[name]?.[key] ?? null]));
  const purchasePaths = Object.entries(document.paths).filter(([, value]) =>
    value?.post?.requestBody?.content?.['application/json']?.schema?.$ref === '#/components/schemas/CreateOrdersDto')
    .map(([path, value]) => ({ path, security: value.post.security ?? document.security ?? [],
      responseCodes: Object.keys(value.post.responses ?? {}) }));
  const candidatePath = '/api/merchant/orders';
  const blockers = [];
  if (!purchasePaths.some(row => row.path === candidatePath)) blockers.push('candidate-purchase-path-not-documented');
  if (properties.dayOfUse?.minimum === undefined || properties.dayOfUse?.maximum === undefined) blockers.push('duration-bounds-not-documented');
  if (properties.quantity?.minimum === undefined || properties.quantity?.maximum === undefined) blockers.push('quantity-bounds-not-documented');
  if (['user', 'password'].some(field => properties[field]?.minLength === undefined || properties[field]?.maxLength === undefined)) {
    blockers.push('credential-length-bounds-not-documented');
  }
  if (!properties.protocolType?.enum) blockers.push('protocol-values-not-documented');
  return { source: 'https://api.homeproxy.vn/docs-json', readOnly: true, writeAttempted: false,
    readyForLivePurchase: false, candidatePath, purchasePaths,
    requiredOrderFields: order?.required ?? [], requiredProductFields: line?.required ?? [],
    constraints: { duration: bounds('dayOfUse', ['type', 'default', 'minimum', 'maximum']),
      quantity: bounds('quantity', ['type', 'default', 'minimum', 'maximum']),
      username: bounds('user', ['type', 'minLength', 'maxLength', 'pattern']),
      password: bounds('password', ['type', 'minLength', 'maxLength', 'pattern']),
      protocol: bounds('protocolType', ['type', 'default', 'enum']) },
    blockers, caveat: 'Documentation is not proof of live purchase compatibility, lease length, or safe retries.' };
}

async function main() {
  const response = await fetch('https://api.homeproxy.vn/docs-json', {
    signal: AbortSignal.timeout(20000), redirect: 'error', headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error('Public documentation unavailable');
  const raw = await response.text();
  if (Buffer.byteLength(raw) > 10_000_000) throw new Error('Documentation exceeds size limit');
  console.log(JSON.stringify({ fetchedAt: new Date().toISOString(),
    documentSha256: createHash('sha256').update(raw).digest('hex'), ...inspectDocument(JSON.parse(raw)) }, null, 2));
}

module.exports = { inspectDocument };
if (require.main === module) main().catch(() => {
  console.error('Public OpenAPI inspection failed; no purchase attempted'); process.exitCode = 1;
});
