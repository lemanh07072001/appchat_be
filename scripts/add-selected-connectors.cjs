// Local development only. Never update existing definitions or copy credentials.
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const { legacyConnectorTemplates } = require('../dist/src/provider-connectors/legacy-connector-templates');

async function main() {
  const uri = process.env.MONGO_URI;
  if (process.env.NODE_ENV !== 'development' || !uri) throw new Error('Development configuration required');
  const host = new URL(uri).hostname;
  if (!['localhost', '127.0.0.1', 'host.docker.internal'].includes(host)) throw new Error('Local MongoDB required');
  try {
    await mongoose.connect(uri);
    const collection = mongoose.connection.collection('provider_connector_versions');
    for (const template of legacyConnectorTemplates().filter(t => ['homeproxy', 'proxyvn', 'gpnip'].includes(t.code))) {
      const existing = await collection.findOne({ code: template.code });
      if (existing) { console.log(`${template.name}: v${existing.version}, ${existing.status}, unchanged`); continue; }
      const now = new Date();
      await collection.insertOne({ code: template.code, name: template.name, version: 1,
        status: 'draft', revision: 0, definition: template.definition, createdAt: now, updatedAt: now });
      console.log(`${template.name}: draft v1 added (not enabled for sales)`);
    }
  } finally { await mongoose.disconnect(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
