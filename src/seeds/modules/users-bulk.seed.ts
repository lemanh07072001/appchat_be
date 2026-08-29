import * as mongoose from 'mongoose';
import * as bcrypt from 'bcrypt';
import { UserSchema } from '../../schemas/users.schema';
import { UserRoleEnum, UserStatusEnum } from '../../enum/user.enum';
import {
  daysAgo,
  emptyResult,
  forceTimestamps,
  intBetween,
  pick,
  rng,
  SeedResult,
} from '../lib/db';

const User =
  mongoose.models.UserBulkSeed || mongoose.model('UserBulkSeed', UserSchema, 'users');

/** Số user sinh ra. Đổi bằng biến môi trường: SEED_USER_COUNT=200 npm run seed */
const COUNT = Number(process.env.SEED_USER_COUNT) || 60;

/** Mọi tài khoản sinh ra đều mang đuôi này — nhận diện để xoá sạch khi cần. */
export const BULK_DOMAIN = 'demo.fastproxyvn.com';
const PASSWORD = 'User@12345';

const HO = ['Nguyễn', 'Trần', 'Lê', 'Phạm', 'Hoàng', 'Vũ', 'Đặng', 'Bùi', 'Đỗ', 'Ngô', 'Dương', 'Lý'];
const DEM = ['Văn', 'Thị', 'Hữu', 'Đức', 'Minh', 'Quang', 'Thanh', 'Ngọc', 'Anh', 'Gia'];
const TEN = [
  'An', 'Bình', 'Cường', 'Dũng', 'Giang', 'Hà', 'Hải', 'Hùng', 'Khoa', 'Lâm',
  'Linh', 'Mai', 'Nam', 'Nhung', 'Phong', 'Quân', 'Sơn', 'Tâm', 'Thảo', 'Trang',
  'Tuấn', 'Vy', 'Yến', 'Đạt', 'Hiếu',
];

const BANKS = ['Vietcombank', 'Techcombank', 'MB Bank', 'ACB', 'VPBank', 'BIDV', 'VietinBank', 'TPBank'];

/** Tài khoản quản trị mẫu — đủ để thử bộ lọc vai trò, không cần nhiều. */
const ADMIN_NAMES = [
  'Trần Quản Trị',
  'Lê Kế Toán',
  'Phạm Hỗ Trợ',
  'Nguyễn Vận Hành',
  'Vũ Kỹ Thuật',
];

/** Bỏ dấu để dựng email từ tên tiếng Việt. */
function noAccent(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

const slug = (s: string) => noAccent(s).trim().replace(/\s+/g, '.');

/**
 * Sinh user hàng loạt cho trang quản trị.
 *
 * Seed cũ chỉ tạo đúng một tài khoản demo nên bảng user trong admin không đủ
 * hàng để thử phân trang, lọc trạng thái/vai trò hay tìm kiếm. Ở đây trải đều
 * trạng thái, số dư, ngày tạo và tỉ lệ hoa hồng để mỗi bộ lọc đều có kết quả.
 *
 * QUAN TRỌNG: bốc hết số ngẫu nhiên TRƯỚC khi kiểm tra tồn tại. `continue` sớm
 * làm lần chạy sau lệch pha PRNG, sinh email khác trong khi `topup_code` đánh
 * theo chỉ số vẫn trùng — seed chết vì duplicate key.
 */
export async function seedUsersBulk(): Promise<SeedResult> {
  const result = emptyResult();
  const rand = rng(20260822);
  const hashed = await bcrypt.hash(PASSWORD, 10);

  for (let i = 0; i < COUNT; i++) {
    // ── bốc số trước: mọi vòng lặp gọi rand() đúng số lần như nhau ──
    const fullName = `${pick(rand, HO)} ${pick(rand, DEM)} ${pick(rand, TEN)}`;
    const roll = rand();
    // Đa số hoạt động bình thường; vẫn chừa đủ user khoá và chờ kích hoạt để
    // bộ lọc trạng thái không bao giờ ra bảng rỗng.
    const status =
      roll > 0.9 ? UserStatusEnum.BANNED : roll > 0.78 ? UserStatusEnum.INACTIVE : UserStatusEnum.ACTIVE;
    // Số dư lệch phải: phần lớn ít tiền, vài tài khoản nhiều — giống thực tế
    // hơn phân phối đều, và làm cột sắp xếp theo số dư có ý nghĩa.
    const money = roll > 0.85 ? intBetween(rand, 2_000_000, 30_000_000) : intBetween(rand, 0, 800_000);
    const createdAt = daysAgo(intBetween(rand, 1, 540));
    const lastLogin = daysAgo(intBetween(rand, 0, 60));
    const refName = pick(rand, TEN);
    const affiliateBalance = intBetween(rand, 10, 900) * 1000;
    const commission = intBetween(rand, 5, 25);
    const bankName = pick(rand, BANKS);
    const bankAccount = intBetween(rand, 1000000000, 9999999999);
    const updatedAt = daysAgo(intBetween(rand, 0, 30));

    // Số thứ tự nằm trong email để không đụng nhau khi trùng tên.
    const email = `${slug(fullName)}${i + 1}@${BULK_DOMAIN}`;

    const existing = await User.findOne({ email }).select('_id').lean().exec();
    if (existing) {
      result.skipped++;
      continue;
    }

    await User.create({
      name: fullName,
      email,
      password: hashed,
      role: UserRoleEnum.USER,
      status,
      money: Math.round(money / 1000) * 1000,
      country: 'VN',
      email_verified_at: status === UserStatusEnum.INACTIVE ? null : createdAt,
      last_login_at: lastLogin,
      topup_code: `NAP${String(900000 + i)}`,
      referral_code: `REF${noAccent(refName)}${String(i + 1).padStart(3, '0')}`.toUpperCase(),
      affiliate_balance: roll > 0.7 ? affiliateBalance : 0,
      commission_rate: roll > 0.93 ? commission : null,
      bank_name: bankName,
      bank_account: String(bankAccount),
    });

    // timestamps: true bỏ qua createdAt truyền vào nên phải ghi đè thô, không
    // thì mọi user đều "vừa tạo" và cột ngày tham gia vô dụng.
    await forceTimestamps(User, { email }, createdAt, updatedAt);
    result.created++;
  }

  // Vài tài khoản quản trị để bộ lọc theo vai trò có dữ liệu. Không gắn
  // affiliate hay số dư: admin không phải khách hàng.
  for (const [i, name] of ADMIN_NAMES.entries()) {
    const createdAt = daysAgo(intBetween(rand, 200, 700));
    const lastLogin = daysAgo(intBetween(rand, 0, 7));
    const updatedAt = daysAgo(intBetween(rand, 0, 5));
    const email = `${slug(name)}@${BULK_DOMAIN}`;

    const existing = await User.findOne({ email }).select('_id').lean().exec();
    if (existing) {
      result.skipped++;
      continue;
    }

    await User.create({
      name,
      email,
      password: hashed,
      role: UserRoleEnum.ADMIN,
      status: UserStatusEnum.ACTIVE,
      money: 0,
      country: 'VN',
      email_verified_at: createdAt,
      last_login_at: lastLogin,
      topup_code: `NAP${String(880000 + i)}`,
      // referral_code mac dinh la null, ma index unique+sparse van coi null
      // la mot gia tri -> hai admin cung null se dung nhau.
      referral_code: `REFADM${String(i + 1).padStart(3, '0')}`,
    });
    await forceTimestamps(User, { email }, createdAt, updatedAt);
    result.created++;
  }

  return result;
}
