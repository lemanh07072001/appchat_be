/**
 * Tạo (hoặc cập nhật) tài khoản admin (role 0).
 *
 * Run: ADMIN_EMAIL=... ADMIN_PASSWORD=... node scripts/seed-admin.js
 */
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/proxydb';
const EMAIL = process.env.ADMIN_EMAIL;
const PASSWORD = process.env.ADMIN_PASSWORD;

if (!EMAIL || !PASSWORD) {
  console.error('Thiếu biến môi trường ADMIN_EMAIL / ADMIN_PASSWORD');
  process.exit(1);
}

const ROLE_ADMIN = 0;
const STATUS_ACTIVE = 1;

(async () => {
  await mongoose.connect(MONGO_URI);
  const users = mongoose.connection.collection('users');

  const hash = await bcrypt.hash(PASSWORD, 10);
  const now = new Date();

  const existing = await users.findOne({ email: EMAIL });

  if (existing) {
    await users.updateOne(
      { _id: existing._id },
      {
        $set: {
          password: hash,
          role: ROLE_ADMIN,
          status: STATUS_ACTIVE,
          updatedAt: now,
        },
      },
    );
    console.log(`Updated admin: ${EMAIL} (_id=${existing._id})`);
  } else {
    const topup_code = 'NAP' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const result = await users.insertOne({
      name: 'Admin',
      email: EMAIL,
      password: hash,
      avatar: '',
      role: ROLE_ADMIN,
      status: STATUS_ACTIVE,
      email_verified_at: now,
      last_login_at: now,
      money: 0,
      country: '',
      topup_code,
      referral_code: null,
      referred_by: null,
      affiliate_balance: 0,
      commission_rate: null,
      api_token: null,
      bank_name: '',
      bank_account: '',
      bank_owner: '',
      createdAt: now,
      updatedAt: now,
    });
    console.log(`Created admin: ${EMAIL} (_id=${result.insertedId})`);
  }

  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
