/**
 * Seed 2 order ACTIVE sắp hết hạn + commission PENDING tương ứng
 * Dùng để test luồng: order expire → commission CONFIRMED
 *
 * Run: node scripts/seed-expiring-orders.js
 *
 * Tự động lấy:
 *   referrer = user có referred_by khác null (hoặc user đầu tiên có referral_code)
 *   buyer    = user có referred_by trỏ đến referrer
 * Nếu không có sẵn, script sẽ báo lỗi.
 */
const mongoose = require('mongoose');
const { ObjectId } = mongoose.Types;

const MONGO_URI   = 'mongodb://localhost:27017/proxydb';
const RATE        = 5; // % hoa hồng
const EXPIRE_DAYS = [1, 2]; // order 1 hết hạn sau 1 ngày, order 2 sau 2 ngày

mongoose.connect(MONGO_URI).then(async () => {
  const users = mongoose.connection.collection('users');
  const orders = mongoose.connection.collection('orders');
  const commissions = mongoose.connection.collection('affiliatecommissions');

  // ─── Tìm buyer có referred_by ──────────────────────────────────────────────
  const buyer = await users.findOne(
    { referred_by: { $exists: true, $ne: null } },
    { projection: { _id: 1, email: 1, referred_by: 1 } },
  );

  if (!buyer) {
    console.error('Không tìm thấy user nào có referred_by. Hãy chạy seed-commissions.js trước hoặc gán referred_by thủ công.');
    process.exit(1);
  }

  const referrer = await users.findOne(
    { _id: buyer.referred_by },
    { projection: { _id: 1, email: 1 } },
  );

  if (!referrer) {
    console.error('Không tìm thấy referrer từ buyer.referred_by.');
    process.exit(1);
  }

  console.log(`Referrer : ${referrer.email} (${referrer._id})`);
  console.log(`Buyer    : ${buyer.email} (${buyer._id})`);

  // ─── Tạo 2 order + commission ──────────────────────────────────────────────
  const now = new Date();
  const insertedOrders = [];
  const insertedCommissions = [];

  for (let i = 0; i < 2; i++) {
    const orderId    = new ObjectId();
    const totalPrice = (i + 1) * 200_000; // 200k và 400k
    const endDate    = new Date(now.getTime() + EXPIRE_DAYS[i] * 86_400_000);
    const orderCode  = `ORD-EXPIRING-${String(i + 1).padStart(3, '0')}-${Date.now()}`;

    const order = {
      _id:            orderId,
      order_code:     orderCode,
      user_id:        buyer._id,
      service_id:     new ObjectId(),
      proxy_type:     'static_ipv4',
      quantity:       1,
      duration_days:  EXPIRE_DAYS[i] + 7, // bắt đầu từ 7 ngày trước
      price_per_unit: totalPrice,
      total_price:    totalPrice,
      currency:       'VND',
      status:         3,  // ACTIVE
      payment_status: 1,  // PAID
      payment_method: 'balance',
      start_date:     new Date(now.getTime() - 7 * 86_400_000),
      end_date:       endDate,
      config:         {},
      error_message:  '',
      admin_note:     '',
      auto_renew:     false,
      createdAt:      now,
      updatedAt:      now,
    };

    const commissionAmount = parseFloat((totalPrice * RATE / 100).toFixed(2));

    const commission = {
      referrer_id:       referrer._id,
      referred_user_id:  buyer._id,
      order_id:          orderId,
      order_total:       totalPrice,
      commission_rate:   RATE,
      commission_amount: commissionAmount,
      status:            'pending',
      confirmed_at:      null,
      credited_at:       null,
      requested_at:      null,
      paid_at:           null,
      bank_name:         '',
      bank_account:      '',
      bank_owner:        '',
      createdAt:         now,
      updatedAt:         now,
    };

    insertedOrders.push(order);
    insertedCommissions.push(commission);
  }

  await orders.insertMany(insertedOrders);
  await commissions.insertMany(insertedCommissions);

  console.log('\n✓ Đã thêm:');
  insertedOrders.forEach((o, i) => {
    const c = insertedCommissions[i];
    const days = EXPIRE_DAYS[i];
    console.log(`  [Order ${i + 1}] ${o.order_code}`);
    console.log(`    total_price     : ${o.total_price.toLocaleString()} VND`);
    console.log(`    end_date        : ${o.end_date.toLocaleString('vi-VN')} (còn ${days} ngày)`);
    console.log(`    commission      : ${c.commission_amount.toLocaleString()} VND (${RATE}%)`);
    console.log(`    commission._id  : ${insertedCommissions[i]._id ?? '(auto)'}`);
  });

  await mongoose.disconnect();
}).catch(e => { console.error(e); process.exit(1); });
