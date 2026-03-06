/**
 * Seed affiliate commissions cho 10 fake orders
 * referrer = admin@admin.com (69a19345ab66168b4856796e)
 * buyer    = 69aa8066e6fe2d3bb4e86cef
 */
const mongoose = require('mongoose');
const { ObjectId } = mongoose.Types;

const REFERRER_ID = '69a19345ab66168b4856796e'; // admin@admin.com
const BUYER_ID    = '69aa8066e6fe2d3bb4e86cef';
const RATE        = 5; // 5%

mongoose.connect('mongodb://localhost:27017/proxydb').then(async () => {
  const orders = await mongoose.connection.collection('orders')
    .find({ order_code: { $regex: 'ORD-FAKE' } })
    .project({ _id: 1, order_code: 1, total_price: 1, status: 1 })
    .toArray();

  // Gán referred_by cho buyer
  await mongoose.connection.collection('users').updateOne(
    { _id: new ObjectId(BUYER_ID) },
    { $set: { referred_by: new ObjectId(REFERRER_ID) } }
  );
  console.log('Set referred_by for buyer');

  const commissions = orders.map(o => {
    const amount = parseFloat(((o.total_price ?? 200000) * RATE / 100).toFixed(2));
    // EXPIRED orders (status=5) → CONFIRMED, ACTIVE → PENDING
    const status = o.status === 5 ? 'confirmed' : 'pending';
    return {
      referrer_id:       new ObjectId(REFERRER_ID),
      referred_user_id:  new ObjectId(BUYER_ID),
      order_id:          o._id,
      order_total:       o.total_price ?? 200000,
      commission_rate:   RATE,
      commission_amount: amount,
      status,
      confirmed_at:      status === 'confirmed' ? new Date() : null,
      requested_at:      null,
      paid_at:           null,
      createdAt:         new Date(),
      updatedAt:         new Date(),
    };
  });

  await mongoose.connection.collection('affiliatecommissions').insertMany(commissions);

  console.log(`Inserted ${commissions.length} commissions:`);
  commissions.forEach((c, i) => console.log(
    ` ${orders[i].order_code} | ${c.status} | amount: ${c.commission_amount}`
  ));

  await mongoose.disconnect();
});
