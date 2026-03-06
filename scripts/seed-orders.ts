/**
 * Seed 10 fake orders (ACTIVE, 3–4 proxies each)
 * Run: npx ts-node -r tsconfig-paths/register scripts/seed-orders.ts
 */
import mongoose, { Types } from 'mongoose';

const MONGO_URI = 'mongodb://localhost:27017/proxydb';

// ─── Minimal schemas ───────────────────────────────────────────────────────
const OrderSchema = new mongoose.Schema({
  order_code:      { type: String, required: true, unique: true },
  user_id:         { type: Types.ObjectId, ref: 'User', required: true },
  service_id:      { type: Types.ObjectId, ref: 'Service' },
  proxy_type:      String,
  quantity:        Number,
  duration_days:   Number,
  price_per_unit:  Number,
  total_price:     Number,
  currency:        { type: String, default: 'VND' },
  status:          { type: Number, default: 3 }, // ACTIVE = 3
  payment_status:  { type: Number, default: 1 }, // PAID = 1
  payment_method:  { type: String, default: 'balance' },
  start_date:      Date,
  end_date:        Date,
}, { timestamps: true });

const ProxySchema = new mongoose.Schema({
  order_id:          { type: Types.ObjectId, ref: 'Order' },
  ip_address:        String,
  port:              Number,
  protocol:          String,
  auth_username:     String,
  auth_password:     String,
  country_code:      String,
  region:            String,
  city:              String,
  provider:          String,
  is_active:         { type: Boolean, default: true },
  is_available:      { type: Boolean, default: true },
  health_status:     { type: String, default: 'healthy' },
}, { timestamps: true });

const UserSchema = new mongoose.Schema({
  email: String, name: String,
});

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB');

  const Order = mongoose.model('Order', OrderSchema);
  const Proxy  = mongoose.model('Proxy',  ProxySchema);
  const User   = mongoose.model('User',   UserSchema);

  // Lấy user đầu tiên trong DB
  const user = await User.findOne().lean();
  if (!user) {
    console.error('Không có user nào trong DB. Hãy tạo user trước.');
    process.exit(1);
  }
  console.log(`Dùng user: ${(user as any).email} (${user._id})`);

  const fakeIps = () =>
    `${rand(1,254)}.${rand(1,254)}.${rand(1,254)}.${rand(1,254)}`;
  const protocols = ['http', 'https', 'socks5'];
  const countries = ['VN', 'US', 'SG', 'JP', 'KR'];
  const cities    = ['Hanoi', 'HCMC', 'New York', 'Singapore', 'Tokyo'];

  const orders: any[] = [];
  const proxies: any[] = [];

  for (let i = 1; i <= 10; i++) {
    const orderId      = new Types.ObjectId();
    const qty          = rand(3, 4);
    const pricePerUnit = [50000, 80000, 120000][rand(0, 2)];
    const totalPrice   = qty * pricePerUnit;
    const start        = new Date();
    const end          = new Date(start.getTime() + rand(7, 30) * 86400_000);
    const countryIdx   = rand(0, 4);

    orders.push({
      _id:            orderId,
      order_code:     `ORD-FAKE-${String(i).padStart(3, '0')}`,
      user_id:        user._id,
      service_id:     new Types.ObjectId(),
      proxy_type:     'static_ipv4',
      quantity:       qty,
      duration_days:  rand(7, 30),
      price_per_unit: pricePerUnit,
      total_price:    totalPrice,
      status:         3, // ACTIVE
      payment_status: 1, // PAID
      payment_method: 'balance',
      start_date:     start,
      end_date:       end,
    });

    for (let p = 0; p < qty; p++) {
      proxies.push({
        order_id:      orderId,
        ip_address:    fakeIps(),
        port:          rand(3000, 9999),
        protocol:      protocols[rand(0, 2)],
        auth_username: `user_${orderId.toString().slice(-6)}_${p}`,
        auth_password: `pass_${Math.random().toString(36).slice(2, 10)}`,
        country_code:  countries[countryIdx],
        region:        '',
        city:          cities[countryIdx],
        provider:      'fake-provider',
        is_active:     true,
        is_available:  true,
        health_status: 'healthy',
      });
    }
  }

  await Order.insertMany(orders);
  await Proxy.insertMany(proxies);

  console.log(`✓ Inserted ${orders.length} orders, ${proxies.length} proxies`);
  orders.forEach(o =>
    console.log(`  ${o.order_code} — ${proxies.filter(p => p.order_id.equals(o._id)).length} proxies — ${o.end_date.toLocaleDateString('vi')}`),
  );

  await mongoose.disconnect();
}

function rand(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

main().catch(e => { console.error(e); process.exit(1); });
