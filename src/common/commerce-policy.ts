import { ForbiddenException } from '@nestjs/common';

// Set to false only when deposits, purchases and renewals may resume.
export const COMMERCE_DISABLED = true;
export const COMMERCE_DISABLED_MESSAGE =
  'Hệ thống hiện tạm ngừng nạp tiền, mua proxy và gia hạn. Vui lòng không chuyển khoản và liên hệ hỗ trợ nếu cần.';

export function assertCommerceEnabled(): void {
  if (COMMERCE_DISABLED) {
    throw new ForbiddenException(COMMERCE_DISABLED_MESSAGE);
  }
}
