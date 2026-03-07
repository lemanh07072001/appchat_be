import * as mongoose from 'mongoose';
import * as dotenv from 'dotenv';

dotenv.config();

const TransactionSchema = new mongoose.Schema({
  transaction_id: { type: Number, required: true, unique: true },
  gateway: String,
  transaction_date: Date,
  transaction_number: String,
  account_number: String,
  content: String,
  code: String,
  transfer_type: String,
  transfer_amount: Number,
  checksum: String,
  status: String,
  user_id: { type: mongoose.Types.ObjectId, default: null },
  balance_before: { type: Number, default: 0 },
  balance_after: { type: Number, default: 0 },
  source: { type: String, default: 'auto' },
  note: { type: String, default: '' },
}, { timestamps: true });

async function seed() {
  const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/proxydb';
  await mongoose.connect(uri);
  console.log('Connected to MongoDB');

  const Transaction = mongoose.model('Transaction', TransactionSchema, 'transactions');

  const transactions = [
    // 1. Auto - Processed (thành công)
    {
      transaction_id: 900001,
      gateway: 'VCB',
      transaction_date: new Date('2026-03-08T08:00:00Z'),
      transaction_number: 'FT900001',
      account_number: '1234567890',
      content: 'NAP3F9A2C1D nap tien proxy',
      code: 'NAP3F9A2C1D',
      transfer_type: 'IN',
      transfer_amount: 500000,
      checksum: 'abc123',
      status: 'processed',
      source: 'auto',
      balance_before: 100000,
      balance_after: 600000,
      note: 'Nạp 500.000đ cho user@example.com',
    },
    // 2. Auto - Processed
    {
      transaction_id: 900002,
      gateway: 'MB',
      transaction_date: new Date('2026-03-08T09:15:00Z'),
      transaction_number: 'FT900002',
      account_number: '9876543210',
      content: 'NAPB2C4D6E8 thanh toan',
      code: 'NAPB2C4D6E8',
      transfer_type: 'IN',
      transfer_amount: 1000000,
      checksum: 'def456',
      status: 'processed',
      source: 'auto',
      balance_before: 200000,
      balance_after: 1200000,
      note: 'Nạp 1.000.000đ cho admin@proxy.vn',
    },
    // 3. Auto - Unmatched (không tìm được user)
    {
      transaction_id: 900003,
      gateway: 'TCB',
      transaction_date: new Date('2026-03-08T10:30:00Z'),
      transaction_number: 'FT900003',
      account_number: '5555666677',
      content: 'chuyen tien mua proxy',
      code: '',
      transfer_type: 'IN',
      transfer_amount: 300000,
      checksum: 'ghi789',
      status: 'unmatched',
      source: 'auto',
      note: 'Không tìm được user trong nội dung CK',
    },
    // 4. Auto - Failed (checksum sai)
    {
      transaction_id: 900004,
      gateway: 'VCB',
      transaction_date: new Date('2026-03-08T11:00:00Z'),
      transaction_number: 'FT900004',
      account_number: '1234567890',
      content: 'NAP1A2B3C4D nap tien',
      code: 'NAP1A2B3C4D',
      transfer_type: 'IN',
      transfer_amount: 200000,
      checksum: 'invalid_checksum',
      status: 'failed',
      source: 'auto',
      note: 'Checksum không hợp lệ',
    },
    // 5. Auto - Pending (chờ xử lý - trùng giao dịch)
    {
      transaction_id: 900005,
      gateway: 'MB',
      transaction_date: new Date('2026-03-08T12:00:00Z'),
      transaction_number: 'FT900005',
      account_number: '9876543210',
      content: 'NAPB2C4D6E8 thanh toan',
      code: 'NAPB2C4D6E8',
      transfer_type: 'IN',
      transfer_amount: 1000000,
      checksum: 'jkl012',
      status: 'pending',
      source: 'auto',
      note: 'Trùng giao dịch — user: admin@proxy.vn, cần admin xác nhận',
    },
    // 6. Manual - Processed (admin nạp tay thành công)
    {
      transaction_id: 900006,
      gateway: 'MANUAL',
      transaction_date: new Date('2026-03-08T13:00:00Z'),
      transaction_number: '',
      account_number: '',
      content: 'Admin nạp tay cho khách VIP',
      code: '',
      transfer_type: 'IN',
      transfer_amount: 2000000,
      checksum: '',
      status: 'processed',
      source: 'manual',
      balance_before: 500000,
      balance_after: 2500000,
      note: 'Admin nạp tay 2.000.000đ cho vip@example.com',
    },
    // 7. Manual - Processed
    {
      transaction_id: 900007,
      gateway: 'MANUAL',
      transaction_date: new Date('2026-03-08T14:00:00Z'),
      transaction_number: '',
      account_number: '',
      content: 'Hoàn tiền đơn hàng lỗi #ORD123',
      code: '',
      transfer_type: 'IN',
      transfer_amount: 150000,
      checksum: '',
      status: 'processed',
      source: 'manual',
      balance_before: 0,
      balance_after: 150000,
      note: 'Hoàn tiền 150.000đ cho test@gmail.com - đơn lỗi',
    },
    // 8. Auto - Processed
    {
      transaction_id: 900008,
      gateway: 'ACB',
      transaction_date: new Date('2026-03-07T16:30:00Z'),
      transaction_number: 'FT900008',
      account_number: '1112223334',
      content: 'NAPFF00AA11 mua proxy ipv4',
      code: 'NAPFF00AA11',
      transfer_type: 'IN',
      transfer_amount: 750000,
      checksum: 'mno345',
      status: 'processed',
      source: 'auto',
      balance_before: 50000,
      balance_after: 800000,
      note: 'Nạp 750.000đ cho buyer@gmail.com',
    },
    // 9. Auto - Failed
    {
      transaction_id: 900009,
      gateway: 'VPB',
      transaction_date: new Date('2026-03-07T18:00:00Z'),
      transaction_number: 'FT900009',
      account_number: '4445556667',
      content: 'NAP12345678 nap proxy',
      code: 'NAP12345678',
      transfer_type: 'IN',
      transfer_amount: 100000,
      checksum: 'bad_hash',
      status: 'failed',
      source: 'auto',
      note: 'Checksum không hợp lệ',
    },
    // 10. Manual - Processed (khuyến mãi)
    {
      transaction_id: 900010,
      gateway: 'MANUAL',
      transaction_date: new Date('2026-03-07T20:00:00Z'),
      transaction_number: '',
      account_number: '',
      content: 'Khuyến mãi tháng 3 - tặng 100k',
      code: '',
      transfer_type: 'IN',
      transfer_amount: 100000,
      checksum: '',
      status: 'processed',
      source: 'manual',
      balance_before: 800000,
      balance_after: 900000,
      note: 'Khuyến mãi tháng 3 - tặng 100.000đ cho buyer@gmail.com',
    },
  ];

  for (const tx of transactions) {
    try {
      await Transaction.create(tx);
      console.log(`Created: #${tx.transaction_id} [${tx.source}] [${tx.status}] ${tx.transfer_amount.toLocaleString('vi-VN')}đ`);
    } catch (err: any) {
      if (err.code === 11000) {
        console.log(`Skipped: #${tx.transaction_id} (already exists)`);
      } else {
        console.error(`Error: #${tx.transaction_id} — ${err.message}`);
      }
    }
  }

  console.log('\nDone! 10 sample transactions seeded.');
  await mongoose.disconnect();
}

seed().catch(console.error);
