const mongoose = require('mongoose');
mongoose.connect('mongodb://localhost:27017/proxydb').then(async () => {
  const docs = await mongoose.connection.collection('affiliatecommissions')
    .find({})
    .project({ referrer_id: 1, status: 1, commission_amount: 1 })
    .toArray();

  console.log('Total commissions:', docs.length);
  docs.forEach(d => console.log(
    ' referrer_id:', d.referrer_id?.toString(),
    '| status:', d.status,
    '| amount:', d.commission_amount
  ));

  // Aggregate test
  const { ObjectId } = mongoose.Types;
  const REFERRER = '69a19345ab66168b4856796e';
  const agg = await mongoose.connection.collection('affiliatecommissions').aggregate([
    { $match: { referrer_id: new ObjectId(REFERRER) } },
    { $group: {
      _id: null,
      total_earned:    { $sum: '$commission_amount' },
      total_confirmed: { $sum: { $cond: [{ $eq: ['$status', 'confirmed'] }, '$commission_amount', 0] } },
      total_orders:    { $sum: 1 },
    }}
  ]).toArray();
  console.log('\nAggregate result:', JSON.stringify(agg, null, 2));

  await mongoose.disconnect();
});
