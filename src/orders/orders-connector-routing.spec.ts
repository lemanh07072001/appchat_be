import { OrdersWorkerService } from './orders.worker.service';

describe('Connector worker isolation', () => {
  function fixture(fail = false) {
    const order = { connector_purchase: { accountId: 'account' } };
    const orders = { findOne: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(order) }), findOneAndUpdate: jest.fn() };
    const redis = { set: jest.fn().mockResolvedValue('OK'), del: jest.fn(), lpush: jest.fn() };
    const factory = { getProvider: jest.fn() };
    const logs = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const purchase = { purchase: fail ? jest.fn().mockRejectedValue(new Error('ambiguous')) : jest.fn().mockResolvedValue({}) };
    const worker = new OrdersWorkerService(orders as any, {} as any, {} as any, {} as any,
      redis as any, redis as any, factory as any, {} as any, logs as any, {} as any, {} as any, purchase as any);
    return { worker, orders, factory, purchase, redis };
  }
  it.each([false, true])('never falls through to legacy or refund paths (failure=%s)', async fail => {
    const f = fixture(fail);
    const id = '507f1f77bcf86cd799439011';
    await (f.worker as any).processOrder(id);
    expect(f.purchase.purchase).toHaveBeenCalledWith(id);
    expect(f.factory.getProvider).not.toHaveBeenCalled();
    expect(f.orders.findOneAndUpdate).not.toHaveBeenCalled();
    expect(f.redis.del).toHaveBeenCalledWith(`lock:order:${id}`);
  });
});
