/* Add-only drafts. Dry run by default; --apply never publishes or binds services. */
const { isDeepStrictEqual } = require('node:util');

async function stageDrafts(versions, drafts, apply) {
  // Check every identity before creating anything. Preserve all existing user work.
  const existing = await Promise.all(drafts.map(draft => versions.findOne({ code: draft.code, version: draft.version }).lean().exec()));
  for (let index = 0; index < drafts.length; index++) {
    const row = existing[index];
    if (row && (row.status !== 'draft' || !isDeepStrictEqual(row.definition, drafts[index].definition))) {
      throw new Error('Existing template differs; no overwrite allowed');
    }
  }
  const results = [];
  for (let index = 0; index < drafts.length; index++) {
    const draft = drafts[index];
    let outcome = existing[index] ? 'exists-unchanged' : 'would-create';
    if (!existing[index] && apply) {
      try {
        await versions.create({ ...draft, status: 'draft', revision: 0 });
        outcome = 'created';
      } catch (error) {
        if (error.code !== 11000) throw error;
        const winner = await versions.findOne({ code: draft.code, version: draft.version }).lean().exec();
        if (!winner || winner.status !== 'draft' || !isDeepStrictEqual(winner.definition, draft.definition)) throw new Error('Concurrent template conflict');
        outcome = 'exists-unchanged';
      }
    }
    results.push({ code: draft.code, version: draft.version, status: 'draft', outcome });
  }
  return results;
}

async function main() {
  if (process.argv.slice(2).some(arg => arg !== '--apply')) throw new Error('Unsupported arguments');
  require('dotenv').config({ quiet: true });
  require('ts-node/register/transpile-only');
  const { createConnection } = require('mongoose');
  const { ConnectorVersionSchema } = require('../src/provider-connectors/connector-version.schema');
  const { homeproxyPurchaseCandidate } = require('../src/provider-connectors/homeproxy-template');
  const apply = process.argv.includes('--apply');
  const db = await createConnection(process.env.MONGO_URI, { serverSelectionTimeoutMS: 5000 }).asPromise();
  try {
    if (db.name !== 'fastproxy') throw new Error('Unexpected database');
    const versions = db.model('ConnectorVersion', ConnectorVersionSchema);
    if (apply) await versions.init();
    const drafts = ['VIETTEL', 'VNPT', 'FPT'].flatMap(provider => ['http', 'socks5'].map(protocol => ({
      code: `homeproxy_static_${provider.toLowerCase()}_${protocol}`, version: 1,
      name: `HomeProxy · ${provider} tĩnh ${protocol.toUpperCase()} · chờ kiểm tra`,
      definition: homeproxyPurchaseCandidate(provider, protocol),
    })));
    const results = await stageDrafts(versions, drafts, apply);
    console.log(JSON.stringify({ apply, results, accountsChanged: false, servicesChanged: false,
      ordersChanged: false, published: false, purchaseAttempted: false }, null, 2));
  } finally { await db.close(); }
}

module.exports = { stageDrafts };
if (require.main === module) main().catch(() => {
  console.error('Draft staging stopped; no existing templates overwritten. Re-run dry mode to inspect any drafts already added.');
  process.exitCode = 1;
});
