import { OrdersProcessingWorkerService } from './orders-processing.worker.service';
import { OrdersExpirationScheduler } from './orders-expiration.scheduler';
import { OrderStatusEnum } from '../enum/order.enum';

describe('Connector recovery isolation', () => {
  it.each([false, true])('routes recovery and delivery without using legacy refund handling (failure=%s)', async fail => {
    const query = { select: jest.fn().mockReturnThis(), populate: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue({ connector_purchase: {}, status: OrderStatusEnum.PROCESSING }) };
    const orders = { findById: jest.fn().mockReturnValue(query), findOneAndUpdate: jest.fn() };
    const factory = { getProvider: jest.fn() };
    const events: string[] = [];
    const purchase = { recover: jest.fn(async () => { events.push('recover'); if (fail) throw new Error('private'); }) };
    const delivery = { poll: jest.fn(async () => { events.push('poll'); }) };
    const worker = new OrdersProcessingWorkerService(orders as any, {} as any, {} as any, {} as any,
      {} as any, {} as any, factory as any, {} as any, {} as any, {} as any, {} as any, delivery as any, purchase as any);
    await (worker as any).pollUntilActive('507f1f77bcf86cd799439011');
    expect(events).toEqual(fail ? ['recover'] : ['recover', 'poll']);
    expect(factory.getProvider).not.toHaveBeenCalled();
    expect(orders.findOneAndUpdate).not.toHaveBeenCalled();
  });
  it('excludes unresolved Connector purchases from expiration selection and updates', async () => {
    const orders = { find: jest.fn().mockReturnValue({ select: jest.fn().mockReturnThis(), lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([{ _id: 'id', order_code: 'test' }]) }),
      updateMany: jest.fn().mockReturnValue({ exec: jest.fn() }) };
    const proxies = { updateMany: jest.fn().mockReturnValue({ exec: jest.fn() }) };
    const scheduler = new OrdersExpirationScheduler(orders as any, proxies as any,
      { handleOrderExpired: jest.fn() } as any, { info: jest.fn() } as any);
    await scheduler.checkExpiredOrders();
    const eligibility = [{ $or: [{ connector_purchase: null }, { connector_purchase_state: 'delivered', connector_affiliate_pending: { $ne: true } }] }];
    expect(orders.find.mock.calls[0][0].$and).toEqual(eligibility);
    expect(orders.updateMany.mock.calls[0][0].$and).toEqual(eligibility);
  });
});
