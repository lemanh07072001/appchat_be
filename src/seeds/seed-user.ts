import * as mongoose from 'mongoose';
import * as bcrypt from 'bcrypt';
import * as dotenv from 'dotenv';

dotenv.config();

const USER_EMAIL = 'user@fastproxyvn.com';
const USER_PASSWORD = 'User@12345';
const USER_NAME = 'User';

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

  const hash = await bcrypt.hash(USER_PASSWORD, 10);

  const existing = await User.findOne({ email: USER_EMAIL }).lean();
  if (existing) {
    await User.updateOne(
      { email: USER_EMAIL },
      { $set: { password: hash, role: 1, status: 1, name: USER_NAME } },
    );
    console.log(`✓ Updated existing user ${USER_EMAIL} (role=USER, status=ACTIVE, password reset)`);
  } else {
    await User.create({
      name: USER_NAME,
      email: USER_EMAIL,
      password: hash,
      role: 1,
      status: 1,
      money: 0,
      email_verified_at: new Date(),
      last_login_at: new Date(),
    });
    console.log(`✓ Created user ${USER_EMAIL}`);
  }

  console.log(`\nLogin credentials:`);
  console.log(`  Email:    ${USER_EMAIL}`);
  console.log(`  Password: ${USER_PASSWORD}`);

  await mongoose.disconnect();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
