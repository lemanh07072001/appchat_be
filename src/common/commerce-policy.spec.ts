import { ForbiddenException } from '@nestjs/common';
import { assertCommerceEnabled, COMMERCE_DISABLED } from './commerce-policy';
import { OrdersService } from '../orders/orders.service';
import { UsersService } from '../users/users.service';
import { WebhookService } from '../webhook/webhook.service';

describe('Commerce shutdown', () => {
  it('is enabled and returns HTTP 403', () => {
    expect(COMMERCE_DISABLED).toBe(true);
    expect(assertCommerceEnabled).toThrow(ForbiddenException);
  });

  // No dependencies: rejection must happen before DB, Redis or provider access.
  it.each([
    [OrdersService, 'buy'],
    [OrdersService, 'buySync'],
    [OrdersService, 'create'],
    [OrdersService, 'renewByUser'],
    [OrdersService, 'renewByAdmin'],
    [OrdersService, 'bulkRenewByUser'],
    [OrdersService, 'topUpBandwidth'],
    [UsersService, 'deposit'],
    [WebhookService, 'handlePays2'],
    [WebhookService, 'handleBinancePay'],
    [WebhookService, 'approveTransaction'],
  ])('blocks %p.%s before any side effects', async (service, method) => {
    const instance = Object.create(service.prototype);
    await expect(instance[method]()).rejects.toBeInstanceOf(ForbiddenException);
  });
});
