const { test } = require('node:test');
const assert = require('node:assert/strict');
const { plan } = require('./consolidate-gpnip-countries.cjs');
function fixture() {
  const ids = ['6aded892992d541fa11e57c8', '6aded892992d541fa11e57d1', '6aded892992d541fa11e57e2'];
  const countries = ['US', 'DE', 'SG'].map((code, i) => ({ _id: `country${i}`, code, name: code }));
  const rows = ids.map((_id, i) => ({ _id, country: countries[i]._id, pricing: { 30: { price: 85000 } },
    id_service: 'same-product', body_api: JSON.stringify({ country: countries[i].code, ips: 1 }) }));
  return { rows, countries };
}
test('groups only reviewed services, preserving all country choices', () => {
  const f = fixture(); const result = plan(f.rows, f.countries);
  assert.equal(result.archived.length, 2);
  assert.deepEqual(result.options.map(row => row.code), ['US', 'DE', 'SG']);
});
test('blocks changed prices, products and request parameters', () => {
  for (const update of [{ pricing: {} }, { id_service: 'other' }, { body_api: '{"country":"DE","ips":2}' }]) {
    const f = fixture(); Object.assign(f.rows[1], update);
    assert.throws(() => plan(f.rows, f.countries));
  }
});
test('blocks country identity mismatch', () => {
  const f = fixture(); f.countries[1].code = 'JP';
  assert.throws(() => plan(f.rows, f.countries));
});
