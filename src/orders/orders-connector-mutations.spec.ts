import { OrdersService } from './orders.service';
import { OrderStatusEnum, PaymentStatusEnum } from '../enum/order.enum';

describe('Connector isolation from legacy order mutations', () => {
  const id = '507f1f77bcf86cd799439011';
  function fixture(connector = true) {
    const order = { _id: id, user_id: id, connector_purchase: connector ? { accountId: id } : null,
      save: jest.fn(), status: OrderStatusEnum.ACTIVE };
    const query: any = { exec: jest.fn().mockResolvedValue(order) };
    query.populate = jest.fn().mockReturnValue(query);
    const model = { findById: jest.fn().mockReturnValue(query), findOneAndDelete: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(null) }) };
    const service: any = Object.create(OrdersService.prototype);
    Object.assign(service, { orderModel: model, partnerModel: { findById: jest.fn() },
      userModel: { findByIdAndUpdate: jest.fn() }, proxyModel: { find: jest.fn(), insertMany: jest.fn() },
      providerFactory: { getProvider: jest.fn() } });
    return { service, order, model };
  }
  it.each([
    ['updateStatus', [id, OrderStatusEnum.FAILED]],
    ['updatePaymentStatus', [id, PaymentStatusEnum.REFUNDED]],
    ['approveRefund', [id]], ['adminRefund', [id]], ['refundMissingQuantity', [id]],
    ['retryOrder', [id]], ['importProxies', [id, ['host:80:user:pass']]],
    ['syncProviderOrder', [id, 'provider-id']], ['refetchProxies', [id, [id]]],
    ['resolveOwnedProviderOrder', [id, id]],
  ])('rejects %s before saving, crediting wallets or calling legacy adapters', async (method, args) => {
    const f = fixture();
    await expect(f.service[method](...(args as unknown[]))).rejects.toThrow('Đơn Connector');
    expect(f.order.save).not.toHaveBeenCalled();
    expect(f.service.userModel.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(f.service.partnerModel.findById).not.toHaveBeenCalled();
    expect(f.service.providerFactory.getProvider).not.toHaveBeenCalled();
    expect(f.service.proxyModel.find).not.toHaveBeenCalled();
  });
  it('blocks renewal regardless of current service or partner settings', () => {
    const f = fixture();
    expect(f.service.checkOrderRenewable(f.order)).toContain('Connector');
    expect(() => f.service.assertLegacyOrderMutation({ connector_purchase: null })).not.toThrow();
  });
  it('preserves Connector orders and durable checkout receipts during legacy deletion', async () => {
    const f = fixture();
    await expect(f.service.delete(id)).rejects.toThrow('Order not found');
    expect(f.model.findOneAndDelete).toHaveBeenCalledWith({ _id: id, voucher_snapshot: null, connector_purchase: null });
  });
});
