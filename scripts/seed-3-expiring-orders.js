/**
 * Seed 3 order ACTIVE sắp hết hạn (còn 1, 2, 3 ngày)
 * Không yêu cầu affiliate. Dùng user đầu tiên trong DB.
 *
 * Run: node scripts/seed-3-expiring-orders.js
 */
const mongoose = require('mongoose');
const { ObjectId } = mongoose.Types;

const MONGO_URI   = 'mongodb://localhost:27017/proxydb';
const EXPIRE_DAYS = [1, 2, 3];

mongoose.connect(MONGO_URI).then(async () => {
  const users  = mongoose.connection.collection('users');
  const orders = mongoose.connection.collection('orders');

  const user = await users.findOne({}, { projection: { _id: 1, email: 1 } });
  if (!user) {
    console.error('Không tìm thấy user nào trong DB. Hãy tạo user trước.');
    process.exit(1);
  }
  console.log(`User: ${user.email} (${user._id})`);

  const now = new Date();
  const inserted = [];

  for (let i = 0; i < 3; i++) {
    const orderId    = new ObjectId();
    const days       = EXPIRE_DAYS[i];
    const totalPrice = (i + 1) * 200_000; // 200k, 400k, 600k
    const endDate    = new Date(now.getTime() + days * 86_400_000);
    const orderCode  = `ORD-NEAR-EXP-${String(i + 1).padStart(3, '0')}-${Date.now()}`;

    const order = {
      _id:            orderId,
      order_code:     orderCode,
      user_id:        user._id,
      service_id:     new ObjectId(),
      proxy_type:     'static_ipv4',
      quantity:       1,
      duration_days:  days + 7,
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

    inserted.push(order);
  }

  await orders.insertMany(inserted);

  console.log('\n✓ Đã tạo 3 đơn hàng sắp hết hạn:');
  inserted.forEach((o, i) => {
    const days = EXPIRE_DAYS[i];
    console.log(`  [${i + 1}] ${o.order_code}`);
    console.log(`      total_price : ${o.total_price.toLocaleString('vi-VN')} VND`);
    console.log(`      end_date    : ${o.end_date.toLocaleString('vi-VN')} (còn ${days} ngày)`);
  });

  await mongoose.disconnect();
}).catch(e => { console.error(e); process.exit(1); });
