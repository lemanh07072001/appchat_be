/* Explicit cleanup scope approved by user; preserve referenced records and all commerce data. */
const { createConnection } = require('mongoose');
const removedBrands = ['omoproxy', 'twoproxy', 'proxysieutoc', 'proxyseller', 'proxyv6'];
async function main() {
  if (process.argv.slice(2).some(arg => arg !== '--apply')) throw Error('Invalid arguments');
  const apply = process.argv.includes('--apply');
  const db = await createConnection(process.env.MONGO_URI, { serverSelectionTimeoutMS: 5000 }).asPromise();
  const session = await db.startSession();
  try {
    if (db.name !== 'fastproxy') throw Error('Unexpected database');
    let results;
    await session.withTransaction(async () => {
      results = [];
      for (const partner of await db.collection('partners').find({ code: { $in: removedBrands.flatMap(code => [code, `demo_${code}`]) } }, { session }).toArray()) {
        const ids = [partner._id, String(partner._id)];
        const services = await db.collection('services').countDocuments({ partner: { $in: ids } }, { session });
        const orders = await db.collection('orders').countDocuments({ partner_id: { $in: ids } }, { session });
        const accounts = await db.collection('provider_connector_accounts').countDocuments({ $or: [
          { legacyPartnerId: { $in: ids } }, { sourcePartnerId: { $in: ids } },
        ] }, { session });
        const blocked = services + orders + accounts > 0;
        if (apply && !blocked) {
          const deleted = await db.collection('partners').deleteOne(partner, { session });
          if (deleted.deletedCount !== 1) throw Error('Partner changed');
        }
        results.push({ collection: 'partners', code: partner.code, services, orders, accounts,
          outcome: blocked ? 'preserved-linked' : apply ? 'deleted' : 'would-delete' });
      }
      for (const row of await db.collection('provider_connector_versions').find({ code: { $in: removedBrands } }, { session }).toArray()) {
        const accounts = await db.collection('provider_connector_accounts').countDocuments({ connectorCode: row.code }, { session });
        const services = await db.collection('services').countDocuments({ 'connector_binding.connectorCode': row.code }, { session });
        const orders = await db.collection('orders').countDocuments({ 'connector_purchase.connectorCode': row.code }, { session });
        const dispatches = await db.collection('provider_dispatches').countDocuments({ connectorCode: row.code }, { session });
        const workflows = await db.collection('provider_workflow_runs').countDocuments({ connectorCode: row.code }, { session });
        const blocked = row.status !== 'draft' || accounts + services + orders + dispatches + workflows > 0;
        if (apply && !blocked) {
          const deleted = await db.collection('provider_connector_versions').deleteOne(row, { session });
          if (deleted.deletedCount !== 1) throw Error('Template changed');
        }
        results.push({ collection: 'provider_connector_versions', code: row.code, version: row.version,
          accounts, services, orders, dispatches, workflows,
          outcome: blocked ? 'preserved-linked-or-published' : apply ? 'deleted' : 'would-delete' });
      }
    });
    console.log(JSON.stringify({ apply, results, commerceDataChanged: false, retainedBrands: ['gpnip', 'homeproxy', 'proxyvn'] }, null, 2));
  } finally { await session.endSession(); await db.close(); }
}
main().catch(() => { console.error('Cleanup failed; transaction aborted; sensitive details suppressed'); process.exitCode = 1; });
