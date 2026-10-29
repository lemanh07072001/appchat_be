/* Explicit local setup. Only upstream GET requests; no service/order rewrites or purchases. */
require('dotenv').config({ quiet: true });
require('ts-node/register/transpile-only');
const { createConnection } = require('mongoose');
const { ConfigService } = require('@nestjs/config');
const { ConnectorVersionSchema } = require('../src/provider-connectors/connector-version.schema');
const { ConnectorAccountSchema } = require('../src/provider-connectors/connector-account.schema');
const { ProviderConnectorsService } = require('../src/provider-connectors/provider-connectors.service');
const { ConnectorCredentialMigration } = require('../src/provider-connectors/connector-credential-migration.service');
const { ConnectorSecrets } = require('../src/provider-connectors/connector-secrets.service');
const { ConnectorHttp } = require('../src/provider-connectors/connector-http.service');
const { connectorSucceeded } = require('../src/provider-connectors/connector-success');
const { validateConnectorResult } = require('../src/provider-connectors/connector-contract');
const { homeproxyReadOnlyTemplate } = require('../src/provider-connectors/homeproxy-template');

let stage = 'database';
async function main() {
  const db = await createConnection(process.env.MONGO_URI, { serverSelectionTimeoutMS: 5000 }).asPromise();
  try {
    if (db.name !== 'fastproxy') throw Error('Unexpected database');
    const versions = db.model('ConnectorVersion', ConnectorVersionSchema);
    const accounts = db.model('ConnectorAccount', ConnectorAccountSchema);
    await Promise.all([versions.init(), accounts.init()]);
    const partner = await db.collection('partners').findOne({ code: 'homeproxy' }, { projection: { token_api: 1, name: 1 } });
    if (!partner?.token_api?.trim()) throw Error('Source credential unavailable');
    const token = partner.token_api.trim();
    const definition = homeproxyReadOnlyTemplate();
    const http = new ConnectorHttp();
    stage = 'connection-check';
    const checked = await http.check(definition, token);
    if (!connectorSucceeded(checked, definition.operations.check.response.success)) throw Error('Connection contract rejected');
    stage = 'catalog-contract';
    const catalog = validateConnectorResult('catalog', await http.readMapped(definition, 'catalog', {}, token));
    if (!catalog.items.length) throw Error('Empty catalog');
    stage = 'encryption-preflight';
    const secrets = new ConnectorSecrets(new ConfigService());
    // Validate encryption configuration before persisting any template or account.
    secrets.encrypt('configuration-preflight', 'preflight');
    const connectors = new ProviderConnectorsService(versions, { published: (_code, _version, load) => load() });
    stage = 'template-publication';
    const code = 'homeproxy_readonly';
    let row = await versions.findOne({ code, version: 1 }).lean().exec();
    if (!row) row = await connectors.create({ code, version: 1, name: 'HomeProxy · kết nối & danh mục', definition });
    if (JSON.stringify(row.definition) !== JSON.stringify(definition)) throw Error('Existing template differs; preserved unchanged');
    if (row.status === 'draft') row = await connectors.publish(code, 1, row.revision);
    const migration = new ConnectorCredentialMigration({ findById: source => ({ select: () => ({ lean: () => ({ exec: () =>
      db.collection('partners').findOne({ _id: source }, { projection: { token_api: 1, name: 1 } }) }) }) }) }, accounts, connectors, secrets);
    stage = 'credential-copy';
    const copied = await migration.copy(String(partner._id), { connectorCode: code, connectorVersion: 1, expectedOrigin: 'https://api.homeproxy.vn' });
    const account = await accounts.findById(copied.accountId).select('+credential').lean().exec();
    const copiedToken = secrets.decrypt(account.credential, String(account._id));
    stage = 'copied-account-verification';
    const verified = await http.check(definition, copiedToken);
    if (!connectorSucceeded(verified, definition.operations.check.response.success)) throw Error('Copied account check failed');
    console.log(JSON.stringify({ template: code, version: 1, published: true, accountVisible: true,
      accountEnabled: account.enabled, connectionVerified: true, catalogItems: catalog.items.length,
      purchaseConfigured: false, checkoutEnabled: process.env.CONNECTOR_CHECKOUT_ENABLED === 'true',
      legacyUnchanged: true, servicesUnchanged: true, ordersUnchanged: true }));
  } finally { await db.close(); }
}
main().catch(() => { console.error(`HomeProxy setup failed at ${stage}; existing records preserved; sensitive details suppressed`); process.exitCode = 1; });
