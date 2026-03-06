/**
 * Migration: thêm credited_at field vào affiliatecommissions
 */
const mongoose = require('mongoose');

mongoose.connect('mongodb://localhost:27017/proxydb').then(async () => {
  const col = mongoose.connection.collection('affiliatecommissions');

  // Thêm credited_at null cho tất cả chưa có
  const r1 = await col.updateMany(
    { credited_at: { $exists: false } },
    { $set: { credited_at: null } }
  );
  console.log('Added credited_at field:', r1.modifiedCount, 'docs');

  // Xem phân bố status hiện tại
  const stats = await col.aggregate([
    { $group: { _id: '$status', count: { $sum: 1 } } }
  ]).toArray();
  console.log('\nStatus hiện tại:');
  stats.forEach(s => console.log(' ', s._id, ':', s.count));

  await mongoose.disconnect();
});
