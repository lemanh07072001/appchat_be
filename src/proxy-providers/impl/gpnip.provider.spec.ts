import { BadRequestException } from '@nestjs/common';
import { resolveServicePorts } from '../../orders/service-ports.util';
import { GpnipProvider } from './gpnip.provider';

describe('GpnipProvider API routing', () => {
  let provider: GpnipProvider;
  let fetchMock: jest.Mock;
  const originalFetch = global.fetch;
  const baseUrl = 'https://api.gpnip.com/api/v1/reseller';
  const testToken = 'test-only-gpnip-key';

  const respond = (data: unknown) => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data }),
    });
  };

  beforeEach(() => {
    provider = new GpnipProvider();
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('quotes static IP quantity and period from the billed order', async () => {
    const pkg = {
      pricing: { mode: 'time' }, servicePricing: { quantity_field: 'ips', rows: [{ when: { period: '30' }, price: 2.25 }] },
      purchaseFields: [
        { key: 'country', required: true, options: [{ value: 'US' }] },
        { key: 'period', required: true, options: [{ value: '30' }] },
        { key: 'ips', type: 'number', required: true, min: 1, max: 100 },
      ],
    };
    for (const data of [pkg, { supported: false }, { price: 4.5 }]) {
      fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true, data }) });
    }
    const params = {
      token_api: testToken, id_service: '6ad6f4c2748369db9ee14aad',
      quantity: 2, duration_days: 30, pricing_mode: 'duration', country_code: 'US',
      body_api: JSON.stringify({ ips: 1, period: '7' }),
    } as any;
    // GPNIP (2026-10-27): purchaseFields của gói static nằm trong serviceOptions.
    expect(provider.buildBuyBody(params)).toMatchObject({ serviceOptions: { ips: 2, period: '30', country: 'US' } });
    expect(provider.buildBuyBody(params)).not.toHaveProperty('duration');
    expect(provider.buildBuyBody(params)).not.toHaveProperty('period');
    await provider.preflightBuy(params);
    // /check-price nhận serviceOptions, không nhận period top-level.
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toMatchObject({ serviceOptions: { ips: 2, period: '30', country: 'US' } });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).not.toHaveProperty('period');
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/orders'))).toBe(false);
  });

  // Ba gói proxy tĩnh (proxy6-v3/v4/v6) KHÔNG có endpoint /stock: API trả
  // HTTP 500 "Cấu hình nhà cung cấp không hợp lệ" (kiểm chứng 2026-10-27).
  // Đó là lỗi đọc tồn kho, KHÔNG phải hết hàng — chặn đơn ở đây là chặn 100%
  // đơn static. Chốt thật là /check-price + khớp giá catalog vẫn chạy.
  it('tolerates a /stock endpoint that errors for static packages', async () => {
    const warn = jest
      .spyOn((provider as any).logger, 'warn')
      .mockImplementation(() => undefined);
    const pkg = {
      pricing: { mode: 'time' },
      servicePricing: { quantity_field: 'ips', rows: [{ when: { period: '3' }, price: 0.06 }] },
      purchaseFields: [
        { key: 'country', required: true, options: [{ value: 'US' }] },
        { key: 'period', required: true, options: [{ value: '3' }] },
        { key: 'ips', type: 'number', required: true, min: 1, max: 100 },
      ],
    };
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true, data: pkg }) });
    // /stock trả 500 như proxy6-* thật trên api.gpnip.com.
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ success: false, error: { code: 'ERROR', message: 'Cấu hình nhà cung cấp không hợp lệ.' } }) });
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true, data: { price: 0.06, list_price: 0.06 } }) });
    await expect(
      provider.preflightBuy({
        token_api: testToken, id_service: '6ad6f4c2748369db9ee14aaf',
        quantity: 1, duration_days: 3, pricing_mode: 'duration', country_code: 'US',
        body_api: JSON.stringify({ country: 'US', period: '3', ips: 1 }),
      } as any),
    ).resolves.toBeUndefined();
    // Phải đi tới báo giá, và không được đặt đơn.
    expect(fetchMock.mock.calls.map((c) => c[0]).some((u: string) => u.endsWith('/check-price'))).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/orders'))).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  // POST /orders cũng theo hợp đồng mới: period/country/ips trong serviceOptions.
  // Kiểm chứng 2026-10-27: gửi `period` top-level thì đơn mặc định về 30 ngày,
  // còn serviceOptions.period mới quyết định đúng kỳ hạn/giá.
  it('posts static purchase fields under serviceOptions to /orders', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true, data: { id: '6ad36c775a0fd3280a199639', status: 'pending' } }) });
    const res = await provider.buy({
      token_api: testToken, id_service: '6ad6f4c2748369db9ee14aaf',
      quantity: 3, duration_days: 7, pricing_mode: 'duration', country_code: 'US',
      body_api: JSON.stringify({ country: 'US', period: '30', ips: 1 }),
    } as any);
    expect(res.provider_order_id).toBe('6ad36c775a0fd3280a199639');
    expect(fetchMock.mock.calls[0][0]).toBe(`${baseUrl}/orders`);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent).toMatchObject({ packageId: '6ad6f4c2748369db9ee14aaf', serviceOptions: { country: 'US', period: '7', ips: 3 } });
    expect(sent).not.toHaveProperty('period');
    expect(sent).not.toHaveProperty('ips');
  });

  it('blocks a static 3-day quote that incorrectly uses the 30-day price', async () => {
    for (const data of [
      { pricing: { mode: 'time' }, servicePricing: { quantity_field: 'ips', rows: [{ when: { period: '3' }, price: 0.06 }] }, purchaseFields: [{ key: 'period', required: true }] },
      { supported: false },
      { price: 0.39, list_price: 0.39 },
    ]) fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true, data }) });
    await expect(provider.preflightBuy({ token_api: testToken, id_service: '6ad6f4c2748369db9ee14aaf', quantity: 1, duration_days: 3, pricing_mode: 'duration', country_code: 'US', body_api: '{"ips":1,"period":"3"}' } as any)).rejects.toThrow('static quote does not match catalog');
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/orders'))).toBe(false);
  });

  it('checks the account on GPNIP, never the OmoProxy host', async () => {
    respond({ username: 'test-account', balance: 50.25, currency: 'USD' });
    await expect(provider.checkConnection(testToken)).resolves.toEqual({
      account: 'test-account',
      balance: 50.25,
      currency: 'USD',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `${baseUrl}/me`,
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: `Bearer ${testToken}`,
        }),
      }),
    );
  });

  it('does not invent a zero balance when the account omits balance', async () => {
    respond({ username: 'test-account' });
    await expect(provider.checkConnection(testToken)).resolves.toEqual({
      account: 'test-account',
    });
  });

  it('reads every proxy and converts the documented string ports', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { status: 1 } }),
    });
    respond({
      format: 'json',
      proxies: [
        {
          host: '192.0.2.1',
          port_http: '8080',
          port_socks: '1080',
          username: 'u1',
          password: 'p1',
        },
        {
          host: '192.0.2.2',
          port_http: '8081',
          port_socks: '1081',
          username: 'u2',
          password: 'p2',
        },
      ],
    });
    const proxies = await provider.fetchOrderProxies(testToken, '9', {
      protocol: 'socks5',
    });
    expect(proxies).toHaveLength(2);
    expect(proxies.map((p) => p.port)).toEqual([1080, 1081]);
    expect(proxies.every((p) => p.protocol === 'socks5')).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe(`${baseUrl}/orders/9`);
    expect(fetchMock.mock.calls[1][0]).toBe(
      `${baseUrl}/orders/9/proxies?format=json`,
    );
  });

  it('reads GB usage from the GPNIP endpoint', async () => {
    respond({ traffic: 10, usage: 2.5, remaining: 7.5, unit: 'GB' });
    await expect(provider.fetchUsage(testToken, '9')).resolves.toEqual({
      used_gb: 2.5,
    });
    expect(fetchMock.mock.calls[0][0]).toBe(`${baseUrl}/orders/9/usage`);
  });

  it('rejects provider authentication errors', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({
        success: false,
        error: { code: 'UNAUTHENTICATED', message: 'Invalid API key' },
      }),
    });
    await expect(provider.checkConnection(testToken)).rejects.toThrow(
      BadRequestException,
    );
  });
  const params = (extra: Record<string, any> = {}) => ({
    token_api: testToken,
    quantity: 1,
    duration_days: 30,
    pricing_mode: 'bandwidth',
    bandwidth_gb: 12,
    id_service: '42',
    body_api: '{}',
    ...extra,
  });
  const once = (data: unknown) =>
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data }),
    });
  it('builds purchases with actual billed GB, IPs and duration rather than stale templates', () => {
    expect(
      provider.buildBuyBody(params({ body_api: '{"gb":1,"duration":"7d"}' })),
    ).toEqual({ packageId: 42, gb: 12, duration: '30d' });
    expect(
      provider.buildBuyBody(
        params({
          pricing_mode: 'duration',
          bandwidth_gb: null,
          quantity: 3,
          body_api: '{"id":5,"ips":1,"pool":"isp-pool"}',
        }),
      ),
    ).toEqual({ packageId: 5, ips: 3, pool: 'isp-pool', duration: '30d' });
  });
  it.each(['null', '[]', '"text"', '{bad'])(
    'rejects invalid object template %s without HTTP',
    (body_api) => {
      expect(() => provider.validateBuy(params({ body_api }))).toThrow(
        BadRequestException,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it('rejects a missing package and missing billed GB without HTTP', () => {
    expect(() => provider.validateBuy(params({ id_service: '' }))).toThrow();
    expect(() =>
      provider.validateBuy(params({ bandwidth_gb: undefined })),
    ).toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('checks catalog, inventory and price without placing any order', async () => {
    once({ pricing: { mode: 'tiered_per_gb' } });
    once({
      supported: true,
      inventory: { residential: { status: 'healthy' } },
    });
    once({ price: 5 });
    await provider.preflightBuy(params());
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      baseUrl + '/packages/42',
      baseUrl + '/packages/42/stock',
      baseUrl + '/check-price',
    ]);
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({
      id: 42,
      gb: 12,
      duration: '30d',
    });
  });
  it('blocks unhealthy stock before quote or mutation', async () => {
    once({ pricing: { mode: 'tiered_per_gb' } });
    once({
      supported: true,
      inventory: { residential: { status: 'degraded' } },
    });
    await expect(provider.preflightBuy(params())).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it.each(['per_thread', 'per_ip'])(
    'blocks unsupported or mismatched %s mode',
    async (mode) => {
      once({ pricing: { mode } });
      await expect(provider.preflightBuy(params())).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );
  it('preserves package catalog pagination metadata', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: [{ id: 42 }],
        meta: { current_page: 2, last_page: 3 },
      }),
    });
    await expect(provider.listPackages(testToken, 2)).resolves.toMatchObject({
      meta: { current_page: 2 },
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      baseUrl + '/packages?page=2&per_page=20',
    );
  });
  it('does not treat pending credentials as active', async () => {
    once({ status: 0 });
    await expect(provider.fetchOrderProxies(testToken, '9')).resolves.toEqual(
      [],
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('creates once and keeps the provider order ID while pending', async () => {
    once({ order_id: 9, status: 'pending' });
    once({ status: 0 });
    await expect(provider.buy(params())).resolves.toMatchObject({
      provider_order_id: '9',
      proxies: [],
    });
    expect(fetchMock.mock.calls[0][0]).toBe(baseUrl + '/orders');
    expect(provider.retryBuy).toBe(false);
  });
  it('accepts documented renewal preview order:null and reads nested expiry', async () => {
    once({ price: 12, order: null });
    once({ price: 12, order: { expired_at: '2026-12-01T00:00:00.000Z' } });
    const result = await provider.renew({
      token_api: testToken,
      provider_order_id: '9',
      duration_days: 30,
    });
    expect(result.new_end_date?.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      duration: '30_days',
      preview: true,
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      duration: '30_days',
    });
  });
  it('does not commit after invalid renewal preview', async () => {
    once({ order: null });
    await expect(
      provider.renew({
        token_api: testToken,
        provider_order_id: '9',
        duration_days: 30,
      }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('extends GB without confusing it with time renewal', async () => {
    once({ price: 1, order: { traffic: 20 } });
    await provider.extendBandwidth(testToken, '9', 5);
    expect(fetchMock.mock.calls[0][0]).toBe(baseUrl + '/orders/9/extend');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ gb: 5 });
  });
  it('uses all proxies in active detail without an extra request', async () => {
    once({ status: 1, proxies: [
      { host: '192.0.2.1', port_http: '8080', port_socks: '1080', username: 'u', password: 'p' },
      { host: '192.0.2.2', port_http: '8081', port_socks: '1081', username: 'u', password: 'p' },
    ] });
    const proxies = await provider.fetchOrderProxies(testToken, '9');
    expect(proxies).toHaveLength(2);
    expect(proxies[0].provider_proxy_id).not.toBe(proxies[1].provider_proxy_id);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('rejects malformed active proxy credentials', async () => {
    once({ status: 1, proxies: [{ host: '192.0.2.1', port_http: 'bad' }] });
    await expect(provider.fetchOrderProxies(testToken, '9')).rejects.toThrow();
  });
  it('rejects duration mismatch for a fixed package before stock or quote', async () => {
    once({ pricing: { mode: 'fixed' }, duration_days: 7 });
    await expect(provider.preflightBuy(params({ pricing_mode: 'duration', bandwidth_gb: null }))).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

});

describe('GpnipProvider base URL by environment', () => {
  const PROD = 'https://api.gpnip.com/api/v1/reseller';
  const saved = process.env.GPNIP_BASE_URL;

  afterEach(() => {
    if (saved === undefined) delete process.env.GPNIP_BASE_URL;
    else process.env.GPNIP_BASE_URL = saved;
  });

  it('defaults to production when the env is unset', () => {
    delete process.env.GPNIP_BASE_URL;
    expect(GpnipProvider.resolveBaseUrl()).toBe(PROD);
  });

  it('switches to the documented dev host without a code change', () => {
    process.env.GPNIP_BASE_URL = 'https://dev-api.gpnip.com/api/v1/reseller';
    expect(GpnipProvider.resolveBaseUrl()).toBe(
      'https://dev-api.gpnip.com/api/v1/reseller',
    );
  });

  it('drops a trailing slash so paths never produce a double slash', () => {
    process.env.GPNIP_BASE_URL = 'https://dev-api.gpnip.com/api/v1/reseller//';
    expect(GpnipProvider.resolveBaseUrl()).toBe(
      'https://dev-api.gpnip.com/api/v1/reseller',
    );
  });

  // Rơi ngược về prod khi env sai nghĩa là một lần test tưởng là dev mà mua
  // bằng tiền thật — thà không khởi động được.
  it('refuses to fall back to production on a malformed env', () => {
    process.env.GPNIP_BASE_URL = 'not-a-url';
    expect(() => GpnipProvider.resolveBaseUrl()).toThrow(/GPNIP_BASE_URL/);
  });

  it('refuses plain http to a remote host so the API key is not sent in clear', () => {
    process.env.GPNIP_BASE_URL = 'http://dev-api.gpnip.com/api/v1/reseller';
    expect(() => GpnipProvider.resolveBaseUrl()).toThrow(/https/);
  });

  // resolveBaseUrl đúng mà field BASE_URL không đọc nó thì env vẫn vô dụng:
  // kiểm tra bằng request thật sự đi tới đâu.
  it('actually sends requests to the dev host when constructed with the env', async () => {
    process.env.GPNIP_BASE_URL = 'https://dev-api.gpnip.com/api/v1/reseller';
    const originalFetch = global.fetch;
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { username: 'u' } }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    try {
      await new GpnipProvider().checkConnection('test-only-gpnip-key');
      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://dev-api.gpnip.com/api/v1/reseller/me',
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('still allows http on localhost for a mock server', () => {
    process.env.GPNIP_BASE_URL = 'http://127.0.0.1:8099/api/v1/reseller';
    expect(GpnipProvider.resolveBaseUrl()).toBe(
      'http://127.0.0.1:8099/api/v1/reseller',
    );
  });
});

describe('GpnipProvider self-service endpoints', () => {
  let provider: GpnipProvider;
  let fetchMock: jest.Mock;
  const originalFetch = global.fetch;
  const baseUrl = 'https://api.gpnip.com/api/v1/reseller';
  const testToken = 'test-only-gpnip-key';

  const once = (data: unknown) =>
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data }),
    });

  const onceEnvelope = (payload: Record<string, unknown>) =>
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: true, ...payload }),
    });

  beforeEach(() => {
    provider = new GpnipProvider();
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  // ─── GET /orders — đối soát ────────────────────────────────────────────────

  it('keeps provider order pagination metadata for reconciliation', async () => {
    onceEnvelope({ data: [{ id: 9 }], meta: { total: 1, last_page: 1 } });
    await expect(
      provider.listProviderOrders(testToken, 2, 50),
    ).resolves.toMatchObject({ data: [{ id: 9 }], meta: { total: 1 } });
    expect(fetchMock.mock.calls[0][0]).toBe(
      baseUrl + '/orders?page=2&per_page=50',
    );
  });

  it('omits the status filter unless one is asked for', async () => {
    onceEnvelope({ data: [] });
    await provider.listProviderOrders(testToken);
    expect(fetchMock.mock.calls[0][0]).not.toContain('status');
  });

  it('sends status=0 when pending orders are explicitly requested', async () => {
    onceEnvelope({ data: [] });
    await provider.listProviderOrders(testToken, 1, 20, 0);
    expect(fetchMock.mock.calls[0][0]).toContain('status=0');
  });

  it('rejects an out-of-range status and oversized pages without any request', async () => {
    await expect(
      provider.listProviderOrders(testToken, 1, 20, 6),
    ).rejects.toThrow(BadRequestException);
    await expect(
      provider.listProviderOrders(testToken, 1, 500),
    ).rejects.toThrow(BadRequestException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ─── Danh mục địa lý ──────────────────────────────────────────────────────

  it('asks for countries of the requested product only', async () => {
    once({ product: 'isp', supported: { country: ['us'] } });
    await provider.listCountries(testToken, 'isp');
    expect(fetchMock.mock.calls[0][0]).toBe(baseUrl + '/countries?product=isp');
  });

  // Truoc day test nay doi chan moi product ngoai enum tai lieu. Bo, vi enum
  // do THIEU `ipv6-datacenter`/`ipv6-residential` ma GPNIP van nhan — chan
  // theo no la tu choi dung product cua goi dang ban. Gio chi chan hinh dang
  // sai; xem describe o cuoi file.
  it('passes an unlisted but well-formed product through to the provider', async () => {
    once({ product: 'ipv6-datacenter', supported: { country: ['us'] } });
    await expect(
      provider.listCountries(testToken, 'ipv6-datacenter'),
    ).resolves.toMatchObject({ iso_codes: ['US'] });
    expect(fetchMock.mock.calls[0][0]).toContain('product=ipv6-datacenter');
  });

  // Tài liệu: NCC không cấu hình geo thì trả mảng rỗng — đó là câu trả lời,
  // không phải lỗi. Adapter chuẩn hoá sẵn vì caller dựng ô CHỌN quốc gia từ
  // đây; chi tiết ở describe 'GpnipProvider order geo' cuối file.
  it('treats an empty geo catalog as a valid answer', async () => {
    once([]);
    await expect(
      provider.fetchOrderGeo(testToken, '9'),
    ).resolves.toMatchObject({ iso_codes: [] });
  });

  // ─── PUT /orders/{id}/password ────────────────────────────────────────────

  it('rejects a password the provider documents as invalid before any request', async () => {
    await expect(
      provider.changeProxyPassword(testToken, '9', 'abc'),
    ).rejects.toThrow(BadRequestException);
    await expect(
      provider.changeProxyPassword(testToken, '9', 'has space1'),
    ).rejects.toThrow(BadRequestException);
    await expect(
      provider.changeProxyPassword(testToken, '9', 'p'.repeat(33)),
    ).rejects.toThrow(BadRequestException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the documented body and returns the password the provider applied', async () => {
    once({ updated: true, password: 'Normalised99', message: 'ok' });
    await expect(
      provider.changeProxyPassword(testToken, '9', 'Chosen1234'),
    ).resolves.toMatchObject({ password: 'Normalised99' });
    expect(fetchMock.mock.calls[0][0]).toBe(baseUrl + '/orders/9/password');
    expect(fetchMock.mock.calls[0][1].method).toBe('PUT');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      new_password: 'Chosen1234',
    });
  });

  // success:true + updated:false = NCC nhận request nhưng không đổi. Coi là
  // thành công là để khách giữ mật khẩu cũ mà tưởng đã đổi.
  it('does not report success when the provider did not apply the change', async () => {
    once({ updated: false, message: 'unsupported' });
    await expect(
      provider.changeProxyPassword(testToken, '9', 'Chosen1234'),
    ).rejects.toThrow(BadRequestException);
  });

  // ─── PUT /orders/{id}/allowed-ips ─────────────────────────────────────────

  it('rejects a malformed IP before touching the provider', async () => {
    await expect(
      provider.setAllowedIps(testToken, '9', ['192.0.2.1', '999.1.1.1']),
    ).rejects.toThrow(BadRequestException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts IPv6 as well as IPv4', async () => {
    once({ allowed_ips: ['2001:db8::1'], updated: true });
    await expect(
      provider.setAllowedIps(testToken, '9', ['2001:db8::1']),
    ).resolves.toMatchObject({ allowed_ips: ['2001:db8::1'] });
  });

  // 12 dòng trong đó 3 trùng vẫn là 9 IP thật — từ chối thì khách không hiểu.
  it('counts the limit after removing duplicates', async () => {
    const ips = Array.from({ length: 9 }, (_, i) => '192.0.2.' + (i + 1));
    once({ allowed_ips: ips, updated: true });
    await provider.setAllowedIps(testToken, '9', [
      ...ips,
      ips[0],
      ips[1],
      ips[2],
    ]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      allowed_ips: ips,
    });
  });

  it('rejects more than the documented ten distinct IPs', async () => {
    const ips = Array.from({ length: 11 }, (_, i) => '192.0.2.' + (i + 1));
    await expect(provider.setAllowedIps(testToken, '9', ips)).rejects.toThrow(
      BadRequestException,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Mảng rỗng là cách xoá whitelist, không phải input sai.
  it('allows clearing the allowlist', async () => {
    once({ allowed_ips: [], updated: true });
    await expect(
      provider.setAllowedIps(testToken, '9', []),
    ).resolves.toMatchObject({ allowed_ips: [] });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      allowed_ips: [],
    });
  });

  it('stores what the provider confirmed, not what was requested', async () => {
    once({ allowed_ips: ['192.0.2.1'], updated: true });
    await expect(
      provider.setAllowedIps(testToken, '9', ['192.0.2.1', '192.0.2.2']),
    ).resolves.toMatchObject({ allowed_ips: ['192.0.2.1'] });
  });
});

describe('GpnipProvider countries shape normalisation', () => {
  let provider: GpnipProvider;
  let fetchMock: jest.Mock;
  const originalFetch = global.fetch;
  const testToken = 'test-only-gpnip-key';

  const once = (data: unknown) =>
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data }),
    });

  beforeEach(() => {
    provider = new GpnipProvider();
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  // Dạng api.gpnip.com thật sự trả về (2026-10-19), KHÁC tài liệu.
  it('reads the shape the live API actually returns', async () => {
    once({
      product: 'isp',
      supported: { country: ['us'], state: [], city: [], asn: [], zip: [] },
      capabilities: { country: true, state: false },
      generated_at: '2026-05-11T09:39:35.000Z',
      source: 'discovery',
    });
    await expect(provider.listCountries(testToken, 'isp')).resolves.toMatchObject({
      product: 'isp',
      iso_codes: ['US'],
      capabilities: { country: true, state: false },
    });
  });

  // Dạng tài liệu — vẫn phải đọc được, để đổi bên nhà cung cấp không làm vỡ.
  it('still reads the shape the documentation describes', async () => {
    once([
      { name: 'Vietnam', iso_code: 'VN' },
      { name: 'United States', iso_code: 'us' },
    ]);
    await expect(
      provider.listCountries(testToken, 'residential'),
    ).resolves.toMatchObject({ iso_codes: ['VN', 'US'] });
  });

  // Mã ISO lẫn hoa/thường là admin copy mã không khớp được với cấu hình nào.
  it('upper-cases and de-duplicates the codes', async () => {
    once({ supported: { country: ['vn', 'VN', 'us', 'kr'] } });
    await expect(
      provider.listCountries(testToken, 'residential'),
    ).resolves.toMatchObject({ iso_codes: ['VN', 'US', 'KR'] });
  });

  // API echo product đã chuẩn hoá: gửi unlimited_residential, nhận
  // unlimited-residential. Trả cái NCC nói, không trả cái mình gửi.
  it('reports the product name the provider echoed back', async () => {
    once({ product: 'unlimited-residential', supported: { country: ['vn'] } });
    await expect(
      provider.listCountries(testToken, 'unlimited_residential'),
    ).resolves.toMatchObject({ product: 'unlimited-residential' });
  });

  it('falls back to the requested product when the response omits it', async () => {
    once({ supported: { country: [] } });
    await expect(provider.listCountries(testToken, 'mobile')).resolves.toMatchObject({
      product: 'mobile',
      iso_codes: [],
    });
  });

  // Trả rỗng vì không đọc được shape, và trả rỗng vì NCC không có vùng nào,
  // nhìn giống nhau ở giao diện — nên `raw` phải luôn còn để phân biệt.
  it('keeps the raw payload so state/city/asn are not lost', async () => {
    const payload = {
      product: 'residential',
      supported: { country: ['vn'], state: ['hanoi'], asn: ['AS1234'] },
    };
    once(payload);
    const res = await provider.listCountries(testToken, 'residential');
    expect(res.raw).toEqual(payload);
  });

  it('survives a payload in neither shape without throwing', async () => {
    once({ unexpected: true });
    await expect(
      provider.listCountries(testToken, 'residential'),
    ).resolves.toMatchObject({ iso_codes: [] });
  });
});

/**
 * ID gói là ObjectId 24 hex, không phải int. Kiểm chứng trên API thật
 * 2026-10-19: GET /packages/1 -> 400 "Invalid ID format";
 * GET /packages/000000000000000000000001 -> 404 "Package not found."
 *
 * Ép về số là chặn 100% lần mua GPNIP ngay tại local, trước khi gọi NCC.
 */
describe('GpnipProvider package ID format', () => {
  const OID = '6ad36c775a0fd3280a199639';

  it('accepts the ObjectId the live API requires', () => {
    expect(GpnipProvider.normalisePackageId(OID)).toBe(OID);
  });

  it('lower-cases hex so the same package is never two different IDs', () => {
    expect(GpnipProvider.normalisePackageId(OID.toUpperCase())).toBe(OID);
  });

  it('still accepts the integer the documentation describes', () => {
    expect(GpnipProvider.normalisePackageId(42)).toBe(42);
    expect(GpnipProvider.normalisePackageId('42')).toBe(42);
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['undefined', undefined],
    ['null', null],
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['too short hex', 'abc'],
    ['23 hex digits', '6ad36c775a0fd3280a19963'],
    ['25 hex digits', '6ad36c775a0fd3280a1996390'],
    ['non-hex 24 chars', 'zzzzzzzzzzzzzzzzzzzzzzzz'],
    ['sql-ish', "1 OR 1=1"],
  ])('rejects %s', (_label, value) => {
    expect(GpnipProvider.normalisePackageId(value)).toBeNull();
  });

  it('builds a purchase body carrying the ObjectId through to the provider', () => {
    const provider = new GpnipProvider();
    const body = provider.buildBuyBody({
      token_api: 'test-only-gpnip-key',
      id_service: OID,
      body_api: '{}',
      pricing_mode: 'bandwidth',
      bandwidth_gb: 1,
      quantity: 1,
      duration_days: 0,
    });
    expect(body).toMatchObject({ packageId: OID, gb: 1 });
  });

  // `id` trong body_api phải được đổi thành `packageId` và không còn sót lại,
  // nếu không là gửi hai tham số ID cho nhà cung cấp.
  it('renames body_api id to packageId without leaving id behind', () => {
    const provider = new GpnipProvider();
    const body = provider.buildBuyBody({
      token_api: 'test-only-gpnip-key',
      id_service: '',
      body_api: `{"id":"${OID}"}`,
      pricing_mode: 'bandwidth',
      bandwidth_gb: 1,
      quantity: 1,
      duration_days: 0,
    });
    expect(body.packageId).toBe(OID);
    expect(body.id).toBeUndefined();
  });
});

/**
 * Chọn ID đơn để lưu vào `provider_order_id`.
 *
 * GPNIP chỉ nhận ObjectId 24 hex ở path (kiểm chứng 2026-10-19:
 * GET /orders/1 -> 400 "Invalid ID format"), nhưng chi tiết đơn còn trả `uuid`
 * ("acct_…") và `order_id` ("omo-…") ở định dạng khác. Tài liệu nói
 * POST /orders trả `order_id`, nên lấy `order_id` trước là cái bẫy: đơn đã trừ
 * tiền khách mà mọi lệnh sau đó 400 vĩnh viễn.
 */
describe('GpnipProvider provider_order_id selection', () => {
  let provider: GpnipProvider;
  let fetchMock: jest.Mock;
  const originalFetch = global.fetch;
  const OID = '6ad36c775a0fd3280a199639';

  const buy = (data: unknown) => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data }),
    });
    return provider.buy({
      token_api: 'test-only-gpnip-key',
      id_service: OID,
      body_api: '{}',
      pricing_mode: 'bandwidth',
      bandwidth_gb: 1,
      quantity: 1,
      duration_days: 0,
    });
  };

  beforeEach(() => {
    provider = new GpnipProvider();
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    jest.spyOn((provider as any).logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  // Đúng hình dạng API thật trả về cho một đơn.
  it('prefers the ObjectId over the omo- order_id the docs point at', async () => {
    await expect(
      buy({
        id: OID,
        uuid: 'acct_e4tkz2edvn9a91d6x0zerx9bg0',
        order_id: 'omo-eddfc447-e645-45fa-95d2-69a730929597',
        status: 'pending',
      }),
    ).resolves.toMatchObject({ provider_order_id: OID });
  });

  it('reads a nested order.id when the response wraps it', async () => {
    await expect(buy({ order: { id: OID }, status: 'pending' })).resolves.toMatchObject({
      provider_order_id: OID,
    });
  });

  // Tài liệu khai int, nên vẫn phải nhận nếu NCC thực sự trả int.
  it('accepts a plain integer order id', async () => {
    await expect(buy({ order_id: 912345 })).resolves.toMatchObject({
      provider_order_id: '912345',
    });
  });

  it('takes order_id when it is itself a valid ObjectId', async () => {
    await expect(buy({ order_id: OID })).resolves.toMatchObject({
      provider_order_id: OID,
    });
  });

  // Đơn đã mua rồi: mất ID là mất luôn đường đối soát, nên vẫn giữ — nhưng
  // phải log lỗi để người vận hành biết là phải xử lý tay.
  it('keeps an unusable id rather than losing a paid order, and logs it', async () => {
    const res = await buy({ order_id: 'omo-eddfc447-e645-45fa-95d2-69a730929597' });
    expect(res.provider_order_id).toBe('omo-eddfc447-e645-45fa-95d2-69a730929597');
    expect((provider as any).logger.error).toHaveBeenCalled();
  });

  it('does not log when a usable id was found', async () => {
    await buy({ id: OID, order_id: 'omo-xxx' });
    expect((provider as any).logger.error).not.toHaveBeenCalled();
  });

  it('still fails loudly when the response carries no id at all', async () => {
    await expect(buy({ status: 'pending' })).rejects.toThrow(/không trả về id đơn/);
  });

  it('ignores blank and whitespace-only candidates', async () => {
    await expect(buy({ id: '   ', order_id: OID })).resolves.toMatchObject({
      provider_order_id: OID,
    });
  });

  // raw phải còn nguyên: đối soát một đơn đã trả tiền cần cả response gốc.
  it('persists the whole provider response for reconciliation', async () => {
    const payload = { id: OID, order_id: 'omo-abc', status: 'pending' };
    const res = await buy(payload);
    expect(res.raw).toEqual(payload);
  });
});

/**
 * Preflight đối chiếu với response THẬT của api.gpnip.com (2026-10-19), không
 * phải với tài liệu. Ba chỗ tài liệu sai và đã làm preflight xử lý sai:
 *   - tồn kho: { inventory: { stock: { available: bool } } }, KHÔNG có `status`
 *   - pricing.mode: có 'time', tài liệu không liệt kê
 *   - số ngày của gói: `durationDays` (camelCase), không phải `duration_days`
 */
describe('GpnipProvider preflight against the live API shapes', () => {
  let provider: GpnipProvider;
  let fetchMock: jest.Mock;
  const originalFetch = global.fetch;
  const PKG = '6aa8efbde22a3725a45d92bc'; // IPv6 Datacenter that
  const once = (data: unknown) =>
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data }),
    });

  const params = (over: Record<string, unknown> = {}) =>
    ({
      token_api: 'test-only-gpnip-key',
      id_service: PKG,
      body_api: '{}',
      pricing_mode: 'bandwidth',
      bandwidth_gb: 1,
      quantity: 1,
      duration_days: 0,
      ...over,
    }) as any;

  // Gói IPv6 Datacenter thật, rút gọn đúng các field preflight đọc.
  const realPackage = {
    id: PKG,
    product: 'ipv6-datacenter',
    title: 'IPv6 Datacenter',
    durationDays: null,
    pricing: {
      mode: 'tiered_per_gb',
      unit: 'GB',
      currency: 'coin',
      min_gb: 1,
      max_gb: 20000,
      tiers: [{ min_gb: 1, price_per_gb: 0.25 }],
    },
  };
  const stockAvailable = {
    supported: true,
    kind: 'stock',
    product: 'ipv6-datacenter',
    inventory: { product_type: 'ipv6-datacenter', stock: { available: true } },
  };

  beforeEach(() => {
    provider = new GpnipProvider();
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('passes the real IPv6 Datacenter package end to end', async () => {
    once(realPackage);
    once(stockAvailable);
    once({ price: 0.25, list_price: 0.25, discount: 0, unit: 'GB', label: '1 GB' });
    await expect(provider.preflightBuy(params())).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  // Day la bug nang nhat: het hang ma van mua = tru tien khach lay don khong
  // bao gio duoc cap. Shape that khong co `status`, chi co `available`.
  it('refuses to buy when the live stock shape says available: false', async () => {
    once(realPackage);
    once({
      supported: true,
      kind: 'stock',
      inventory: { product_type: 'ipv6-datacenter', stock: { available: false } },
    });
    await expect(provider.preflightBuy(params())).rejects.toThrow(/hết hàng|tồn kho/i);
    // Không được đi tới báo giá: đã biết hết hàng thì dừng.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('still honours the documented status field when a provider sends one', async () => {
    once(realPackage);
    once({ supported: true, inventory: { pools: { status: 'degraded' } } });
    await expect(provider.preflightBuy(params())).rejects.toThrow();
  });

  it('buys normally when the package has no stock API at all', async () => {
    once(realPackage);
    once({ supported: false });
    once({ price: 0.25 });
    await expect(provider.preflightBuy(params())).resolves.toBeUndefined();
  });

  // 'time' la mode THAT cua goi Datacenter; thieu no la tu choi oan.
  it('accepts the undocumented time mode the live catalog uses', async () => {
    once({
      ...realPackage,
      pricing: { mode: 'time', currency: 'coin', bandwidths: [{ mbps: 10, price: 1 }] },
    });
    once(stockAvailable);
    once({ price: 1 });
    await expect(
      provider.preflightBuy(params({ pricing_mode: 'duration', bandwidth_gb: null })),
    ).resolves.toBeUndefined();
  });

  it('rejects a mode nobody supports before touching stock or price', async () => {
    once({ ...realPackage, pricing: { mode: 'per_thread' } });
    await expect(provider.preflightBuy(params())).rejects.toThrow(/pricing mode/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // GB vs thoi han phai khop giua goi NCC va cau hinh noi bo.
  it('refuses a GB package sold locally as a duration package', async () => {
    once(realPackage);
    await expect(
      provider.preflightBuy(params({ pricing_mode: 'duration', bandwidth_gb: null })),
    ).rejects.toThrow(/pricing mode/i);
  });

  // durationDays camelCase: doc sai ten thi so sanh voi 0 va tu choi oan.
  it('reads durationDays camelCase for a fixed package', async () => {
    once({ ...realPackage, durationDays: 30, pricing: { mode: 'fixed' } });
    once(stockAvailable);
    once({ price: 5 });
    await expect(
      provider.preflightBuy(
        params({ pricing_mode: 'duration', bandwidth_gb: null, duration_days: 30 }),
      ),
    ).resolves.toBeUndefined();
  });

  it('still catches a genuine fixed-package duration mismatch', async () => {
    once({ ...realPackage, durationDays: 7, pricing: { mode: 'fixed' } });
    await expect(
      provider.preflightBuy(
        params({ pricing_mode: 'duration', bandwidth_gb: null, duration_days: 30 }),
      ),
    ).rejects.toThrow(/duration/i);
  });
});

/**
 * Vùng phủ quốc gia phải lấy theo GÓI của dịch vụ, không theo lựa chọn tay.
 *
 * Kiểm chứng trên api.gpnip.com 2026-10-19 — vùng phủ lệch nhau rất xa:
 *   ipv6-datacenter   1 nước (US)      residential          166 nước (echo 'pool1')
 *   ipv6-residential  1 nước (US)      residential-lite     202 nước
 *   datacenter        1 nước (US)      unlimited_residential 201 nước
 *   isp               1 nước (US)      mobile               115 nước
 *
 * Và `ipv6-datacenter` / `ipv6-residential` KHÔNG nằm trong enum tài liệu,
 * nhưng GPNIP nhận. Chặn theo enum là từ chối đúng product của gói đang bán.
 */
describe('GpnipProvider countries by package', () => {
  let provider: GpnipProvider;
  let fetchMock: jest.Mock;
  const originalFetch = global.fetch;
  const baseUrl = 'https://api.gpnip.com/api/v1/reseller';
  const testToken = 'test-only-gpnip-key';
  const PKG = '6aa8efbde22a3725a45d92bc';

  const once = (data: unknown) =>
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data }),
    });

  beforeEach(() => {
    provider = new GpnipProvider();
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('reads the product from the package and asks for that coverage', async () => {
    once({ id: PKG, product: 'ipv6-datacenter' });
    once({ product: 'ipv6-datacenter', supported: { country: ['us'] } });

    await expect(
      provider.listCountriesForPackage(testToken, PKG),
    ).resolves.toMatchObject({
      package_id: PKG,
      product: 'ipv6-datacenter',
      iso_codes: ['US'],
    });
    expect(fetchMock.mock.calls[0][0]).toBe(`${baseUrl}/packages/${PKG}`);
    expect(fetchMock.mock.calls[1][0]).toBe(
      `${baseUrl}/countries?product=ipv6-datacenter`,
    );
  });

  // Chính chỗ enum tài liệu làm hỏng: product của gói nằm ngoài 6 giá trị đó.
  it('accepts a product the documentation never lists', async () => {
    once({ id: PKG, product: 'ipv6-residential' });
    once({ product: 'ipv6-residential', supported: { country: ['us'] } });
    await expect(
      provider.listCountriesForPackage(testToken, PKG),
    ).resolves.toMatchObject({ product: 'ipv6-residential', iso_codes: ['US'] });
  });

  it('keeps the provider echoed product name when it differs', async () => {
    once({ id: PKG, product: 'residential' });
    // GPNIP echo 'pool1' khi nhận 'residential'.
    once({ product: 'pool1', supported: { country: ['vn', 'us'] } });
    await expect(
      provider.listCountriesForPackage(testToken, PKG),
    ).resolves.toMatchObject({ product: 'pool1', iso_codes: ['VN', 'US'] });
  });

  // '1' KHONG nam o day: normalisePackageId co y nhan so nguyen vi tai lieu
  // khai `int`, du GPNIP thuc te tra 400. Rui ro bang 0 vi preflightBuy doc
  // GET /packages/{id} va chan truoc khi tru vi.
  it.each(['', '   ', 'abc', '../packages', '6ad36c775a0fd3280a19963'])(
    'refuses package id %p without any request',
    async (bad) => {
      await expect(
        provider.listCountriesForPackage(testToken, bad),
      ).rejects.toThrow(/ID gói/i);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  // Không có `product` thì KHÔNG được đoán: đoán sai là khai vùng phủ của một
  // sản phẩm khác lên dịch vụ này.
  it('refuses to guess when the package declares no product', async () => {
    once({ id: PKG, title: 'IPv6 Datacenter' });
    await expect(
      provider.listCountriesForPackage(testToken, PKG),
    ).rejects.toThrow(/product/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a blank product string', async () => {
    once({ id: PKG, product: '   ' });
    await expect(
      provider.listCountriesForPackage(testToken, PKG),
    ).rejects.toThrow(/product/i);
  });

  // Validate HÌNH DẠNG, không validate thành viên trong enum tài liệu.
  it.each(['', '  ', 'A', 'has space', 'semi;colon', '../etc/passwd', 'x'.repeat(50)])(
    'rejects malformed product %p before any request',
    async (bad) => {
      await expect(provider.listCountries(testToken, bad)).rejects.toThrow(
        BadRequestException,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('keeps the documented product list only as a UI hint', () => {
    expect(GpnipProvider.DOCUMENTED_PRODUCTS).toContain('residential');
    // Danh sách tài liệu THIẾU product thật của gói — đó là lý do nó không
    // còn được dùng làm allow-list.
    expect(GpnipProvider.DOCUMENTED_PRODUCTS).not.toContain('ipv6-datacenter');
  });
});

/**
 * `GET /orders/{id}/geo` — nguồn cho ô CHỌN quốc gia trong modal của khách,
 * nên hình dạng riêng của nhà cung cấp phải dừng lại ở adapter.
 *
 * Kiểm chứng trên api.gpnip.com 2026-10-19: đơn IPv6 Datacenter thật trả
 * `{"success":true,"data":[]}`. Rỗng là câu trả lời hợp lệ, không phải lỗi —
 * caller tự lùi sang vùng phủ của gói.
 */
describe('GpnipProvider order geo', () => {
  let provider: GpnipProvider;
  let fetchMock: jest.Mock;
  const originalFetch = global.fetch;
  const baseUrl = 'https://api.gpnip.com/api/v1/reseller';
  const testToken = 'test-only-gpnip-key';

  const once = (data: unknown) =>
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data }),
    });

  beforeEach(() => {
    provider = new GpnipProvider();
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('calls the geo endpoint of that order', async () => {
    once([]);
    await provider.fetchOrderGeo(testToken, 'abc-1');
    expect(fetchMock.mock.calls[0][0]).toBe(`${baseUrl}/orders/abc-1/geo`);
  });

  // Dạng THẬT đã quan sát được.
  it('treats an empty geo list as an answer, not an error', async () => {
    once([]);
    await expect(provider.fetchOrderGeo(testToken, 'abc-1')).resolves.toMatchObject(
      { iso_codes: [] },
    );
  });

  it.each([
    ['dạng tài liệu', [{ name: 'Vietnam', iso_code: 'vn' }, { name: 'US', iso_code: 'US' }]],
    ['mảng chuỗi', ['vn', 'us']],
    ['supported.country', { supported: { country: ['VN', 'us'] } }],
    ['countries', { countries: [{ code: 'vn' }, { code: 'us' }] }],
  ])('normalises %s to uppercase ISO-2', async (_label, payload) => {
    once(payload);
    const res = await provider.fetchOrderGeo(testToken, 'abc-1');
    expect(res.iso_codes).toEqual(['VN', 'US']);
  });

  it('drops duplicates regardless of the case the provider used', async () => {
    once(['vn', 'VN', 'Vn']);
    const res = await provider.fetchOrderGeo(testToken, 'abc-1');
    expect(res.iso_codes).toEqual(['VN']);
  });

  /**
   * Payload geo trộn cả state/city/asn. Nhận bừa là đẩy "california" vào ô
   * chọn quốc gia, rồi ghép thành `-country-california` và gateway từ chối.
   */
  it('keeps only two-letter codes out of a mixed geo payload', async () => {
    once(['us', 'california', 'los-angeles', 'AS12345', 'gb', '', '1']);
    const res = await provider.fetchOrderGeo(testToken, 'abc-1');
    expect(res.iso_codes).toEqual(['US', 'GB']);
  });

  it('surfaces capabilities when the provider sends them', async () => {
    once({ supported: { country: ['us'] }, capabilities: { country: true, city: false } });
    const res = await provider.fetchOrderGeo(testToken, 'abc-1');
    expect(res.capabilities).toEqual({ country: true, city: false });
  });

  it('refuses an order with no provider id, without any request', async () => {
    await expect(provider.fetchOrderGeo(testToken, '')).rejects.toThrow(
      BadRequestException,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * Bảng cổng theo sản phẩm — nguồn DỰ PHÒNG khi đơn không khai cổng.
 *
 * Lý do tồn tại: `/packages` có field `ports` nhưng trả `null` cho cả 7 gói
 * (kiểm chứng 2026-10-20), và `fetchOrderProxies` ném lỗi khi cổng không hợp
 * lệ — nên đơn socks5 của sản phẩm thiếu `port_socks` sẽ cấp thất bại hoàn
 * toàn. Nhưng bảng chép tay thì sẽ cũ đi, nên cổng nhà cung cấp trả về PHẢI
 * luôn thắng.
 */
describe('GpnipProvider product port fallback', () => {
  let provider: GpnipProvider;
  let fetchMock: jest.Mock;
  let warn: jest.SpyInstance;
  const originalFetch = global.fetch;
  const testToken = 'test-only-gpnip-key';

  /** `/orders/{id}` trả sẵn proxies để chỉ cần một lượt fetch. */
  const order = (proxy: Record<string, unknown>, proxy_type?: string) =>
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          status: 1,
          proxy_type,
          proxies: [{ host: 'v3-v6-dc.example.test', username: 'u', password: 'p', ...proxy }],
        },
      }),
    });

  beforeEach(() => {
    provider = new GpnipProvider();
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    warn = jest.spyOn((provider as any).logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    warn.mockRestore();
  });

  // Chính ca gãy: thiếu `port_socks` mà khách mua socks5.
  it('fills a missing socks port from the product table', async () => {
    order({ port_http: 50 }, 'ipv6-datacenter');
    const [p] = await provider.fetchOrderProxies(testToken, '9', {
      protocol: 'socks5',
    });
    expect(p.port).toBe(51);
    expect(p.protocol).toBe('socks5');
    expect(warn).toHaveBeenCalled();
  });

  it('fills a missing http port from the product table', async () => {
    order({ port_socks: 9696 }, 'residential-lite');
    const [p] = await provider.fetchOrderProxies(testToken, '9');
    expect(p.port).toBe(6969);
  });

  /**
   * Bảng là bản chép tay nên phải NHƯỜNG dữ liệu thật. Nhà cung cấp đổi cổng
   * mà mình vẫn áp bảng là cấp cho khách một proxy chết.
   */
  it('lets the provider value win when it disagrees with the table', async () => {
    order({ port_http: 8080, port_socks: 9999 }, 'ipv6-datacenter');
    const [p] = await provider.fetchOrderProxies(testToken, '9', {
      protocol: 'socks5',
    });
    expect(p.port).toBe(9999);
    expect(warn).not.toHaveBeenCalled();
  });

  // Không có khoá thì KHÔNG đoán: thà cấp thất bại còn hơn cấp proxy chết.
  it('still fails for an unknown product with no port', async () => {
    order({}, 'some-product-we-never-saw');
    await expect(provider.fetchOrderProxies(testToken, '9')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('still fails when the order declares no product at all', async () => {
    order({});
    await expect(provider.fetchOrderProxies(testToken, '9')).rejects.toThrow(
      BadRequestException,
    );
  });

  // API gửi `unlimited_residential` nhưng echo `unlimited-residential`.
  it.each(['unlimited_residential', 'unlimited-residential', 'UNLIMITED_RESIDENTIAL'])(
    'resolves the table key for %p regardless of separator or case',
    async (product) => {
      order({}, product);
      const [p] = await provider.fetchOrderProxies(testToken, '9', {
        protocol: 'socks5',
      });
      // Sản phẩm này dùng CÙNG một cổng cho cả hai giao thức.
      expect(p.port).toBe(10507);
    },
  );

  /**
   * Nút SOCKS5 trong modal của khách đọc `provider_metadata.port_socks`. Để
   * trống ở đây là khách không chọn được socks5 dù sản phẩm có hỗ trợ.
   */
  it('stores both resolved ports so the customer can switch protocol', async () => {
    order({ port_http: 50 }, 'ipv6-datacenter');
    const [p] = await provider.fetchOrderProxies(testToken, '9');
    expect(p.provider_metadata).toEqual({ port_http: 50, port_socks: 51 });
  });

  // Cổng dạng chuỗi ("50") phải cho ra id giống hệt bản cũ, nếu không mọi proxy
  // đang lưu bị coi là proxy mới.
  it('keeps the proxy identifier stable for string ports', async () => {
    order({ port_http: '50', port_socks: '51' }, 'ipv6-datacenter');
    const [p] = await provider.fetchOrderProxies(testToken, '9');
    expect(p.provider_proxy_id).toBe('gpnip:9:v3-v6-dc.example.test:50');
  });

  // Cổng ngoài khoảng hợp lệ là dữ liệu rác, không phải "thiếu" — vẫn phải lùi
  // về bảng chứ không được dùng.
  it.each([0, -1, 70000, 'bad'])(
    'treats an out-of-range port %p as missing',
    async (bad) => {
      order({ port_http: bad }, 'ipv6-datacenter');
      const [p] = await provider.fetchOrderProxies(testToken, '9');
      expect(p.port).toBe(50);
    },
  );

  // Khớp với đơn THẬT đã mua: port_http 50 / port_socks 51.
  it('matches the ports of the order actually purchased', () => {
    expect(GpnipProvider.PRODUCT_PORTS['ipv6-datacenter']).toEqual({
      http: 50,
      socks: 51,
    });
  });

  // Mọi cổng trong bảng phải là cổng TCP hợp lệ, nếu không bảng tự vô hiệu.
  it('holds only valid TCP ports', () => {
    const entries = Object.entries(GpnipProvider.PRODUCT_PORTS);
    expect(entries.length).toBeGreaterThan(0);
    for (const [product, ports] of entries) {
      for (const n of [ports.http, ports.socks]) {
        expect(Number.isInteger(n)).toBe(true);
        expect(n).toBeGreaterThanOrEqual(1);
        expect(n).toBeLessThanOrEqual(65535);
      }
      // Khoá viết bằng gạch ngang, chữ thường — `portsFor` chuẩn hoá về dạng này.
      expect(product).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
  });
});

/**
 * Cổng do MÌNH khai ở dịch vụ, không chờ nhà cung cấp trả về.
 *
 * Thứ tự ưu tiên: cổng admin khai > cổng đơn trả về > bảng theo sản phẩm.
 * Admin khai là lựa chọn tường minh của con người, và có sản phẩm dùng cả một
 * DẢI cổng (Residential Pool 10000–10009) nên nhà cung cấp trả cổng nào cũng
 * chỉ là một cổng trong dải.
 */
describe('GpnipProvider admin-configured ports', () => {
  let provider: GpnipProvider;
  let fetchMock: jest.Mock;
  const originalFetch = global.fetch;
  const testToken = 'test-only-gpnip-key';

  const order = (proxy: Record<string, unknown>, proxy_type?: string) =>
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          status: 1,
          proxy_type,
          proxies: [{ host: 'gw.example.test', username: 'u', password: 'p', ...proxy }],
        },
      }),
    });

  beforeEach(() => {
    provider = new GpnipProvider();
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    jest.spyOn((provider as any).logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('uses the admin port even when the order returns a different one', async () => {
    order({ port_http: 8080, port_socks: 1080 }, 'residential');
    const [p] = await provider.fetchOrderProxies(testToken, '9', {
      protocol: 'socks5',
      ports: { http: 10005, socks: 11005 },
    });
    expect(p.port).toBe(11005);
    expect(p.provider_metadata).toEqual({ port_http: 10005, port_socks: 11005 });
  });

  // Đơn KHÔNG trả cổng nào, bảng cũng không có khoá — admin khai là đủ để chạy.
  it('works with no provider port and no table entry at all', async () => {
    order({}, 'mobile-usa');
    const [p] = await provider.fetchOrderProxies(testToken, '9', {
      protocol: 'socks5',
      ports: { http: 10000, socks: 11000 },
    });
    expect(p.port).toBe(11000);
  });

  // Khai một cổng, bỏ trống cổng kia: cổng bỏ trống vẫn đi theo đường cũ.
  it('falls back per port, not all or nothing', async () => {
    order({ port_http: 50, port_socks: 51 }, 'ipv6-datacenter');
    const [p] = await provider.fetchOrderProxies(testToken, '9');
    expect(p.provider_metadata).toEqual({ port_http: 50, port_socks: 51 });

    order({ port_http: 50, port_socks: 51 }, 'ipv6-datacenter');
    const [q] = await provider.fetchOrderProxies(testToken, '9', {
      ports: { socks: 61 },
    });
    // http vẫn lấy của nhà cung cấp, chỉ socks theo admin.
    expect(q.provider_metadata).toEqual({ port_http: 50, port_socks: 61 });
  });

  // 0 là cách admin XOÁ cấu hình, không phải một cổng hợp lệ.
  it.each([0, undefined, -1, 70000, NaN])(
    'treats an admin port of %p as not configured',
    async (bad) => {
      order({ port_http: 50, port_socks: 51 }, 'ipv6-datacenter');
      const [p] = await provider.fetchOrderProxies(testToken, '9', {
        ports: { http: bad as number },
      });
      expect(p.port).toBe(50);
    },
  );

  it('keeps the proxy identifier on the admin port', async () => {
    order({ port_http: 50 }, 'ipv6-datacenter');
    const [p] = await provider.fetchOrderProxies(testToken, '9', {
      ports: { http: 8080, socks: 1080 },
    });
    expect(p.provider_proxy_id).toBe('gpnip:9:gw.example.test:8080');
  });
});

/**
 * `resolveServicePorts` là cầu nối từ dịch vụ sang adapter. Nó chạy trong
 * đường cấp đơn, nên lỗi ở đây KHÔNG được làm gãy việc cấp proxy.
 */
describe('resolveServicePorts', () => {
  const withModel = (svc: unknown, spy?: jest.Mock) => ({
    service_id: { _id: 'svc-1' },
    $model: () => ({
      findById: spy ?? jest.fn(() => ({
        select: () => ({ lean: () => ({ exec: async () => svc }) }),
      })),
    }),
  });

  it('returns undefined when the order has no service', async () => {
    await expect(resolveServicePorts({ service_id: undefined })).resolves.toBeUndefined();
    await expect(resolveServicePorts(null)).resolves.toBeUndefined();
  });

  // Chưa khai gì thì phải trả undefined, không trả {http:0,socks:0} — 0 sẽ bị
  // adapter coi là "không khai" nhưng trả object làm caller tưởng có cấu hình.
  it('returns undefined when nothing is configured', async () => {
    await expect(
      resolveServicePorts(withModel({ port_http: 0, port_socks: 0 }) as any),
    ).resolves.toBeUndefined();
  });

  it('reads the configured ports', async () => {
    await expect(
      resolveServicePorts(withModel({ port_http: 8080, port_socks: 1080 }) as any),
    ).resolves.toEqual({ http: 8080, socks: 1080 });
  });

  it('returns one port when only one is configured', async () => {
    await expect(
      resolveServicePorts(withModel({ port_socks: 1080 }) as any),
    ).resolves.toEqual({ http: 0, socks: 1080 });
  });

  // Dich vu da populate san thi khong duoc goi DB lan nua.
  it('uses an already populated service without querying', async () => {
    const spy = jest.fn();
    await expect(
      resolveServicePorts({
        service_id: { port_http: 777, port_socks: 666 },
        $model: () => ({ findById: spy }),
      } as any),
    ).resolves.toEqual({ http: 777, socks: 666 });
    expect(spy).not.toHaveBeenCalled();
  });

  it('swallows a lookup failure instead of breaking provisioning', async () => {
    await expect(
      resolveServicePorts({
        service_id: { _id: 'svc-1' },
        $model: () => {
          throw new Error('mat ket noi');
        },
      } as any),
    ).resolves.toBeUndefined();
  });

  it('returns undefined when there is no model to query with', async () => {
    await expect(
      resolveServicePorts({ service_id: { _id: 'svc-1' } } as any),
    ).resolves.toBeUndefined();
  });
});
