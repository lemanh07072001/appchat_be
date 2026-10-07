import { CanActivate, ForbiddenException, Injectable } from '@nestjs/common';
import {
  DEPOSIT_DISABLED_MESSAGE,
  PURCHASE_DISABLED_MESSAGE,
  featureFlags,
} from '../common/feature-flags';

// Trả 403 chứ không phải 503: client gọi qua API token thường tự retry khi gặp
// 5xx, mà đây là quyết định tắt có chủ ý chứ không phải lỗi tạm thời.

@Injectable()
export class PurchaseEnabledGuard implements CanActivate {
  canActivate(): boolean {
    if (!featureFlags.purchaseEnabled) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'PURCHASE_DISABLED',
        message: PURCHASE_DISABLED_MESSAGE,
      });
    }
    return true;
  }
}

@Injectable()
export class DepositEnabledGuard implements CanActivate {
  canActivate(): boolean {
    if (!featureFlags.depositEnabled) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'DEPOSIT_DISABLED',
        message: DEPOSIT_DISABLED_MESSAGE,
      });
    }
    return true;
  }
}
