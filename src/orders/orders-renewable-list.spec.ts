import { OrdersService } from './orders.service';
import { OrderStatusEnum } from '../enum/order.enum';
import { Types } from 'mongoose';

describe('Renewable orders list eligibility projections', () => {
  it('loads partner status and GPNIP order identity needed by renewal guards', async () => {
    const service: any = Object.create(OrdersService.prototype);
    const order = {
      _id: new Types.ObjectId(), status: OrderStatusEnum.ACTIVE,
      partner_id: { code: 'gpnip', token_api: 'test-only', status: true },
      service_id: { name: 'IPv4', allow_renew: true },
      provider_order_id: 'upstream-order', pricing_mode: 'duration',
      end_date: new Date(Date.now() + 86400000), quantity: 1, price_per_unit: 100,
    };
    const orders: any = {
      populate: jest.fn().mockReturnThis(), select: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(), exec: jest.fn().mockResolvedValue([order]),
    };
    const proxies: any = {
      select: jest.fn().mockReturnThis(), sort: jest.fn().mockReturnThis(), lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([{ _id: new Types.ObjectId(), order_id: order._id, provider_proxy_id: 'upstream-proxy' }]),
    };
    service.orderModel = { find: jest.fn(() => orders) };
    service.proxyModel = { find: jest.fn(() => proxies) };
    const result = await service.getRenewableOrders(new Types.ObjectId().toString());
    expect(orders.populate).toHaveBeenCalledWith('partner_id', expect.stringContaining('status'));
    expect(orders.select).toHaveBeenCalledWith(expect.stringContaining('provider_order_id'));
    expect(orders.select).toHaveBeenCalledWith(expect.stringContaining('pricing_mode'));
    expect(result.orders[0]).toMatchObject({ eligible: true, proxies: [{ eligible: true }] });
    expect(result.orders[0].renewal_mode).toBe('legacy');
    expect(JSON.stringify(result)).not.toContain('test-only');
    order.partner_id.status = false;
    expect((await service.getRenewableOrders(new Types.ObjectId().toString())).orders[0].eligible).toBe(false);
  });
  it('marks Connector orders for the dedicated whole-order route without enabling legacy bulk', async () => {
    const service: any = Object.create(OrdersService.prototype);
    const order = { _id: new Types.ObjectId(), connector_purchase: { accountId: 'test' },
      service_id: { name: 'Connector' }, quantity: 1 };
    const chain: any = { populate: jest.fn().mockReturnThis(), select: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(), lean: jest.fn().mockReturnThis(), exec: jest.fn().mockResolvedValue([order]) };
    const proxyChain = { ...chain, exec: jest.fn().mockResolvedValue([]) };
    service.orderModel = { find: () => chain };
    service.proxyModel = { find: () => proxyChain };
    expect((await service.getRenewableOrders(new Types.ObjectId().toString())).orders[0])
      .toMatchObject({ renewal_mode: 'connector', eligible: false });
  });
});
