import { Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import { OrdersService } from './orders.service';
import { OrderStatusEnum } from '../enum/order.enum';
import { ProxysellerProvider } from '../proxy-providers/impl/proxyseller.provider';

const query = (value: any) => ({ exec: jest.fn().mockResolvedValue(value) });

describe('Immediate local renewal after provider acceptance', () => {
  let svc: any;
  let order: any;
  let provider: ProxysellerProvider;
  let request: jest.SpyInstance;
  const userId = '000000000000000000000001';
  const proxies = [{ provider_proxy_id: 'alpha-A' }, { provider_proxy_id: '000B' }];
  const submit = (selected = proxies) => svc.renewOrderProxies({ order, proxies: selected,
    duration_days: 30, userId, chargeQuantity: selected.length });
  const purchaseEnabled = process.env.PURCHASE_ENABLED;

  beforeEach(() => {
    process.env.PURCHASE_ENABLED = 'true';
    order = { _id: new Types.ObjectId(), order_code: 'TEST', status: OrderStatusEnum.ACTIVE,
      end_date: new Date('2026-11-30T12:00:00Z'), duration_days: 30, renew_count: 0, quantity: 2,
      price_per_unit: 10, provider_order_id: 'original-Ab', provider_metadata: { proxyseller_type: 'ipv4' },
      partner_id: { code: 'proxyseller', token_api: 'test', status: true }, service_id: { name: 'Test' },
      save: jest.fn().mockResolvedValue(undefined) };
    provider = new ProxysellerProvider();
    request = jest.spyOn(provider as any, 'request').mockImplementation(async (method) => method === 'GET'
      ? { status: 'success', data: { items: { period: [{ id: 'actual-30', days: 30 }] } } }
      : { status: 'success', data: { orderId: 'renew-X' } });
    svc = Object.create(OrdersService.prototype);
    svc.logger = new Logger('RenewalTest');
    svc.providerFactory = { getProvider: jest.fn(() => provider) };
    svc.userModel = { findOneAndUpdate: jest.fn(() => query({ money: 10000 })),
      findByIdAndUpdate: jest.fn(() => query({ money: 10600 })) };
    svc.proxyModel = { updateMany: jest.fn(() => query({ modifiedCount: 2 })) };
    svc.walletTxService = { log: jest.fn() };
    svc.orderLogService = { info: jest.fn(), error: jest.fn() };
    svc.notification = { sendRenewFailed: jest.fn() };
    const chain: any = { populate: () => chain, exec: async () => order };
    svc.orderModel = { findById: jest.fn(() => chain) };
    const proxyChain: any = { select: () => proxyChain, lean: () => proxyChain, exec: async () => proxies };
    svc.proxyModel.find = jest.fn(() => proxyChain);
  });
  afterEach(() => {
    if (purchaseEnabled === undefined) delete process.env.PURCHASE_ENABLED;
    else process.env.PURCHASE_ENABLED = purchaseEnabled;
  });

  it('calls ProxySeller and immediately adds local days/counts when response only contains orderId', async () => {
    const result = await submit();
    expect(result).toMatchObject({ status: 'renewed', success: 2, fail: 0, price: 600,
      new_end_date: new Date('2026-12-30T12:00:00Z') });
    expect(request).toHaveBeenCalledTimes(2); // reference read, then one paid make
    expect(request).toHaveBeenCalledWith('POST', '/test/prolong/make/ipv4', {
      ids: ['alpha-A', '000B'], periodId: 'actual-30', paymentId: 'balance', coupon: '',
    }, undefined, 'v2');
    expect(order).toMatchObject({ duration_days: 60, renew_count: 1, is_renewed: true, last_renewed_by: 'user' });
    expect(order.last_renewed_at).toBeInstanceOf(Date);
    expect(order.save).toHaveBeenCalledTimes(1);
    expect(svc.proxyModel.updateMany).toHaveBeenCalledWith(
      { order_id: order._id, provider_proxy_id: { $in: ['alpha-A', '000B'] } },
      { $set: { last_renewed_at: expect.any(Date) }, $inc: { renew_count: 1 } });
    expect(svc.userModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(svc.walletTxService.log).toHaveBeenCalledTimes(1);
  });
  it('admin immediately extends local expiry without charging the user', async () => {
    const result = await svc.renewByAdmin(order._id.toString(), 30);
    expect(result).toMatchObject({ successCount: 2, failCount: 0, new_end_date: new Date('2026-12-30T12:00:00Z') });
    expect(order).toMatchObject({ duration_days: 60, renew_count: 1, last_renewed_by: 'admin' });
    expect(order.save).toHaveBeenCalledTimes(1);
    expect(svc.userModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(2);
  });
  it.each(['ipv6', 'mix', 'mix_isp'])('rejects %s subset before charge or provider call', async type => {
    order.provider_metadata.proxyseller_type = type;
    await expect(submit([proxies[0]])).rejects.toThrow('chỉ hỗ trợ gia hạn toàn bộ đơn');
    expect(svc.userModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(order.save).not.toHaveBeenCalled();
  });
  it.each(['ipv6', 'mix', 'mix_isp'])('allows full %s order renewal and charges full quantity', async type => {
    order.provider_metadata.proxyseller_type = type;
    expect(await submit()).toMatchObject({ status: 'renewed', price: 600 });
    expect(request).toHaveBeenCalledWith('POST', `/test/prolong/make/${type}`, expect.objectContaining({ orderIds: ['original-Ab'] }), undefined, 'v2');
  });
  it('rejects an old-format order-based subset too', async () => {
    order.provider_metadata = {};
    order.provider_order_id = 'mix:original-Ab';
    await expect(submit([proxies[0]])).rejects.toThrow('chỉ hỗ trợ gia hạn toàn bộ đơn');
    expect(svc.userModel.findOneAndUpdate).not.toHaveBeenCalled();
  });
  it('validates invalid durations before spending', async () => {
    await expect(svc.renewOrderProxies({ order, proxies, duration_days: 1.5, userId, chargeQuantity: 2 })).rejects.toThrow('positive integer');
    expect(svc.userModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
  it.each(['rejection', 'timeout'])('keeps original refund handling for provider %s', async failure => {
    request.mockResolvedValueOnce({ status: 'success', data: { items: { period: [{ id: 'actual-30', days: 30 }] } } });
    if (failure === 'timeout') request.mockRejectedValueOnce(new Error('timeout'));
    else request.mockResolvedValueOnce({ status: 'error', errors: [{ message: 'rejected' }] });
    expect(await submit()).toMatchObject({ status: 'failed', refunded: true });
    expect(svc.userModel.findByIdAndUpdate).toHaveBeenCalledWith(userId, { $inc: { money: 600 } }, { new: true });
    expect(order.end_date).toEqual(new Date('2026-11-30T12:00:00Z'));
    expect(order.renew_count).toBe(0);
    expect(order.save).not.toHaveBeenCalled();
    expect(svc.proxyModel.updateMany).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(2);
  });
  it.each(['error', 'no match', 'ambiguous', 'timeout'])('refunds the full deduction on reference %s without make', async failure => {
    if (failure === 'timeout') request.mockRejectedValueOnce(new Error('reference timeout'));
    else request.mockResolvedValueOnce(failure === 'error'
      ? { status: 'error', errors: [{ message: 'reference unavailable' }] }
      : { status: 'success', data: { items: { period: failure === 'no match' ? [] : [{ id: 'a', days: 30 }, { id: 'b', days: 30 }] } } });
    expect(await submit()).toMatchObject({ status: 'failed', refunded: true });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe('GET');
    expect(svc.userModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.anything(), { $inc: { money: -600 } }, { new: true });
    expect(svc.userModel.findByIdAndUpdate).toHaveBeenCalledWith(userId, { $inc: { money: 600 } }, { new: true });
    expect(order.save).not.toHaveBeenCalled();
    expect(order.end_date).toEqual(new Date('2026-11-30T12:00:00Z'));
    expect(svc.proxyModel.updateMany).not.toHaveBeenCalled();
  });
  it('admin reference failure does not extend or charge', async () => {
    request.mockResolvedValueOnce({ status: 'success', data: { items: { period: [] } } });
    await expect(svc.renewByAdmin(order._id.toString(), 30)).rejects.toThrow('no matching period');
    expect(request).toHaveBeenCalledTimes(1);
    expect(order.save).not.toHaveBeenCalled();
    expect(svc.userModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(svc.proxyModel.updateMany).not.toHaveBeenCalled();
  });
  it.each(['homeproxy', '2proxy', 'omoproxy', 'proxyvn', 'gpnip', 'proxyv6'])('preserves synchronous %s renewal behavior', async code => {
    order.partner_id.code = code;
    const renew = jest.fn().mockResolvedValue({ success: true });
    const validateRenew = jest.fn(() => { throw new Error('must not run'); });
    svc.providerFactory.getProvider.mockReturnValue({ renew, validateRenew });
    expect(await submit()).toMatchObject({ status: 'renewed', new_end_date: new Date('2026-12-30T12:00:00Z') });
    expect(order).toMatchObject({ renew_count: 1, duration_days: 60 });
    expect(validateRenew).not.toHaveBeenCalled();
    expect(renew).toHaveBeenCalledTimes(1);
    expect(svc.userModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });
});
