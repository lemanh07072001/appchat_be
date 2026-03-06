const mongoose = require('mongoose');
mongoose.connect('mongodb://localhost:27017/proxydb').then(async () => {
  const docs = await mongoose.connection.collection('orders')
    .find({ order_code: { $regex: 'ORD-FAKE' } })
    .project({ order_code: 1, status: 1, end_date: 1 })
    .toArray();
  console.log('Now:', new Date().toISOString());
  docs.forEach(o => console.log(o.order_code, '| status:', o.status, '| end_date:', o.end_date?.toISOString()));
  await mongoose.disconnect();
});
