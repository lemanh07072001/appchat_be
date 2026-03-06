/**
 * Migration: thêm bank fields vào users và affiliatecommissions
 */
const mongoose = require('mongoose');

mongoose.connect('mongodb://localhost:27017/proxydb').then(async () => {
  // 1. Thêm bank fields cho tất cả users chưa có
  const usersResult = await mongoose.connection.collection('users').updateMany(
    { bank_account: { $exists: false } },
    { $set: { bank_name: '', bank_account: '', bank_owner: '' } }
  );
  console.log('Users updated:', usersResult.modifiedCount);

  // 2. Thêm bank fields cho tất cả commissions chưa có
  const commissionsResult = await mongoose.connection.collection('affiliatecommissions').updateMany(
    { bank_account: { $exists: false } },
    { $set: { bank_name: '', bank_account: '', bank_owner: '' } }
  );
  console.log('Commissions updated:', commissionsResult.modifiedCount);

  // 3. Fake bank info cho admin (để test rút tiền)
  const bankResult = await mongoose.connection.collection('users').updateOne(
    { email: 'admin@admin.com' },
    { $set: { bank_name: 'Vietcombank', bank_account: '1234567890', bank_owner: 'NGUYEN VAN ADMIN' } }
  );
  console.log('Admin bank info set:', bankResult.modifiedCount);

  await mongoose.disconnect();
  console.log('Done.');
});
