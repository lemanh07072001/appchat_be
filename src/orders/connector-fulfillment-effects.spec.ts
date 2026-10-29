import { ConnectorFulfillmentEffects } from './connector-fulfillment-effects.service';
import { OrderStatusEnum } from '../enum/order.enum';

describe('Recoverable Connector fulfillment effects', () => {
  const id = '507f1f77bcf86cd799439011';
  function fixture() {
    const order = { quantity: 2, actual_quantity: 2, refunded_amount: 0 };
    const orders = { findOne: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(order) }),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }) };
    const affiliate = { handleOrderActive: jest.fn() };
    return { order, orders, affiliate, service: new ConnectorFulfillmentEffects(orders as any, affiliate as any) };
  }
  it('processes full delivery before clearing the durable marker', async () => {
    const f = fixture();
    expect(await f.service.reconcile(id)).toBe(true);
    expect(f.orders.findOne).toHaveBeenCalledWith(expect.objectContaining({ status: OrderStatusEnum.ACTIVE,
      connector_purchase_state: 'delivered', connector_affiliate_pending: true }));
    expect(f.affiliate.handleOrderActive).toHaveBeenCalledWith(f.order, true);
    expect(f.orders.updateOne).toHaveBeenCalledWith(expect.objectContaining({ actual_quantity: 2, quantity: 2, refunded_amount: 0 }),
      { $set: { connector_affiliate_pending: false } });
  });
  it('leaves the marker for retry on commission persistence failure', async () => {
    const f = fixture(); f.affiliate.handleOrderActive.mockRejectedValue(new Error('commission outage'));
    await expect(f.service.reconcile(id)).rejects.toThrow('commission outage');
    expect(f.orders.updateOne).not.toHaveBeenCalled();
  });
  it.each(['shortage', 'refund', 'empty', 'resolved'])('does not create commissions for %s', async reason => {
    const f = fixture();
    if (reason === 'shortage') f.order.actual_quantity = 1;
    if (reason === 'refund') f.order.refunded_amount = 1;
    if (reason === 'empty') f.order.quantity = f.order.actual_quantity = 0;
    if (reason === 'resolved') f.orders.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });
    expect(await f.service.reconcile(id)).toBe(false);
    expect(f.affiliate.handleOrderActive).not.toHaveBeenCalled();
    expect(f.orders.updateOne).not.toHaveBeenCalled();
  });
});
