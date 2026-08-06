import * as mongoose from 'mongoose';
import {
  PaymentMethod,
  TransactionSchema,
  TransactionStatus,
} from '../../schemas/transactions.schema';
import { UserSchema } from '../../schemas/users.schema';
import { UserRoleEnum } from '../../enum/user.enum';
import { daysAgo, emptyResult, forceTimestamps, SeedResult } from '../lib/db';

const Transaction =
  mongoose.models.TransactionSeed ||
  mongoose.model('TransactionSeed', TransactionSchema, 'transactions');
const User = mongoose.models.UserSeedDep || mongoose.model('UserSeedDep', UserSchema, 'users');

/**
 * Dữ liệu thật hiện có toàn `processed` — bộ lọc pending/unmatched/failed/rejected
 * ở /vi/admin/deposits không có dòng nào. Bổ sung các trạng thái còn thiếu.
 * Dải transaction_id 950xxx tách biệt với dải thật (1783410xxxxxx).
 */
interface Seed {
  transaction_id: number;
  gateway: string;
  amount: number;
  status: TransactionStatus;
  source: 'auto' | 'manual';
  payment_method?: PaymentMethod;
  crypto_amount?: number;
  tx_hash?: string;
  content: string;
  note: string;
  /** false = giao dịch mồ côi, không gắn user (dùng cho unmatched) */
  withUser: boolean;
  hoursAgo: number;
}

const ROWS: Seed[] = [
  {
    transaction_id: 950001,
    gateway: 'VCB',
    amount: 500000,
    status: TransactionStatus.PENDING,
    source: 'auto',
    content: 'NAP7C1D9E22 nap tien proxy',
    note: 'Trùng giao dịch — chờ admin xác nhận',
    withUser: true,
    hoursAgo: 3,
  },
  {
    transaction_id: 950002,
    gateway: 'MB',
    amount: 1200000,
    status: TransactionStatus.PENDING,
    source: 'auto',
    content: 'NAP3B77A0C4 thanh toan',
    note: 'Chờ đối soát với ngân hàng',
    withUser: true,
    hoursAgo: 7,
  },
  {
    transaction_id: 950003,
    gateway: 'TCB',
    amount: 300000,
    status: TransactionStatus.UNMATCHED,
    source: 'auto',
    content: 'NGUYEN VAN TUAN chuyen tien',
    note: 'Không tìm được mã nạp trong nội dung CK',
    withUser: false,
    hoursAgo: 11,
  },
  {
    transaction_id: 950004,
    gateway: 'ACB',
    amount: 450000,
    status: TransactionStatus.UNMATCHED,
    source: 'auto',
    content: 'TRAN THI MAI thanh toan dich vu',
    note: 'Không tìm được mã nạp trong nội dung CK',
    withUser: false,
    hoursAgo: 26,
  },
  {
    transaction_id: 950005,
    gateway: 'VPB',
    amount: 80000,
    status: TransactionStatus.UNMATCHED,
    source: 'auto',
    content: 'ck mua proxy',
    note: 'Nội dung CK không chứa mã định danh',
    withUser: false,
    hoursAgo: 39,
  },
  {
    transaction_id: 950006,
    gateway: 'VCB',
    amount: 200000,
    status: TransactionStatus.FAILED,
    source: 'auto',
    content: 'NAP1A2B3C4D nap tien',
    note: 'Checksum không hợp lệ',
    withUser: true,
    hoursAgo: 15,
  },
  {
    transaction_id: 950007,
    gateway: 'TCB',
    amount: 800000,
    status: TransactionStatus.FAILED,
    source: 'auto',
    content: 'NAPDEADBEEF proxy',
    note: 'Lỗi kết nối tới hệ thống ví khi cộng tiền',
    withUser: true,
    hoursAgo: 33,
  },
  {
    transaction_id: 950008,
    gateway: 'MB',
    amount: 5000,
    status: TransactionStatus.REJECTED,
    source: 'auto',
    content: 'NAP55AA11BB test',
    note: 'Dưới mức nạp tối thiểu — admin từ chối',
    withUser: true,
    hoursAgo: 20,
  },
  {
    transaction_id: 950009,
    gateway: 'VCB',
    amount: 50000,
    status: TransactionStatus.REJECTED,
    source: 'auto',
    content: 'NAP99887766 nap tien',
    note: 'Giao dịch đáng ngờ — admin huỷ',
    withUser: true,
    hoursAgo: 47,
  },
  {
    transaction_id: 950010,
    gateway: 'MANUAL',
    amount: 2000000,
    status: TransactionStatus.PROCESSED,
    source: 'manual',
    content: 'Admin nạp tay cho khách doanh nghiệp',
    note: 'Khách chuyển khoản công ty, đối soát thủ công',
    withUser: true,
    hoursAgo: 29,
  },
  {
    transaction_id: 950011,
    gateway: 'MANUAL',
    amount: 150000,
    status: TransactionStatus.PROCESSED,
    source: 'manual',
    content: 'Hoàn tiền đơn hàng lỗi',
    note: 'Admin hoàn tay 150.000đ',
    withUser: true,
    hoursAgo: 52,
  },
  {
    transaction_id: 950012,
    gateway: 'MANUAL',
    amount: 100000,
    status: TransactionStatus.PROCESSED,
    source: 'manual',
    content: 'Khuyến mãi tháng 8 - tặng 100k',
    note: 'Quà tặng chương trình khuyến mãi',
    withUser: true,
    hoursAgo: 64,
  },
  {
    transaction_id: 950013,
    gateway: 'BINANCE',
    amount: 2600000,
    status: TransactionStatus.PROCESSED,
    source: 'auto',
    payment_method: PaymentMethod.USDT_TRC20,
    crypto_amount: 100,
    tx_hash: 'TW7d5aQ2f1c9E3b8A6d4C2e0F9b7D5a3C1e8B6f4',
    content: 'USDT TRC20 deposit',
    note: 'Nạp 100 USDT qua TRC20',
    withUser: true,
    hoursAgo: 18,
  },
  {
    transaction_id: 950014,
    gateway: 'BINANCE',
    amount: 1300000,
    status: TransactionStatus.PENDING,
    source: 'auto',
    payment_method: PaymentMethod.BINANCE_PAY,
    crypto_amount: 50,
    tx_hash: 'BP-2026080512345678',
    content: 'Binance Pay order 2026080512345678',
    note: 'Chờ xác nhận đủ số block',
    withUser: true,
    hoursAgo: 5,
  },
];

export async function seedDeposits(): Promise<SeedResult> {
  const result = emptyResult();

  const users = await User.find({ role: UserRoleEnum.USER })
    .sort({ _id: 1 })
    .limit(8)
    .select('_id email topup_code money')
    .lean()
    .exec();

  if (users.length === 0) {
    throw new Error('Không có user nào để gán giao dịch nạp tiền.');
  }

  for (let i = 0; i < ROWS.length; i++) {
    const row = ROWS[i];

    if (await Transaction.findOne({ transaction_id: row.transaction_id }).select('_id').lean().exec()) {
      result.skipped++;
      continue;
    }

    const user: any = row.withUser ? users[i % users.length] : null;
    const at = daysAgo(row.hoursAgo / 24);
    const processed = row.status === TransactionStatus.PROCESSED;
    const balanceBefore = user ? Math.max(0, (user.money ?? 0) - row.amount) : 0;

    const created = await Transaction.create({
      transaction_id: row.transaction_id,
      gateway: row.gateway,
      transaction_date: at,
      transaction_number: row.source === 'manual' ? '' : `FT${row.transaction_id}`,
      account_number: row.source === 'manual' ? '' : '0071000512345',
      // Dùng đúng topup_code của user để nội dung CK khớp với dữ liệu thật
      content: user?.topup_code
        ? row.content.replace(/NAP[0-9A-F]{8}/, user.topup_code)
        : row.content,
      code: user?.topup_code ?? '',
      transfer_type: 'IN',
      transfer_amount: row.amount,
      checksum: row.status === TransactionStatus.FAILED ? 'invalid_checksum' : `chk${row.transaction_id}`,
      status: row.status,
      user_id: user?._id ?? null,
      balance_before: processed ? balanceBefore : 0,
      balance_after: processed ? balanceBefore + row.amount : 0,
      source: row.source,
      payment_method: row.payment_method ?? PaymentMethod.BANK,
      crypto_amount: row.crypto_amount ?? 0,
      tx_hash: row.tx_hash ?? '',
      note: row.note,
    });
    await forceTimestamps(Transaction, { _id: created._id }, at);
    result.created++;
  }

  return result;
}
