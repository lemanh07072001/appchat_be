const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inspectDocument } = require('./inspect-homeproxy-openapi.cjs');

function fixture() {
  return { paths: { '/api/v1/orders/merchant': { post: {
    requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateOrdersDto' } } } },
    responses: { 201: {} }, security: [{ bearer: [] }],
  } } }, components: { schemas: { CreateOrdersDto: { required: ['products'], properties: { products: { type: 'array' } } }, CreateOrderProductsDto: {
    required: ['user', 'password'], properties: { dayOfUse: { type: 'number', default: 2 },
      quantity: { type: 'number' }, user: { type: 'string' }, password: { type: 'string' },
      protocolType: { type: 'string', default: 'http' } },
  } } } };
}

test('reports unknown limits explicitly and never treats defaults as supported bounds', () => {
  const result = inspectDocument(fixture());
  assert.equal(result.readyForLivePurchase, false);
  assert.equal(result.writeAttempted, false);
  assert.equal(result.constraints.duration.minimum, null);
  assert.equal(result.constraints.duration.default, 2);
  assert.equal(result.blockers.length, 5);
  assert.equal(result.purchasePaths[0].path, '/api/v1/orders/merchant');
});
test('documenting the candidate route does not certify live purchases', () => {
  const document = fixture();
  document.paths['/api/merchant/orders'] = document.paths['/api/v1/orders/merchant'];
  const result = inspectDocument(document);
  assert.ok(!result.blockers.includes('candidate-purchase-path-not-documented'));
  assert.equal(result.readyForLivePurchase, false);
});
test('rejects missing schemas rather than reporting an empty successful audit', () => {
  assert.throws(() => inspectDocument({}));
  assert.throws(() => inspectDocument({ paths: {}, components: { schemas: {} } }));
});
