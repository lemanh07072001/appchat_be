import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { assertDepositEnabled, assertPurchaseEnabled } from './commerce-policy';
import { AppController } from '../app.controller';
import { AppService } from '../app.service';
import {
  DepositEnabledGuard,
  PurchaseEnabledGuard,
} from '../guards/feature.guard';
import { OrdersService } from '../orders/orders.service';
import { RenewScheduler } from '../renew/renew.scheduler';
import { UsersService } from '../users/users.service';
import { WebhookService } from '../webhook/webhook.service';
import { DepositPromotionsService } from '../deposit-promotions/deposit-promotions.service';
import { DepositCreditService } from '../deposit-promotions/deposit-credit.service';

describe('Independent commerce switches', () => {
  const originalPurchase = process.env.PURCHASE_ENABLED;
  const originalDeposit = process.env.DEPOSIT_ENABLED;

  beforeEach(() => {
    process.env.PURCHASE_ENABLED = 'true';
    process.env.DEPOSIT_ENABLED = 'false';
  });

  afterEach(() => {
    if (originalPurchase === undefined) delete process.env.PURCHASE_ENABLED;
    else process.env.PURCHASE_ENABLED = originalPurchase;
    if (originalDeposit === undefined) delete process.env.DEPOSIT_ENABLED;
    else process.env.DEPOSIT_ENABLED = originalDeposit;
  });

  it('allows purchases but not deposits consistently across policies, guards and public flags', () => {
    expect(assertPurchaseEnabled).not.toThrow();
    expect(new PurchaseEnabledGuard().canActivate()).toBe(true);
    expect(assertDepositEnabled).toThrow(ForbiddenException);
    expect(() => new DepositEnabledGuard().canActivate()).toThrow(
      ForbiddenException,
    );
    expect(new AppController(new AppService()).getFeatures()).toEqual({
      purchase_enabled: true,
      deposit_enabled: false,
    });
  });

  it.each([
    'buy',
    'buySync',
    'create',
    'renewByUser',
    'renewByAdmin',
    'bulkRenewByUser',
    'topUpBandwidth',
  ])(
    'blocks OrdersService.%s before side effects when purchases are disabled',
    async (method) => {
      process.env.PURCHASE_ENABLED = 'false';
      const instance = Object.create(OrdersService.prototype);
      await expect(instance[method]()).rejects.toMatchObject({
        response: { statusCode: 403, code: 'PURCHASE_DISABLED' },
      });
    },
  );

  it.each([
    [UsersService, 'deposit'],
    [WebhookService, 'handlePays2'],
    [WebhookService, 'handleBinancePay'],
    [WebhookService, 'approveTransaction'],
    [DepositPromotionsService, 'createIntent'],
    [DepositCreditService, 'credit'],
  ] as const)(
    'blocks %p.%s before deposit side effects while purchases are enabled',
    async (service, method) => {
      const instance = Object.create(service.prototype);
      await expect(instance[method]()).rejects.toMatchObject({
        response: { statusCode: 403, code: 'DEPOSIT_DISABLED' },
      });
    },
  );

  it.each(['renewByUser', 'renewByAdmin', 'bulkRenewByUser'])(
    'allows %s to reach normal validation without touching data',
    async (method) => {
      const instance = Object.create(OrdersService.prototype);
      await expect(instance[method]()).rejects.toBeInstanceOf(
        BadRequestException,
      );
    },
  );

  it.each(['buy', 'buySync'])(
    'allows %s to reach service validation without a purchase',
    async (method) => {
      const instance = Object.create(OrdersService.prototype);
      const exec = jest.fn().mockResolvedValue(null);
      instance.serviceModel = { findById: jest.fn().mockReturnValue({ exec }) };
      await expect(
        instance[method]('test-user', { service_id: 'unavailable' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(exec).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps deposits independent of the purchase switch', () => {
    process.env.PURCHASE_ENABLED = 'false';
    process.env.DEPOSIT_ENABLED = 'true';
    expect(assertDepositEnabled).not.toThrow();
    expect(new DepositEnabledGuard().canActivate()).toBe(true);
    expect(assertPurchaseEnabled).toThrow(ForbiddenException);
  });

  it.each(['false', '0', 'off', 'no', ' FALSE '])(
    'honors disabled value %s consistently',
    (value) => {
      process.env.PURCHASE_ENABLED = value;
      expect(assertPurchaseEnabled).toThrow(ForbiddenException);
      expect(() => new PurchaseEnabledGuard().canActivate()).toThrow(
        ForbiddenException,
      );
      expect(
        new AppController(new AppService()).getFeatures().purchase_enabled,
      ).toBe(false);
    },
  );

  it('defaults to enabled when neither switch is configured', () => {
    delete process.env.PURCHASE_ENABLED;
    delete process.env.DEPOSIT_ENABLED;
    expect(assertPurchaseEnabled).not.toThrow();
    expect(assertDepositEnabled).not.toThrow();
  });

  it('respects the purchase switch for automatic renewals without renewing anything', async () => {
    const scheduler = Object.create(RenewScheduler.prototype);
    scheduler.redis = { set: jest.fn().mockResolvedValue(null) };
    scheduler.logger = { log: jest.fn(), debug: jest.fn() };
    process.env.PURCHASE_ENABLED = 'false';
    await scheduler.scanAndRenew();
    expect(scheduler.redis.set).not.toHaveBeenCalled();
    process.env.PURCHASE_ENABLED = 'true';
    await scheduler.scanAndRenew();
    // Another instance holds the lock: never execute a renewal during tests.
    expect(scheduler.redis.set).toHaveBeenCalledTimes(1);
  });
});
