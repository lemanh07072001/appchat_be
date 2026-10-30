/* One reviewed product only. Archive old identities; never delete orders/proxies or buy upstream. */
const { isDeepStrictEqual } = require('node:util');
const ids = ['6aded892992d541fa11e57c8', '6aded892992d541fa11e57d1', '6aded892992d541fa11e57e2'];
const fields = ['partner', 'type', 'proxy_type', 'ip_version', 'usage_type', 'pricing_mode', 'pricing',
  'id_service', 'duration_ids', 'body_api', 'protocol', 'isp', 'port_http', 'port_socks', 'min_quantity',
  'max_quantity', 'user_discounts', 'connector_binding', 'allow_renew', 'show_user_pass', 'bandwidth_tiers'];
const normalize = value => JSON.parse(JSON.stringify(value ?? null));
function comparable(row, field) {
  if (field !== 'body_api') return normalize(row[field]);
  const body = JSON.parse(row.body_api || '{}');
  delete body.country;
  return body;
}
function plan(rows, countries) {
  const ordered = ids.map(id => rows.find(row => String(row._id) === id));
  if (ordered.some(row => !row)) throw Error('Expected three reviewed services');
  const primary = ordered[0];
  if (primary.country_source === 'manual' && ordered.slice(1).every(row => String(row.consolidated_into) === ids[0])) return null;
  for (const row of ordered) {
    if (row.country_source !== undefined || row.country_choices?.length || row.consolidated_into || row.connector_binding) throw Error('Country configuration requires manual review');
    if (fields.some(field => !isDeepStrictEqual(comparable(row, field), comparable(primary, field)))) throw Error('Products/prices differ; consolidation blocked');
  }
  const options = ordered.map(row => {
    const country = countries.find(country => String(country._id) === String(row.country));
    if (!country?.code || !/^[A-Z]{2}$/.test(country.code.toUpperCase())) throw Error('Missing country identity');
    const body = JSON.parse(row.body_api || '{}');
    if (body.country !== country.code.toUpperCase()) throw Error('Request country and local identity differ');
    return { code: country.code.toUpperCase(), name: country.name };
  });
  if (new Set(options.map(option => option.code)).size !== 3) throw Error('Country identities differ from expected');
  return { primary, archived: ordered.slice(1), options };
}
async function main() {
  const { createConnection, Types } = require('mongoose');
  if (process.argv.slice(2).some(arg => arg !== '--apply')) throw Error('Unexpected arguments');
  const apply = process.argv.includes('--apply');
  const db = await createConnection(process.env.MONGO_URI, { serverSelectionTimeoutMS: 5000 }).asPromise();
  const session = await db.startSession();
  try {
    if (db.name !== 'fastproxy') throw Error('Unexpected database');
    let result;
    await session.withTransaction(async () => {
      const services = db.collection('services');
      const rows = await services.find({ _id: { $in: ids.map(id => new Types.ObjectId(id)) } }, { session }).toArray();
      const countries = await db.collection('countries').find({}, { session }).toArray();
      const changes = plan(rows, countries);
      if (!changes) { result = { outcome: 'already-consolidated' }; return; }
      const references = [];
      for (const row of rows) references.push({ id: String(row._id),
        orders: await db.collection('orders').countDocuments({ service_id: { $in: [row._id, String(row._id)] } }, { session }) });
      result = { outcome: apply ? 'consolidated' : 'would-consolidate', name: 'GPNIP IPv4 riêng',
        countries: changes.options, archived: changes.archived.map(row => String(row._id)), references };
      if (!apply) return;
      // Recovery copies stay in the same database, never in logs or git.
      for (const row of rows) await db.collection('service_consolidation_backups').updateOne({ _id: row._id },
        { $setOnInsert: { original: row, migration: 'gpnip-ipv4-private-countries-v1', createdAt: new Date() } }, { upsert: true, session });
      const saved = await services.updateOne(changes.primary, { $set: {
        name: 'GPNIP IPv4 riêng', country: null, country_source: 'manual', country_options: changes.options,
        body_api: JSON.stringify(comparable(changes.primary, 'body_api')),
        country_sales_mode: 'all', country_allowlist: [], updatedAt: new Date(),
      } }, { session });
      if (saved.modifiedCount !== 1) throw Error('Primary changed');
      for (const row of changes.archived) {
        const saved = await services.updateOne(row, { $set: { consolidated_into: changes.primary._id,
          status: false, api_enabled: false, is_show: false, updatedAt: new Date() } }, { session });
        if (saved.modifiedCount !== 1) throw Error('Historical service changed');
      }
    });
    console.log(JSON.stringify({ apply, ...result, ordersChanged: false, upstreamWrite: false }, null, 2));
  } finally { await session.endSession(); await db.close(); }
}
module.exports = { plan };
if (require.main === module) main().catch(error => { console.error('Consolidation stopped:', error.message); process.exitCode = 1; });
