import * as mongoose from 'mongoose';
import * as bcrypt from 'bcrypt';
import * as dotenv from 'dotenv';

dotenv.config();

const ADMIN_EMAIL = 'admin@fastproxyvn.com';
const ADMIN_PASSWORD = 'Admin@12345';
const ADMIN_NAME = 'Admin';

const UserSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  password: String,
  role: Number,
  status: Number,
  money: Number,
  email_verified_at: Date,
  last_login_at: Date,
}, { timestamps: true, strict: false });

async function run() {
  const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/proxydb';
  await mongoose.connect(uri);
  console.log('Connected to MongoDB:', uri);

  const User = mongoose.model('User', UserSchema, 'users');

  const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);

  const existing = await User.findOne({ email: ADMIN_EMAIL }).lean();
  if (existing) {
    await User.updateOne(
      { email: ADMIN_EMAIL },
      { $set: { password: hash, role: 0, status: 1, name: ADMIN_NAME } },
    );
    console.log(`✓ Updated existing user ${ADMIN_EMAIL} (role=ADMIN, status=ACTIVE, password reset)`);
  } else {
    await User.create({
      name: ADMIN_NAME,
      email: ADMIN_EMAIL,
      password: hash,
      role: 0,
      status: 1,
      money: 0,
      email_verified_at: new Date(),
      last_login_at: new Date(),
    });
    console.log(`✓ Created admin user ${ADMIN_EMAIL}`);
  }

  console.log(`\nLogin credentials:`);
  console.log(`  Email:    ${ADMIN_EMAIL}`);
  console.log(`  Password: ${ADMIN_PASSWORD}`);

  await mongoose.disconnect();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
