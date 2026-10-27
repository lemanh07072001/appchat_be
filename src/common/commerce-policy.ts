import { ForbiddenException } from '@nestjs/common';
import {
  DEPOSIT_DISABLED_MESSAGE,
  PURCHASE_DISABLED_MESSAGE,
  featureFlags,
} from './feature-flags';

// Enforce the same switches as the public endpoint and HTTP guards, including
// direct service calls and scheduled renewals. Deposits remain independent.
export function assertPurchaseEnabled(): void {
  if (!featureFlags.purchaseEnabled) {
    throw new ForbiddenException({
      statusCode: 403,
      error: 'Forbidden',
      code: 'PURCHASE_DISABLED',
      message: PURCHASE_DISABLED_MESSAGE,
    });
  }
}

export function assertDepositEnabled(): void {
  if (!featureFlags.depositEnabled) {
    throw new ForbiddenException({
      statusCode: 403,
      error: 'Forbidden',
      code: 'DEPOSIT_DISABLED',
      message: DEPOSIT_DISABLED_MESSAGE,
    });
  }
}
