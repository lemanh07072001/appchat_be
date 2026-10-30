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
  it('dispatches snapshot ISO/mapping/package despite changed service templates', async () => {
    order.config.country_policy = { source: 'manual', code: 'US', provider_value: 'mapped-us', package_id: '77' };
    await worker.processOrder(order._id);
    expect(provider.buy).toHaveBeenCalledWith(expect.objectContaining({ country_policy_configured: true, country_code: 'US', country_provider_value: 'mapped-us', id_service: '77' }));
  });
  it('does not resubmit an attempted purchase without a reconciled provider ID', async () => {
    order.config.gpnip_purchase_started = true;
    await worker.processOrder(order._id);
    expect(provider.buy).not.toHaveBeenCalled();
  });
  it('uses variant snapshot over live service, GPNIP template and country package', async () => {
    order.config.product_mapping = { product_id: 'fp1-week', provider_isp: 'FPT', selection: 'fpt_fp1', product_id_configured: true };
    order.config.country_policy = { source: 'manual', code: 'US', package_id: 'stale' };
    await worker.processOrder(order._id);
    expect(provider.buy).toHaveBeenCalledWith(expect.objectContaining({ id_service: 'fp1-week', isp: 'FPT', product_id_configured: true }));
  });
  it.each([0, 60])('dispatches validated rotation snapshot %s despite template changes', async rotate_interval => {
    order.config.rotate_interval = rotate_interval;
    worker.serviceModel.findById = () => ({ exec: async () => ({ body_api: '{"rotate_interval":999}' }) });
    await worker.processOrder(order._id);
    expect(provider.buy).toHaveBeenCalledWith(expect.objectContaining({ rotate_interval }));
  });
  it('HomeProxy rotating snapshot retains the special one-day provider duration', async () => {
    worker.partnerModel.findById = () => ({ exec: async () => ({ code: 'homeproxy', status: true, token_api: 'key' }) });
    order.order_type = 'rotating';
    order.config.product_mapping = { product_id: 'rotating-week', provider_isp: 'HOMEPROXY', product_id_configured: true };
    await worker.processOrder(order._id);
    expect(provider.buy).toHaveBeenCalledWith(expect.objectContaining({ id_service: 'rotating-week', isp: 'HOMEPROXY', duration_days: 1, proxy_type: 'rotating' }));
  });
  it.each([
    ['homeproxy', 'vnpt', 'ab734ade-8bc6-4a70-b783-d9b31d7df36c'],
    ['proxyvn', 'Viettel', 'Viettel'],
    ['twoproxy', 'Viettel_thuong_2', 'Viettel_thuong_2'],
  ])('keeps %s connector-derived package for configured none', async (code, isp, expectedId) => {
    worker.partnerModel.findById = () => ({ exec: async () => ({ code, status: true, token_api: 'test-key' }) });
    order.order_type = 'static';
    order.config = { isp, country_policy: { source: 'none', package_id: '' } };
    await worker.processOrder(order._id);
    expect(provider.buy).toHaveBeenCalledWith(expect.objectContaining({ id_service: expectedId, country_policy_configured: true }));
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
