/* Persist only an unbound draft. Never publish, purchase, enable accounts or change services. */
require('dotenv').config({ quiet: true });
require('ts-node/register/transpile-only');
const { createConnection } = require('mongoose');
const { isDeepStrictEqual } = require('node:util');
const { ConnectorVersionSchema } = require('../src/provider-connectors/connector-version.schema');
const { ProviderConnectorsService } = require('../src/provider-connectors/provider-connectors.service');
const { homeproxyPurchaseCandidate } = require('../src/provider-connectors/homeproxy-template');

async function main() {
  const db = await createConnection(process.env.MONGO_URI, { serverSelectionTimeoutMS: 5000 }).asPromise();
  try {
    if (db.name !== 'fastproxy') throw Error();
    const versions = db.model('ConnectorVersion', ConnectorVersionSchema);
    await versions.init();
    const definition = homeproxyPurchaseCandidate();
    const code = 'homeproxy_static_http_candidate';
    let row = await versions.findOne({ code, version: 1 }).lean().exec();
    if (row && !isDeepStrictEqual(row.definition, definition)) throw Error();
    if (!row) row = await new ProviderConnectorsService(versions, {}).create({ code, version: 1,
      name: 'HomeProxy · VIETTEL tĩnh HTTP · chờ kiểm chứng mua', definition });
    console.log(JSON.stringify({ code, version: row.version, status: row.status, servicesChanged: false,
      accountsChanged: false, purchaseAttempted: false, publishedByScript: false }));
  } finally { await db.close(); }
}
main().catch(() => { console.error('Draft staging rejected; existing records preserved; sensitive details suppressed'); process.exitCode = 1; });
