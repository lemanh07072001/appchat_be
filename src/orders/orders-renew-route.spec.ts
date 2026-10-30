import { OrdersController } from './orders.controller';

/**
 * Một route `POST /api/orders/my/:id/renew` cho hai luồng gia hạn. Trước đây có hai handler
 * cùng đường dẫn nên handler Connector không bao giờ được gọi; test này giữ cho đường đi do
 * dữ liệu của đơn quyết định, không do thứ tự khai báo.
 */
describe('One renew route, two renewal paths', () => {
  const req = { user: { sub: 'u1' } } as never;

  function fixture(mode: 'connector' | 'legacy') {
    const ordersService = { renewByUser: jest.fn().mockResolvedValue({ success: true }) };
    const connectorRenewal = { mode: jest.fn().mockResolvedValue(mode),
      renew: jest.fn().mockResolvedValue({ state: 'renewed' }),
      options: jest.fn().mockResolvedValue({ mode: 'connector', enabled: true, options: [] }) };
    const sut = new OrdersController(ordersService as never, {} as never, {} as never, {} as never,
      connectorRenewal as never);
    return { sut, ordersService, connectorRenewal };
  }

  it('sends a connector order to connector renewal with its idempotency key', async () => {
    const f = fixture('connector');
    expect(await f.sut.renewMyOrder(req, 'o1', { duration_days: 7 }, 'key-1')).toMatchObject({ state: 'renewed' });
    expect(f.connectorRenewal.renew).toHaveBeenCalledWith({ userId: 'u1', orderId: 'o1', durationDays: 7, key: 'key-1' });
    expect(f.ordersService.renewByUser).not.toHaveBeenCalled();
  });

  it('leaves a legacy order on the old provider path', async () => {
    const f = fixture('legacy');
    await f.sut.renewMyOrder(req, 'o1', { duration_days: 30 });
    expect(f.ordersService.renewByUser).toHaveBeenCalledWith('u1', 'o1', 30);
    expect(f.connectorRenewal.renew).not.toHaveBeenCalled();
  });

  it('quotes connector orders and says nothing about legacy ones', async () => {
    const connector = fixture('connector');
    expect(await connector.sut.renewOptions(req, 'o1')).toMatchObject({ mode: 'connector' });
    const legacy = fixture('legacy');
    expect(await legacy.sut.renewOptions(req, 'o1')).toEqual({ mode: 'legacy' });
    expect(legacy.connectorRenewal.options).not.toHaveBeenCalled();
  });
});
