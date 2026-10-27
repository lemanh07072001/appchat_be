import { BadRequestException } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrderStatusEnum } from '../enum/order.enum';
import { OrderLogStep } from '../schemas/order-log.schema';

/**
 * Ba thao tác tự phục vụ trên đơn: đọc danh mục địa lý, đổi mật khẩu proxy,
 * đặt whitelist IP. Không cái nào tiêu tiền, nhưng cái thứ hai ghi lại
 * credential — sai thứ tự hoặc sai giá trị là khách mất quyền truy cập proxy
 * họ đã trả tiền.
 */
describe('Order self-service actions', () => {
  const USER = '000000000000000000000001';
  const OTHER = '000000000000000000000002';
  const ORDER_ID = '0000000000000000000000aa';

  let svc: any;
  let order: any;
  let partner: any;
  let provider: any;
  let service: any;

  beforeEach(() => {
    partner = {
      status: true,
      code: 'gpnip',
      token_api: 'test-only-key',
      name: 'GPNIP',
    };
    order = {
      _id: ORDER_ID,
      user_id: USER,
      partner_id: partner,
      provider_order_id: '9',
      status: OrderStatusEnum.ACTIVE,
      end_date: new Date(Date.now() + 86_400_000),
      credentials: {
        host: '192.0.2.1',
        port: 8080,
        username: 'u',
        password: 'old',
      },
      provider_metadata: {},
    };
    service = { id_service: 'pkg-1' };
    provider = {
      // Adapter chuẩn hoá sẵn mã ISO; orders.service không đọc hình dạng riêng
      // của từng nhà cung cấp.
      fetchOrderGeo: jest.fn().mockResolvedValue({
        iso_codes: ['VN'],
        raw: [{ name: 'Vietnam', iso_code: 'VN' }],
      }),
      listCountriesForPackage: jest.fn().mockResolvedValue({
        package_id: 'pkg-1',
        product: 'ipv6-datacenter',
        iso_codes: ['US'],
        capabilities: { country: true },
      }),
      changeProxyPassword: jest
        .fn()
        .mockResolvedValue({ password: 'Applied123' }),
      setAllowedIps: jest
        .fn()
        .mockResolvedValue({ allowed_ips: ['192.0.2.7'] }),
    };

    svc = Object.create(OrdersService.prototype);
    svc.logger = { error: jest.fn(), log: jest.fn(), warn: jest.fn() };
    svc.orderModel = {
      findById: jest.fn(() => ({
        populate: jest.fn(() => ({ exec: async () => order })),
      })),
      updateOne: jest.fn(() => ({ exec: async () => ({ modifiedCount: 1 }) })),
    };
    svc.proxyModel = {
      updateMany: jest.fn(() => ({ exec: async () => ({ modifiedCount: 3 }) })),
    };
    svc.serviceModel = {
      findById: jest.fn(() => ({
        select: jest.fn(() => ({
          lean: jest.fn(() => ({ exec: async () => service })),
        })),
      })),
    };
    svc.providerFactory = { getProvider: jest.fn(() => provider) };
    svc.orderLogService = { info: jest.fn().mockResolvedValue(undefined) };
  });

  const changePassword = (user = USER) =>
    svc.changeProxyPassword(user, ORDER_ID, 'Chosen1234');
  const setIps = (user = USER) =>
    svc.setAllowedIps(user, ORDER_ID, ['192.0.2.7']);
  const geo = (user = USER) => svc.fetchOrderGeo(user, ORDER_ID);

  const providerUntouched = () => {
    expect(provider.changeProxyPassword).not.toHaveBeenCalled();
    expect(provider.setAllowedIps).not.toHaveBeenCalled();
    expect(provider.fetchOrderGeo).not.toHaveBeenCalled();
    expect(provider.listCountriesForPackage).not.toHaveBeenCalled();
  };

  // ─── Cùng một bộ điều kiện cho cả ba ──────────────────────────────────────

  it.each([
    ['password', () => changePassword(OTHER)],
    ['allowed-ips', () => setIps(OTHER)],
    ['geo', () => geo(OTHER)],
  ])('refuses %s on an order owned by someone else', async (_name, call) => {
    await expect(call()).rejects.toBeInstanceOf(BadRequestException);
    providerUntouched();
  });

  it.each([
    ['password', () => changePassword()],
    ['allowed-ips', () => setIps()],
    ['geo', () => geo()],
  ])('refuses %s while the partner is disabled', async (_name, call) => {
    partner.status = false;
    await expect(call()).rejects.toBeInstanceOf(BadRequestException);
    providerUntouched();
  });

  // Đơn chưa cấp xong thì chưa có mã bên NCC — gọi API với chuỗi rỗng là hỏi
  // về một đơn không tồn tại.
  it.each([
    ['password', () => changePassword()],
    ['allowed-ips', () => setIps()],
    ['geo', () => geo()],
  ])('refuses %s before the provider order id exists', async (_name, call) => {
    order.provider_order_id = '';
    await expect(call()).rejects.toBeInstanceOf(BadRequestException);
    providerUntouched();
  });

  it.each([
    ['password', () => changePassword()],
    ['allowed-ips', () => setIps()],
    ['geo', () => geo()],
  ])('refuses %s when the adapter has no such method', async (_name, call) => {
    provider = {};
    await expect(call()).rejects.toBeInstanceOf(BadRequestException);
  });

  // Thông báo cho user không được nêu tên NCC.
  it('does not leak the provider name to the customer', async () => {
    provider = {};
    await expect(changePassword()).rejects.toThrow(/^(?!.*gpnip).*$/i);
  });

  // ─── Mật khẩu ─────────────────────────────────────────────────────────────

  it('refuses a password change on an order that already expired', async () => {
    order.end_date = new Date(Date.now() - 1000);
    await expect(changePassword()).rejects.toBeInstanceOf(BadRequestException);
    expect(provider.changeProxyPassword).not.toHaveBeenCalled();
  });

  it('allows a password change on a depleted order the customer can still top up', async () => {
    order.status = OrderStatusEnum.DEPLETED;
    await expect(changePassword()).resolves.toMatchObject({ success: true });
  });

  it('refuses a password change on a failed order', async () => {
    order.status = OrderStatusEnum.FAILED;
    await expect(changePassword()).rejects.toBeInstanceOf(BadRequestException);
    expect(provider.changeProxyPassword).not.toHaveBeenCalled();
  });

  // Ghi DB trước mà NCC lỗi là khách đọc mật khẩu mới trong khi proxy vẫn
  // dùng mật khẩu cũ.
  it('calls the provider before writing anything locally', async () => {
    provider.changeProxyPassword.mockRejectedValue(new Error('provider down'));
    await expect(changePassword()).rejects.toThrow();
    expect(svc.proxyModel.updateMany).not.toHaveBeenCalled();
    expect(svc.orderModel.updateOne).not.toHaveBeenCalled();
  });

  // NCC có thể chuẩn hoá mật khẩu; lưu cái mình gửi lên là lưu một credential
  // không kết nối được.
  it('stores the password the provider applied, not the one requested', async () => {
    await expect(changePassword()).resolves.toMatchObject({
      password: 'Applied123',
    });
    expect(svc.proxyModel.updateMany).toHaveBeenCalledWith(
      { order_id: ORDER_ID },
      { $set: { auth_password: 'Applied123' } },
    );
    expect(svc.orderModel.updateOne).toHaveBeenCalledWith(
      { _id: ORDER_ID },
      { $set: { 'credentials.password': 'Applied123' } },
    );
  });

  it('leaves credentials alone on orders that have none', async () => {
    order.credentials = null;
    await expect(changePassword()).resolves.toMatchObject({ success: true });
    expect(svc.proxyModel.updateMany).toHaveBeenCalled();
    expect(svc.orderModel.updateOne).not.toHaveBeenCalled();
  });

  // Mật khẩu đã đổi thật ở NCC rồi. Báo lỗi trần trụi là khách mất quyền truy
  // cập mà không biết mật khẩu nào đang có hiệu lực.
  it('tells the customer the live password when the local write fails', async () => {
    svc.proxyModel.updateMany = jest.fn(() => ({
      exec: async () => {
        throw new Error('mongo down');
      },
    }));
    await expect(changePassword()).rejects.toThrow(/Applied123/);
    expect(svc.logger.error).toHaveBeenCalled();
  });

  // order_logs là bảng audit, không phải chỗ lưu credential.
  it('never writes the password into the audit log', async () => {
    await changePassword();
    const [, step, message, data] = svc.orderLogService.info.mock.calls[0];
    expect(step).toBe(OrderLogStep.USER_PROXY_PASSWORD_CHANGED);
    expect(JSON.stringify({ message, data })).not.toContain('Applied123');
    expect(JSON.stringify({ message, data })).not.toContain('Chosen1234');
  });

  // ─── Whitelist IP ─────────────────────────────────────────────────────────

  it('persists the allowlist the provider confirmed', async () => {
    provider.setAllowedIps.mockResolvedValue({ allowed_ips: ['192.0.2.7'] });
    await expect(setIps()).resolves.toMatchObject({
      allowed_ips: ['192.0.2.7'],
    });
    expect(svc.orderModel.updateOne).toHaveBeenCalledWith(
      { _id: ORDER_ID },
      { $set: { 'provider_metadata.allowed_ips': ['192.0.2.7'] } },
    );
  });

  it('records clearing the allowlist as its own audit entry', async () => {
    provider.setAllowedIps.mockResolvedValue({ allowed_ips: [] });
    await svc.setAllowedIps(USER, ORDER_ID, []);
    const [, step, message] = svc.orderLogService.info.mock.calls[0];
    expect(step).toBe(OrderLogStep.USER_ALLOWED_IPS_UPDATED);
    expect(message).toMatch(/xoá/i);
  });

  // ─── Geo ──────────────────────────────────────────────────────────────────

  it('returns the codes the provider gave for this very order', async () => {
    await expect(geo()).resolves.toEqual({
      iso_codes: ['VN'],
      source: 'order',
      capabilities: undefined,
    });
    expect(provider.fetchOrderGeo).toHaveBeenCalledWith('test-only-key', '9');
    // Nguồn chính đã trả lời thì không đi hỏi vùng phủ gói nữa.
    expect(provider.listCountriesForPackage).not.toHaveBeenCalled();
  });

  /**
   * Đây là ca THẬT, không phải giả định: đơn IPv6 Datacenter đã mua trên
   * api.gpnip.com trả `/orders/{id}/geo` = `[]` trong khi gói của nó khai 1
   * nước. Dừng ở nguồn chính là ô chọn quốc gia rỗng trên đơn có quốc gia.
   */
  it('falls back to the package coverage when the order declares no geo', async () => {
    provider.fetchOrderGeo.mockResolvedValue({ iso_codes: [], raw: [] });
    await expect(geo()).resolves.toEqual({
      iso_codes: ['US'],
      source: 'package',
      capabilities: { country: true },
    });
    expect(provider.listCountriesForPackage).toHaveBeenCalledWith(
      'test-only-key',
      'pkg-1',
    );
  });

  it('does not fall back when the service has no package id', async () => {
    provider.fetchOrderGeo.mockResolvedValue({ iso_codes: [], raw: [] });
    service = { id_service: '' };
    await expect(geo()).resolves.toEqual({ iso_codes: [], source: 'none' });
    expect(provider.listCountriesForPackage).not.toHaveBeenCalled();
  });

  it('does not fall back when the adapter cannot read package coverage', async () => {
    provider.fetchOrderGeo.mockResolvedValue({ iso_codes: [], raw: [] });
    delete provider.listCountriesForPackage;
    await expect(geo()).resolves.toEqual({ iso_codes: [], source: 'none' });
  });

  // Dự phòng lỗi KHÔNG được làm sập endpoint: nguồn chính đã trả lời xong.
  it('still answers when the package coverage lookup throws', async () => {
    provider.fetchOrderGeo.mockResolvedValue({ iso_codes: [], raw: [] });
    provider.listCountriesForPackage.mockRejectedValue(new Error('502 nhà cung cấp'));
    await expect(geo()).resolves.toEqual({ iso_codes: [], source: 'none' });
    expect(svc.logger.warn).toHaveBeenCalled();
  });

  // `raw` mang nhãn và tên nhà cung cấp — khách đọc trực tiếp response này.
  it('never passes the raw provider payload to the customer', async () => {
    provider.fetchOrderGeo.mockResolvedValue({
      iso_codes: ['VN'],
      raw: { vendor: 'GPNIP', note: 'internal' },
    });
    const res: any = await geo();
    expect(res.raw).toBeUndefined();
    expect(JSON.stringify(res)).not.toMatch(/gpnip/i);
  });

  // Geo chỉ đọc — không có lý do khoá theo trạng thái đơn như hai cái kia.
  it('still reads geo on an expired order', async () => {
    order.status = OrderStatusEnum.EXPIRED;
    order.end_date = new Date(Date.now() - 1000);
    await expect(geo()).resolves.toBeDefined();
  });
});

/**
 * Chi tiết đơn của user là response duy nhất mà khách đọc trực tiếp. Nó phải
 * nói "làm được gì" mà không nói "nhà cung cấp nào".
 */
describe('User order detail exposure', () => {
  const USER = '000000000000000000000001';
  const ORDER_ID = '0000000000000000000000aa';

  let svc: any;
  let stored: any;
  let provider: any;

  /** Chain mongoose: findOne().populate()...select().lean().exec() */
  const chain = (result: unknown) => {
    const node: any = {};
    node.populate = jest.fn(() => node);
    node.select = jest.fn(() => node);
    node.lean = jest.fn(() => node);
    node.skip = jest.fn(() => node);
    node.limit = jest.fn(() => node);
    node.exec = jest.fn(async () => result);
    return node;
  };

  beforeEach(() => {
    stored = {
      _id: ORDER_ID,
      order_code: 'OD1',
      user_id: USER,
      partner_id: { code: 'gpnip', status: true },
      provider_order_id: '9',
      provider_metadata: {
        allowed_ips: ['192.0.2.7'],
        secret_note: 'internal',
      },
      total_price: 1000,
    };
    provider = {
      changeProxyPassword: jest.fn(),
      setAllowedIps: jest.fn(),
      fetchOrderGeo: jest.fn(),
    };

    svc = Object.create(OrdersService.prototype);
    svc.orderModel = { findOne: jest.fn(() => chain(stored)) };
    svc.proxyModel = {
      find: jest.fn(() => chain([])),
      countDocuments: jest.fn(() => chain(0)),
    };
    svc.providerFactory = {
      hasProvider: jest.fn(() => true),
      getProvider: jest.fn(() => provider),
    };
  });

  const detail = () => svc.findOneByUser(USER, ORDER_ID, {});

  // order.config chua snapshot cau hinh goi cua GPNIP. Can trong DB (chong mua
  // trung + khoa cau hinh theo don) nhung tra ra cho khach la dua luon ma goi
  // cua nha cung cap — khach tu mua truc tiep duoc.
  it('strips provider-prefixed config keys but keeps the neutral ones', async () => {
    stored.config = {
      gpnip_body_api: '{"billing_type":"bandwidth"}',
      gpnip_id_service: '6aa8efbde22a3725a45d92bc',
      gpnip_purchase_started: true,
      protocol: 'http',
      isp: null,
    };
    const res = await detail();
    expect(res.config).toEqual({ protocol: 'http', isp: null });
    expect(JSON.stringify(res)).not.toContain('6aa8efbde22a3725a45d92bc');
  });

  it('leaves config alone for providers that use neutral keys', async () => {
    stored.partner_id = { code: 'homeproxy', status: true };
    stored.config = { rotation_time: 300, gateway_host: 'gw.example.com' };
    await expect(detail()).resolves.toMatchObject({
      config: { rotation_time: 300, gateway_host: 'gw.example.com' },
    });
  });

  it('strips every provider-identifying field', async () => {
    const res = await detail();
    expect(res.partner_id).toBeUndefined();
    expect(res.provider_order_id).toBeUndefined();
    expect(res.provider_metadata).toBeUndefined();
    expect(JSON.stringify(res)).not.toContain('gpnip');
    expect(JSON.stringify(res)).not.toContain('secret_note');
  });

  /**
   * Hai cổng PHẢI tới được khách. Modal proxy tính
   * `portSocks = Number(meta.port_socks) || 0` rồi tắt nút SOCKS5 khi bằng 0 —
   * nên bỏ hai khoá này khỏi projection là khách mất hẳn socks5 trên đơn CÓ
   * cổng socks, mà không có thông báo lỗi nào.
   *
   * Đã gãy đúng như vậy một lần: projection của user thiếu hai khoá trong khi
   * projection của admin thì có.
   */
  it('selects both proxy ports so the customer can use socks5', async () => {
    await detail();
    const projection = svc.proxyModel.find.mock.results[0].value.select.mock
      .calls[0][0] as string;
    expect(projection).toContain('provider_metadata.port_http');
    expect(projection).toContain('provider_metadata.port_socks');
    // Lấy cả `provider_metadata` là kéo theo id và cấu hình phía nhà cung cấp.
    expect(projection).not.toMatch(/(^|\s)provider_metadata(\s|$)/);
  });

  it('reports what the adapter can actually do', async () => {
    await expect(detail()).resolves.toMatchObject({
      self_service: { password: true, allowed_ips: true, geo: true },
    });
  });

  // Cờ phải khớp điều kiện của resolveOwnedProviderOrder, nếu không nút hiện
  // ra mà bấm vào vẫn lỗi.
  it('turns the flags off before the provider order id exists', async () => {
    stored.provider_order_id = '';
    await expect(detail()).resolves.toMatchObject({
      self_service: { password: false, allowed_ips: false, geo: false },
    });
  });

  it('turns the flags off while the partner is disabled', async () => {
    stored.partner_id.status = false;
    await expect(detail()).resolves.toMatchObject({
      self_service: { password: false, allowed_ips: false, geo: false },
    });
  });

  it('turns the flags off for a partner code with no adapter', async () => {
    svc.providerFactory.hasProvider = jest.fn(() => false);
    await expect(detail()).resolves.toMatchObject({
      self_service: { password: false, allowed_ips: false, geo: false },
    });
  });

  it('turns off only the capabilities the adapter lacks', async () => {
    provider = { fetchOrderGeo: jest.fn() };
    await expect(detail()).resolves.toMatchObject({
      self_service: { password: false, allowed_ips: false, geo: true },
    });
  });

  // Whitelist là dữ liệu của chính khách — vẫn phải trả ra để form điền sẵn.
  it('keeps the customer own allowlist while dropping the rest of the metadata', async () => {
    await expect(detail()).resolves.toMatchObject({
      allowed_ips: ['192.0.2.7'],
    });
  });

  it('returns an empty allowlist rather than undefined when none is set', async () => {
    stored.provider_metadata = {};
    await expect(detail()).resolves.toMatchObject({ allowed_ips: [] });
  });
});
