import { OrdersWorkerService } from './orders.worker.service';
import { OrderStatusEnum } from '../enum/order.enum';

describe('GPNIP worker purchase safety', () => {
  let worker: any;
  let order: any;
  let provider: any;
  beforeEach(() => {
    order = {
      _id: '000000000000000000000009',
      status: OrderStatusEnum.PENDING,
      partner_id: 'p',
      service_id: 's',
      user_id: 'u',
      quantity: 1,
      duration_days: 30,
      pricing_mode: 'bandwidth',
      bandwidth_gb: 12,
      config: { gpnip_body_api: '{"packageId":42}', gpnip_id_service: '42' },
      save: jest.fn().mockResolvedValue(undefined),
      markModified: jest.fn(),
    };
    provider = {
      retryBuy: false,
      buy: jest.fn().mockResolvedValue({ provider_order_id: '9', proxies: [] }),
    };
    worker = Object.create(OrdersWorkerService.prototype);
    worker.orderModel = {
      findOne: () => ({ exec: async () => order }),
      findById: () => ({ populate: () => ({ exec: async () => null }) }),
      findByIdAndUpdate: jest.fn(() => ({ exec: async () => null })),
      findOneAndUpdate: jest.fn(() => ({ exec: async () => null })),
    };
    worker.partnerModel = {
      findById: () => ({
        exec: async () => ({
          code: 'gpnip',
          status: true,
          token_api: 'test-only-key',
        }),
      }),
    };
    worker.serviceModel = {
      findById: () => ({
        exec: async () => ({
          id_service: 'changed',
          body_api: '{"packageId":99}',
        }),
      }),
    };
    worker.providerFactory = { getProvider: () => provider };
    worker.redis = {
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn(),
      lpush: jest.fn(),
      incr: jest.fn().mockResolvedValue(1),
      expire: jest.fn(),
    };
    worker.orderLogService = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    worker.logger = {
      log: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    worker.sleep = jest.fn();
  });
  it('passes billed GB and immutable package settings, persists ID before polling', async () => {
    await worker.processOrder(order._id);
    expect(provider.buy).toHaveBeenCalledWith(
      expect.objectContaining({
        bandwidth_gb: 12,
        pricing_mode: 'bandwidth',
        body_api: '{"packageId":42}',
        id_service: '42',
      }),
    );
    expect(order.config.gpnip_purchase_started).toBe(true);
    expect(order.provider_order_id).toBe('9');
    expect(order.status).toBe(OrderStatusEnum.PROCESSING);
    expect(order.save.mock.invocationCallOrder[0]).toBeLessThan(
      provider.buy.mock.invocationCallOrder[0],
    );
    expect(order.save.mock.invocationCallOrder[1]).toBeLessThan(
      worker.redis.lpush.mock.invocationCallOrder[0],
    );
  });
  it('never retries an ambiguous non-idempotent create call', async () => {
    provider.buy.mockRejectedValue(new Error('Network timeout'));
    await worker.processOrder(order._id);
    expect(provider.buy).toHaveBeenCalledTimes(1);
    expect(worker.sleep).not.toHaveBeenCalled();
    expect(worker.orderModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: order._id }),
      expect.objectContaining({ status: OrderStatusEnum.PENDING_REFUND }),
    );
  });
  it('does not resubmit an attempted purchase without a reconciled provider ID', async () => {
    order.config.gpnip_purchase_started = true;
    await worker.processOrder(order._id);
    expect(provider.buy).not.toHaveBeenCalled();
  });
  it('resumes polling an existing provider ID without buying again', async () => {
    order.config.gpnip_purchase_started = true;
    order.provider_order_id = '9';
    await worker.processOrder(order._id);
    expect(provider.buy).not.toHaveBeenCalled();
    expect(order.status).toBe(OrderStatusEnum.PROCESSING);
    expect(worker.redis.lpush).toHaveBeenCalled();
  });
});
