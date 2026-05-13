/**
 * Seed demo data: 50 users + ~200 orders + proxies + transactions + catalog.
 * Wipe sạch (giữ admin) rồi insert lại từ đầu.
 *
 * Run: node scripts/seed-demo.js
 */
const mongoose = require('mongoose');
const bcrypt   = require('bcrypt');
const crypto   = require('crypto');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/proxydb';

const USER_COUNT     = 50;
const ORDER_COUNT    = 200;
const ROLE_ADMIN     = 0;
const ROLE_USER      = 1;
const STATUS_ACTIVE  = 1;

const DAY = 86_400_000;

// ─── Helpers ─────────────────────────────────────────────────────────────
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[rand(0, arr.length - 1)];
const chance = (p) => Math.random() < p;
const randIp = () => `${rand(1, 254)}.${rand(0, 255)}.${rand(0, 255)}.${rand(1, 254)}`;
const randAlphaNum = (n) => crypto.randomBytes(n).toString('hex').toUpperCase().slice(0, n);
const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');

const FIRST_NAMES = ['Nguyen', 'Tran', 'Le', 'Pham', 'Hoang', 'Vo', 'Dang', 'Bui', 'Do', 'Ho', 'Ngo', 'Duong', 'Ly'];
const LAST_NAMES  = ['Anh', 'Bao', 'Cuong', 'Dung', 'Em', 'Giang', 'Hieu', 'Khoa', 'Long', 'Minh', 'Nam', 'Phuc', 'Quan', 'Son', 'Tuan', 'Vinh', 'Yen'];

const COUNTRY_DATA = [
  { name: 'Việt Nam',  code: 'VN' },
  { name: 'United States', code: 'US' },
  { name: 'United Kingdom', code: 'GB' },
  { name: 'Japan', code: 'JP' },
  { name: 'Korea', code: 'KR' },
  { name: 'Singapore', code: 'SG' },
  { name: 'Germany', code: 'DE' },
  { name: 'France', code: 'FR' },
  { name: 'Canada', code: 'CA' },
  { name: 'Brazil', code: 'BR' },
];

const ISP_DATA = [
  { name: 'Viettel', code: 'viettel' },
  { name: 'VNPT', code: 'vnpt' },
  { name: 'FPT', code: 'fpt' },
  { name: 'Mobifone', code: 'mobifone' },
  { name: 'Comcast', code: 'comcast' },
  { name: 'AT&T', code: 'att' },
  { name: 'Verizon', code: 'verizon' },
];

const PARTNER_DATA = [
  { name: 'HomeProxy', code: 'homeproxy' },
  { name: 'ProxyVN', code: 'proxyvn' },
  { name: '2Proxy', code: 'twoproxy' },
  { name: 'ProxyV6', code: 'proxyv6' },
];

const SERVICE_TEMPLATES = [
  { name: 'Proxy IPV4 Private', type: 'static', proxy_type: 'static_ipv4', ip_version: 'v4', usage_type: 'private',
    protocol: ['http', 'socks5'], pricePerDay: 1000 },
  { name: 'Proxy IPV4 Xoay',    type: 'rotating', proxy_type: 'rotating_ipv4', ip_version: 'v4', usage_type: 'rotating',
    protocol: ['http', 'socks5'], pricePerDay: 1500 },
  { name: 'Proxy Ngoại (US)',   type: 'static', proxy_type: 'static_ipv4', ip_version: 'v4', usage_type: 'private',
    protocol: ['socks5'], pricePerDay: 2000, countryCode: 'US' },
  { name: 'Proxy IPV6 Private', type: 'static', proxy_type: 'static_ipv6', ip_version: 'v6', usage_type: 'private',
    protocol: ['http', 'socks5'], pricePerDay: 800 },
  { name: 'Proxy IPV6 Xoay Key',type: 'rotating', proxy_type: 'rotating_ipv6', ip_version: 'v6', usage_type: 'rotating',
    protocol: ['http'], pricePerDay: 1200 },
];

const DURATIONS = [1, 3, 7, 15, 30, 60, 90];

// Phân bố status (tổng 200)
const STATUS_DISTRIBUTION = [
  { status: 0,  count: 5,  label: 'PENDING'          },
  { status: 1,  count: 10, label: 'PAID'             },
  { status: 2,  count: 10, label: 'PROCESSING'       },
  { status: 3,  count: 60, label: 'ACTIVE'           },
  { status: 4,  count: 30, label: 'COMPLETED'        },
  { status: 5,  count: 45, label: 'EXPIRED'          },
  { status: 6,  count: 10, label: 'CANCELLED'        },
  { status: 7,  count: 5,  label: 'PARTIAL_REFUNDED' },
  { status: 8,  count: 10, label: 'FAILED'           },
  { status: 9,  count: 5,  label: 'PENDING_REFUND'   },
  { status: 10, count: 10, label: 'PARTIAL'          },
];

// ─── Main ────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n[1/6] Connect ${MONGO_URI}`);
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection;

  console.log('[2/6] Wipe collections (giữ admin)');
  await db.collection('users').deleteMany({ role: { $ne: ROLE_ADMIN } });
  for (const c of ['orders', 'proxies', 'transactions', 'wallettransactions',
                   'countries', 'services', 'ips', 'partners',
                   'affiliatecommissions', 'proxyassignments']) {
    await db.collection(c).deleteMany({});
  }

  // ─── 3. Catalog ────────────────────────────────────────────────────────
  console.log('[3/6] Seed catalog');
  const now = new Date();

  const partnersInsert = PARTNER_DATA.map((p, i) => ({
    ...p, status: true, token_api: '', order: i, createdAt: now, updatedAt: now,
  }));
  const partnerRes = await db.collection('partners').insertMany(partnersInsert);
  const partners = Object.values(partnerRes.insertedIds);

  const countriesInsert = COUNTRY_DATA.map((c) => ({
    ...c, createdAt: now, updatedAt: now,
  }));
  const countryRes = await db.collection('countries').insertMany(countriesInsert);
  const countries = COUNTRY_DATA.map((c, i) => ({ _id: countryRes.insertedIds[i], ...c }));
  const countryByCode = Object.fromEntries(countries.map((c) => [c.code, c]));

  const ispsInsert = ISP_DATA.map((isp, i) => ({
    ...isp, note: '', status: true, order: i, createdAt: now, updatedAt: now,
  }));
  await db.collection('ips').insertMany(ispsInsert);

  const servicesInsert = SERVICE_TEMPLATES.map((tpl, i) => {
    const country = tpl.countryCode ? countryByCode[tpl.countryCode] : null;
    return {
      name: tpl.name,
      type: tpl.type,
      status: true,
      proxy_type: tpl.proxy_type,
      ip_version: tpl.ip_version,
      partner: pick(partners),
      country: country?._id ?? null,
      body_api: '',
      id_service: '',
      protocol: tpl.protocol,
      note: {},
      isp: ISP_DATA.slice(0, 4).map((x) => ({ name: x.name, code: x.code })),
      usage_type: tpl.usage_type,
      is_show: true,
      api_enabled: false,
      show_user_pass: true,
      pricing: { 1: tpl.pricePerDay, 7: tpl.pricePerDay * 7, 30: tpl.pricePerDay * 28 },
      badge: i === 0 ? 'HOT' : '',
      duration_ids: {},
      order: i,
      _pricePerDay: tpl.pricePerDay, // tạm để dùng khi gen order, sẽ unset
      createdAt: now,
      updatedAt: now,
    };
  });
  const pricePerDayMap = servicesInsert.map((s) => s._pricePerDay);
  servicesInsert.forEach((s) => delete s._pricePerDay);
  const serviceRes = await db.collection('services').insertMany(servicesInsert);
  const services = SERVICE_TEMPLATES.map((tpl, i) => ({
    _id: serviceRes.insertedIds[i],
    ...tpl,
    pricePerDay: pricePerDayMap[i],
    country: tpl.countryCode ? countryByCode[tpl.countryCode] : null,
  }));

  console.log(`  - ${partners.length} partners, ${countries.length} countries, ${ispsInsert.length} ISPs, ${services.length} services`);

  // ─── 4. Users ──────────────────────────────────────────────────────────
  console.log(`[4/6] Seed ${USER_COUNT} users`);
  const passwordHash = await bcrypt.hash('password', 10);
  const usersInsert = [];
  const usedEmails = new Set();
  for (let i = 0; i < USER_COUNT; i++) {
    const first = pick(FIRST_NAMES);
    const last  = pick(LAST_NAMES);
    const name  = `${first} ${last}`;
    let email;
    do {
      email = `${slug(first)}.${slug(last)}${rand(1, 9999)}@demo.com`;
    } while (usedEmails.has(email));
    usedEmails.add(email);

    usersInsert.push({
      name,
      email,
      password: passwordHash,
      avatar: '',
      role: ROLE_USER,
      status: STATUS_ACTIVE,
      email_verified_at: now,
      last_login_at: new Date(now.getTime() - rand(0, 30) * DAY),
      money: rand(0, 5_000_000),
      country: 'VN',
      topup_code: 'NAP' + randAlphaNum(8),
      referral_code: 'REF' + randAlphaNum(8) + String(i).padStart(3, '0'),
      referred_by: null,
      affiliate_balance: rand(0, 500_000),
      commission_rate: null,
      api_token: chance(0.3) ? 'apt_' + crypto.randomBytes(20).toString('hex') : null,
      bank_name: '',
      bank_account: '',
      bank_owner: '',
      createdAt: new Date(now.getTime() - rand(1, 180) * DAY),
      updatedAt: now,
    });
  }
  const userRes = await db.collection('users').insertMany(usersInsert);
  const userIds = Object.values(userRes.insertedIds);

  // Gắn referred_by ngẫu nhiên cho 30% user
  const refUpdates = [];
  for (let i = 0; i < userIds.length; i++) {
    if (chance(0.3)) {
      let referrerIdx = rand(0, userIds.length - 1);
      if (referrerIdx === i) referrerIdx = (referrerIdx + 1) % userIds.length;
      refUpdates.push({
        updateOne: { filter: { _id: userIds[i] }, update: { $set: { referred_by: userIds[referrerIdx] } } },
      });
    }
  }
  if (refUpdates.length) await db.collection('users').bulkWrite(refUpdates);

  // ─── 5. Orders + Proxies ───────────────────────────────────────────────
  console.log(`[5/6] Seed ${ORDER_COUNT} orders + proxies`);
  const orderDocs = [];
  const proxyDocs = [];

  let orderIdx = 0;
  for (const dist of STATUS_DISTRIBUTION) {
    for (let i = 0; i < dist.count; i++) {
      const svc = pick(services);
      const userId = pick(userIds);
      const quantity = svc.type === 'rotating' ? 1 : rand(1, 10);
      const durationDays = pick(DURATIONS);
      const pricePerUnit = svc.pricePerDay * durationDays;
      const totalPrice   = pricePerUnit * quantity;

      // Date logic theo status
      const ageDays = rand(1, 120);   // tuổi đơn
      const createdAt = new Date(now.getTime() - ageDays * DAY);
      let startDate = null, endDate = null;

      const s = dist.status;
      if (s === 3) {
        // ACTIVE: đang chạy
        const remain = rand(1, durationDays);
        startDate = new Date(now.getTime() - (durationDays - remain) * DAY);
        endDate   = new Date(now.getTime() + remain * DAY);
      } else if (s === 5 || s === 4 || s === 7 || s === 11) {
        // EXPIRED / COMPLETED / refunded: hết hạn trong quá khứ
        startDate = new Date(now.getTime() - (ageDays) * DAY);
        endDate   = new Date(startDate.getTime() + durationDays * DAY);
      } else if (s === 2 || s === 1) {
        // PROCESSING / PAID: vừa tạo, chưa start hoặc start gần đây
        startDate = new Date(now.getTime() - rand(0, 1) * DAY);
        endDate   = new Date(startDate.getTime() + durationDays * DAY);
      } else if (s === 10) {
        // PARTIAL: đã chạy nhưng thiếu proxy
        startDate = new Date(now.getTime() - rand(0, 3) * DAY);
        endDate   = new Date(startDate.getTime() + durationDays * DAY);
      } else if (s === 6 || s === 8 || s === 9) {
        // CANCELLED / FAILED / PENDING_REFUND
        startDate = chance(0.5) ? new Date(now.getTime() - rand(1, 10) * DAY) : null;
        endDate   = null;
      }
      // PENDING (0) → giữ null

      const orderCode = `ORD-${createdAt.getFullYear()}${String(createdAt.getMonth() + 1).padStart(2, '0')}${String(createdAt.getDate()).padStart(2, '0')}-${randAlphaNum(8)}`;
      const orderId = new mongoose.Types.ObjectId();
      const protocol = pick(svc.protocol);
      const isp = pick(ISP_DATA);
      const actualQty = s === 10 ? Math.max(1, quantity - rand(1, Math.max(1, quantity - 1))) : null;

      orderDocs.push({
        _id: orderId,
        order_code: orderCode,
        user_id: userId,
        service_id: svc._id,
        partner_id: pick(partners),
        country_id: svc.country?._id ?? pick(countries)._id,
        proxy_type: svc.proxy_type,
        order_type: svc.type,
        quantity,
        duration_days: durationDays,
        bandwidth_gb: svc.type === 'rotating' ? rand(5, 50) : null,
        bandwidth_used_gb: svc.type === 'rotating' ? rand(0, 5) : 0,
        price_per_unit: pricePerUnit,
        cost_per_unit: Math.floor(pricePerUnit * 0.7),
        discount_amount: 0,
        total_price: totalPrice,
        total_cost: Math.floor(totalPrice * 0.7),
        profit: Math.floor(totalPrice * 0.3),
        currency: 'VND',
        status: s,
        payment_status: s === 0 ? 0 : (s === 11 ? 2 : 1),
        payment_method: s === 0 ? null : 'balance',
        payment_id: null,
        start_date: startDate,
        end_date: endDate,
        credentials: null,
        config: { isp: isp.name, protocol, location: svc.country?.code ?? 'VN' },
        provider_order_id: s >= 2 ? `PRV-${randAlphaNum(10)}` : '',
        auto_renew: chance(0.2),
        renewed_from: null,
        renewed_to: null,
        actual_quantity: actualQty,
        refunded_amount: s === 7 ? Math.floor(totalPrice * 0.3) : (s === 11 ? totalPrice : 0),
        error_message: s === 8 ? 'Provider timeout' : '',
        admin_note: '',
        createdAt,
        updatedAt: new Date(createdAt.getTime() + rand(0, 1000)),
      });

      // Proxies: chỉ tạo cho status có proxy thật
      const hasProxies = [3, 4, 5, 7, 10, 11].includes(s);
      if (hasProxies) {
        const proxyQty = s === 10 ? actualQty : quantity;
        for (let p = 0; p < proxyQty; p++) {
          proxyDocs.push({
            order_id: orderId,
            proxy_type_id: svc._id,
            ip_address: randIp(),
            port: rand(10000, 60000),
            protocol,
            auth_username: randAlphaNum(6),
            auth_password: randAlphaNum(8),
            country_code: svc.country?.code ?? 'VN',
            region: '',
            city: '',
            provider_proxy_id: String(rand(10000, 99999)),
            domain: '',
            prev_ip: '',
            location: svc.country?.name ?? 'Việt Nam',
            isp: isp.name,
            datacenter: '',
            provider: pick(['homeproxy', 'proxyvn', 'twoproxy']),
            is_active: s === 3,
            is_available: s === 3,
            health_status: s === 3 ? 'healthy' : (s === 5 ? 'dead' : 'healthy'),
            last_checked_at: startDate,
            createdAt: startDate ?? createdAt,
            updatedAt: startDate ?? createdAt,
          });
        }
      }
      orderIdx++;
    }
  }

  if (orderDocs.length) await db.collection('orders').insertMany(orderDocs);
  if (proxyDocs.length) await db.collection('proxies').insertMany(proxyDocs);
  console.log(`  - ${orderDocs.length} orders, ${proxyDocs.length} proxies`);

  // ─── 6. Transactions (nạp tiền) ────────────────────────────────────────
  console.log('[6/6] Seed transactions');
  const txDocs = [];
  // ~ 1.5 transaction / user trung bình
  const txCount = Math.floor(USER_COUNT * 1.5);
  for (let i = 0; i < txCount; i++) {
    const userId = pick(userIds);
    const amount = pick([50_000, 100_000, 200_000, 500_000, 1_000_000, 2_000_000]);
    const balanceBefore = rand(0, 3_000_000);
    const txDate = new Date(now.getTime() - rand(0, 90) * DAY);
    txDocs.push({
      transaction_id: Date.now() + i * 1000 + rand(0, 999),
      gateway: pick(['VCB', 'MB', 'TCB', 'ACB']),
      transaction_date: txDate,
      transaction_number: 'FT' + randAlphaNum(10),
      account_number: '0' + rand(100000000, 999999999),
      content: `NAP${randAlphaNum(8)} nap tien fastproxyvn`,
      code: 'NAP' + randAlphaNum(8),
      transfer_type: 'IN',
      transfer_amount: amount,
      checksum: '',
      status: 'processed',
      user_id: userId,
      balance_before: balanceBefore,
      balance_after: balanceBefore + amount,
      source: 'auto',
      note: '',
      raw_payload: null,
      raw_headers: null,
      createdAt: txDate,
      updatedAt: txDate,
    });
  }
  await db.collection('transactions').insertMany(txDocs);
  console.log(`  - ${txDocs.length} transactions`);

  // ─── Summary ───────────────────────────────────────────────────────────
  console.log('\n✓ Done.\n');
  console.log('Status distribution:');
  for (const d of STATUS_DISTRIBUTION) {
    console.log(`  ${String(d.status).padStart(2)} ${d.label.padEnd(20)} ${d.count}`);
  }

  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
