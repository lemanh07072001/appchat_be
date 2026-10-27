// Local-only catalog demo. Only GET requests to GPNIP; never places orders.
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const definitions = [
  { product: 'proxy6-v4', title: 'IPv4 riêng', version: 'v4', usage: 'private', prices: { 7: 20000, 14: 39000, 30: 85000 } },
  { product: 'proxy6-v3', title: 'IPv4 shared', version: 'v4', usage: 'shared', prices: { 7: 6000, 14: 11000, 30: 24000 } },
  { product: 'proxy6-v6', title: 'IPv6 riêng', version: 'v6', usage: 'private', prices: { 3: 3000, 7: 5000, 14: 8000, 30: 15000 } },
];
const preferred = ['US', 'CA', 'DE', 'NL', 'GB', 'JP', 'SG', 'AU', 'FR', 'RU'];

async function main() {
  const uri = process.env.MONGO_URI || '';
  // Deliberately refuse remote databases, including production.
  const host = /^mongodb:\/\/([^/?]+)/.exec(uri)?.[1];
  if (!host || !/^(localhost|127\.0\.0\.1|host\.docker\.internal)(:\d+)?$/.test(host))
    throw new Error('Requires a local MongoDB URI without embedded credentials.');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  const db = mongoose.connection;
  const partner = await db.collection('partners').findOne({ code: 'gpnip' });
  if (!partner?.token_api) throw new Error('GPNIP partner key is not configured.');
  const response = await fetch('https://api.gpnip.com/api/v1/reseller/packages?page=1&per_page=100', {
    headers: { Authorization: `Bearer ${partner.token_api}` },
    redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json();
  if (!response.ok || payload.success !== true || !Array.isArray(payload.data))
    throw new Error('Could not read the GPNIP catalog.');
  const plans = [];
  for (const definition of definitions) {
    const pkg = payload.data.find(item => item.product === definition.product);
    const countries = pkg?.purchaseFields?.find(field => field.key === 'country')?.options;
    if (!pkg?.id || !Array.isArray(countries) || countries.length < 10)
      throw new Error(`Not enough catalog countries for ${definition.product}.`);
    const selected = [...countries].sort((a, b) => {
      const rank = code => preferred.includes(code) ? preferred.indexOf(code) : 100;
      return rank(a.value) - rank(b.value) || a.value.localeCompare(b.value);
    }).slice(0, 10);
    const pricing = {};
    for (const [days, price] of Object.entries(definition.prices)) {
      const row = pkg.servicePricing?.rows?.find(item => String(item.when?.period) === days);
      if (!Number.isFinite(row?.price) || row.price <= 0)
        throw new Error(`Missing cost for ${definition.product}/${days}.`);
      const cost = Math.round(row.price * 25000);
      if (cost >= price) throw new Error('Catalog cost is no longer below the approved sale price.');
      pricing[days] = { price, cost };
    }
    for (const country of selected) plans.push({ definition, pkg, country, pricing });
  }
  const apply = process.argv.includes('--apply');
  for (const { definition, pkg, country, pricing } of plans) {
    const name = `[DEMO] GPNIP ${definition.title} - ${country.label}`;
    console.log(`${apply ? 'SEED' : 'PLAN'} ${definition.product} ${country.value}: ${JSON.stringify(pricing)}`);
    if (!apply) continue;
    const now = new Date();
    await db.collection('countries').updateOne({ code: country.value }, {
      $setOnInsert: { name: country.label, image_url: '', createdAt: now, updatedAt: now },
    }, { upsert: true });
    const countryDoc = await db.collection('countries').findOne({ code: country.value });
    // Insert only: repeat runs never overwrite existing admin edits or services.
    await db.collection('services').updateOne({ partner: partner._id, name }, {
      $setOnInsert: {
        name, partner: partner._id, country: countryDoc._id, type: 'static',
        proxy_type: `static_${definition.version === 'v6' ? 'ipv6' : 'ipv4'}`,
        ip_version: definition.version, usage_type: definition.usage,
        id_service: pkg.id, body_api: JSON.stringify({ country: country.value, period: '30', ips: 1 }),
        protocol: ['http', 'socks5'], pricing_mode: 'duration', pricing,
        status: false, is_show: false, api_enabled: false, allow_renew: false,
        show_user_pass: true, port_http: 0, port_socks: 0,
        min_quantity: 1, max_quantity: 100, badge: 'DEMO',
        note: { vi: 'Demo, chưa bật bán. Chưa kiểm chứng cấp proxy/gia hạn thực tế.' },
        isp: [], bandwidth_tiers: [], user_discounts: {}, duration_ids: {},
        order: 0, createdAt: now, updatedAt: now,
      },
    }, { upsert: true });
  }
  console.log(`${apply ? 'Seed complete' : 'Dry run complete'}: ${plans.length} demo configurations; no provider purchases.`);
}

main().catch(() => {
  console.error('Demo seed failed; credentials and raw error details suppressed. Check local DB and catalog configuration.');
  process.exitCode = 1;
}).finally(() => mongoose.disconnect());
