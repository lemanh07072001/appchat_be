import * as mongoose from 'mongoose';
import * as dotenv from 'dotenv';

dotenv.config();

async function run() {
  const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/proxydb';
  await mongoose.connect(uri);
  console.log('Connected:', uri, '\n');

  const Service = mongoose.model('Service', new mongoose.Schema({}, { strict: false }), 'services');
  const User = mongoose.model('User', new mongoose.Schema({}, { strict: false }), 'users');

  // Liệt kê user
  const users = await User.find({}, { _id: 1, email: 1, role: 1 }).lean<any[]>();
  console.log('USERS:');
  for (const u of users) {
    console.log(`  ${u._id}  role=${u.role}  ${u.email}`);
  }

  console.log('\nSERVICES có user_discounts:');
  const services = await Service.find({}, { name: 1, pricing: 1, user_discounts: 1 }).lean();
  for (const s of services as any[]) {
    if (s.user_discounts && Object.keys(s.user_discounts).length > 0) {
      console.log(`\n  ${s.name}  (${s._id})`);
      console.log(`    pricing:`, JSON.stringify(s.pricing));
      console.log(`    user_discounts:`, JSON.stringify(s.user_discounts, null, 2));
    }
  }

  await mongoose.disconnect();
}

run().catch((e) => { console.error(e); process.exit(1); });
