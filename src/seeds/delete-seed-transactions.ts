import * as mongoose from 'mongoose';
import * as dotenv from 'dotenv';

dotenv.config();

async function run() {
  const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/proxydb';
  await mongoose.connect(uri);
  console.log('Connected to MongoDB');

  const TransactionSchema = new mongoose.Schema({ transaction_id: Number });
  const Transaction = mongoose.model('Transaction', TransactionSchema, 'transactions');
  const result = await Transaction.deleteMany({
    transaction_id: { $gte: 900001, $lte: 900020 },
  });
  console.log('Deleted:', result.deletedCount, 'transactions');

  await mongoose.disconnect();
}

run().catch(console.error);
