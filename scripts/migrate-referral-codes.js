/**
 * Gán referral_code cho tất cả user chưa có
 */
const mongoose = require('mongoose');

mongoose.connect('mongodb://localhost:27017/proxydb').then(async () => {
  const users = mongoose.connection.collection('users');

  const withoutCode = await users.find({
    $or: [
      { referral_code: { $exists: false } },
      { referral_code: '' },
      { referral_code: null },
    ],
  }).toArray();

  console.log(`Tìm thấy ${withoutCode.length} user chưa có referral_code`);

  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const genCode = () => 'REF_' + Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');

  let updated = 0;
  for (const user of withoutCode) {
    let code;
    // Tạo code unique
    while (true) {
      code = genCode();
      const exists = await users.findOne({ referral_code: code });
      if (!exists) break;
    }
    await users.updateOne({ _id: user._id }, { $set: { referral_code: code } });
    console.log(`  ${user.email} → ${code}`);
    updated++;
  }

  console.log(`\nĐã cập nhật ${updated} user`);
  await mongoose.disconnect();
});
