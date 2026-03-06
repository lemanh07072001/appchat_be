const mongoose = require('mongoose');

mongoose.connect('mongodb://localhost:27017/proxydb').then(async () => {
  const result = await mongoose.connection.collection('affiliatecommissions').updateMany(
    { status: 'confirmed' },
    { $set: { status: 'requested', requested_at: new Date() } }
  );
  console.log('Updated to requested:', result.modifiedCount, 'commissions');
  await mongoose.disconnect();
});
