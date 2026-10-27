// Restore full duration tiers on GPNIP static services after the 2026-10-27
// dashboard fix (serviceOptions.period → all periods now price correctly).
// LOCAL DB ONLY. Dry-run by default; --apply to write.
//
// Sell prices = the owner-approved seeded values. Cost = catalog coin × 25000,
// read LIVE from GPNIP so a catalog change is caught (refuses if cost >= sell).
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');

// product -> { days: sellPriceVND }
const SELL = {
  'proxy6-v4': { 7: 20000, 14: 39000, 30: 85000 },
  'proxy6-v3': { 7: 6000, 14: 11000, 30: 24000 },
  'proxy6-v6': { 3: 3000, 7: 5000, 14: 8000, 30: 15000 },
};
const PKG_BY_PRODUCT = {
  'proxy6-v4': '6ad6f4c2748369db9ee14aad',
  'proxy6-v3': '6ad6f4c2748369db9ee14aae',
  'proxy6-v6': '6ad6f4c2748369db9ee14aaf',
};
const RATE = 25000;

async function main() {
  const uri = process.env.MONGO_URI || '';
  const host = /^mongodb:\/\/([^/?]+)/.exec(uri)?.[1];
  if (!host || !/^(localhost|127\.0\.0\.1|host\.docker\.internal)(:\d+)?$/.test(host))
    throw new Error('Requires a local MongoDB URI without embedded credentials.');
  const apply = process.argv.includes('--apply');

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  const db = mongoose.connection;
  const partner = await db.collection('partners').findOne({ code: 'gpnip' });
  if (!partner?.token_api) throw new Error('GPNIP partner key missing.');

  // Live catalog for cost.
  const res = await fetch('https://api.gpnip.com/api/v1/reseller/packages?page=1&per_page=100', {
    headers: { Authorization: `Bearer ${partner.token_api}` }, redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  const payload = await res.json();
  if (!res.ok || payload.success !== true || !Array.isArray(payload.data)) throw new Error('Could not read catalog.');

  const pricingByPkg = {};
  for (const [product, sell] of Object.entries(SELL)) {
    const pkg = payload.data.find((p) => p.product === product);
    const rows = pkg?.servicePricing?.rows;
    if (!Array.isArray(rows)) throw new Error(`No servicePricing rows for ${product}.`);
    const pricing = {};
    for (const [days, price] of Object.entries(sell)) {
      const row = rows.find((r) => String(r.when?.period) === String(days));
      if (!Number.isFinite(row?.price) || row.price <= 0) throw new Error(`Missing catalog cost ${product}/${days}.`);
      const cost = Math.round(row.price * RATE);
      if (cost >= price) throw new Error(`Catalog cost ${cost} >= sell ${price} for ${product}/${days}.`);
      pricing[days] = { price, cost };
    }
    pricingByPkg[PKG_BY_PRODUCT[product]] = pricing;
    console.log(`${product}: ${JSON.stringify(pricing)}`);
  }

  let changed = 0;
  for (const [pkgId, pricing] of Object.entries(pricingByPkg)) {
    const svcs = await db.collection('services').find({ partner: partner._id, id_service: pkgId }).toArray();
    for (const s of svcs) {
      const same = JSON.stringify(s.pricing) === JSON.stringify(pricing);
      if (same) continue;
      changed++;
      console.log(`  ${apply ? 'UPDATE' : 'PLAN  '} ${s._id} "${s.name}"  ${JSON.stringify(s.pricing)} -> ${JSON.stringify(pricing)}`);
      if (apply) await db.collection('services').updateOne({ _id: s._id }, { $set: { pricing, updatedAt: new Date() } });
    }
  }
  console.log(`\n${apply ? 'APPLIED' : 'DRY RUN'}: ${changed} services' pricing would change.`);
}
main().catch((e) => { console.error('restore failed:', e.message); process.exitCode = 1; }).finally(() => mongoose.disconnect());
