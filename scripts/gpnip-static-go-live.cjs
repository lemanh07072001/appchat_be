// Promote the seeded [DEMO] GPNIP static services to live, and refresh the
// partner API key. LOCAL DB ONLY. Dry-run by default; pass --apply to write.
//
// Verified 2026-10-27 before writing this:
//   - Key works end to end incl. a real 30-day IPv6 buy (order provisioned).
//   - check-price is period-INSENSITIVE (always the 30-day price) → only the
//     30-day tier is safe to sell automatically; other tiers are dropped.
//   - Static renewal has no accepted `duration` format → allow_renew stays off.
//
// New API key is read from env GPNIP_NEW_KEY (never hard-coded here).
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');

const PACKAGES = ['6ad6f4c2748369db9ee14aad', '6ad6f4c2748369db9ee14aae', '6ad6f4c2748369db9ee14aaf'];
const LIVE_NOTE = {
  vi: 'Proxy tĩnh, thời hạn 30 ngày. Hết hạn vui lòng đặt đơn mới (hiện chưa hỗ trợ gia hạn tự động).',
};

async function main() {
  const uri = process.env.MONGO_URI || '';
  const host = /^mongodb:\/\/([^/?]+)/.exec(uri)?.[1];
  if (!host || !/^(localhost|127\.0\.0\.1|host\.docker\.internal)(:\d+)?$/.test(host))
    throw new Error('Requires a local MongoDB URI without embedded credentials.');

  const apply = process.argv.includes('--apply');
  const newKey = (process.env.GPNIP_NEW_KEY || '').trim();

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  const db = mongoose.connection;

  const partner = await db.collection('partners').findOne({ code: 'gpnip' });
  if (!partner) throw new Error('No gpnip partner found.');

  // 1) Partner key
  console.log('== PARTNER ==');
  const oldSuffix = (partner.token_api || '(empty)').slice(-6);
  if (newKey) {
    if (newKey === partner.token_api) {
      console.log(`  key unchanged (…${oldSuffix})`);
    } else {
      console.log(`  ${apply ? 'UPDATE' : 'WOULD UPDATE'} token_api  …${oldSuffix} -> …${newKey.slice(-6)} (len ${newKey.length})`);
      if (apply) await db.collection('partners').updateOne({ _id: partner._id }, { $set: { token_api: newKey, status: true, updatedAt: new Date() } });
    }
  } else {
    console.log('  GPNIP_NEW_KEY not set → leaving partner key as-is');
  }

  // 2) Services
  console.log('\n== SERVICES ==');
  const services = await db.collection('services').find({
    partner: partner._id,
    $or: [{ id_service: { $in: PACKAGES } }, { name: { $regex: '^\\[DEMO\\] GPNIP' } }],
  }).toArray();
  console.log(`  matched ${services.length} services`);

  let changed = 0;
  for (const s of services) {
    const newName = (s.name || '').replace(/^\[DEMO\]\s*/, '');
    const set = { updatedAt: new Date() };
    if (newName !== s.name) set.name = newName;
    if (s.badge === 'DEMO') set.badge = '';
    if (s.allow_renew !== false) set.allow_renew = false; // renewal unsupported for static

    // Keep only the 30-day tier (the only one check-price prices correctly).
    const price30 = s.pricing && s.pricing['30'];
    if (price30) {
      const keys = Object.keys(s.pricing);
      if (keys.length !== 1 || keys[0] !== '30') set.pricing = { '30': price30 };
    } else {
      console.log(`  !! ${s.name}: no 30-day price — SKIPPING pricing change, review manually`);
    }

    set.note = LIVE_NOTE;

    const willChange = Object.keys(set).some((k) => k !== 'updatedAt');
    if (!willChange) continue;
    changed++;
    const summary = {
      name: set.name ?? s.name,
      badge: set.badge !== undefined ? set.badge : s.badge,
      pricing: set.pricing ?? s.pricing,
      allow_renew: set.allow_renew !== undefined ? set.allow_renew : s.allow_renew,
    };
    console.log(`  ${apply ? 'UPDATE' : 'PLAN  '} ${s._id}  "${summary.name}"  pricing=${JSON.stringify(summary.pricing)}  badge="${summary.badge}"  allow_renew=${summary.allow_renew}`);
    if (apply) await db.collection('services').updateOne({ _id: s._id }, { $set: set });
  }

  console.log(`\n${apply ? 'APPLIED' : 'DRY RUN'}: ${changed}/${services.length} services would change. status/is_show/api_enabled left as-is (currently live).`);
}

main()
  .catch((e) => { console.error('go-live failed:', e.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
