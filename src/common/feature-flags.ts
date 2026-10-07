/**
 * Công tắc tính năng đọc từ .env. Đọc lazily lúc truy cập (cùng lý do với
 * guards/constants.ts: .env được ConfigModule nạp sau khi module này import).
 *
 * Mặc định BẬT — chỉ tắt khi biến được set rõ ràng là false/0/off/no. Thiếu biến
 * hoặc gõ sai giá trị thì site vẫn chạy như cũ thay vì âm thầm khoá bán hàng.
 */
const OFF_VALUES = ['false', '0', 'off', 'no'];

function enabled(name: string): boolean {
  const value = (process.env[name] ?? '').trim().toLowerCase();
  return !OFF_VALUES.includes(value);
}

export const DEPOSIT_DISABLED_MESSAGE = 'Chức năng nạp tiền đang tạm tắt';
export const PURCHASE_DISABLED_MESSAGE = 'Chức năng mua và gia hạn proxy đang tạm tắt';

export const featureFlags = {
  /** DEPOSIT_ENABLED — nạp tiền (webhook tự cộng ví, admin nạp tay). */
  get depositEnabled(): boolean {
    return enabled('DEPOSIT_ENABLED');
  },

  /** PURCHASE_ENABLED — mua mới, gia hạn, nạp thêm băng thông, tự gia hạn. */
  get purchaseEnabled(): boolean {
    return enabled('PURCHASE_ENABLED');
  },
};
