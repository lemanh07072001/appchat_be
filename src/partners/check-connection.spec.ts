import { PartnersService } from './partners.service';
import { CheckProviderConnectionDto } from '../dto/check-provider-connection.dto';

/**
 * Kiểm tra kết nối phải phân biệt được hai chuyện khác hẳn nhau:
 * key sai (kết quả kiểm tra, hiện tại chỗ) và hệ thống hỏng (sự cố).
 *
 * `checkProviderConnection` chỉ đọc `partnerModel` khi cần lấy key đã lưu, nên
 * dựng prototype trần + model giả là đủ.
 */
describe('PartnersService.checkProviderConnection', () => {
  // Chỉ mượn đúng một method; `partnerModel` là private nên gán qua `any`.
  type CheckHost = Pick<PartnersService, 'checkProviderConnection'>;

  const makeService = (savedToken?: string): CheckHost => {
    const svc = Object.create(PartnersService.prototype) as CheckHost;
    (svc as any).partnerModel = {
      findById: () => ({
        select: () => ({
          lean: () => ({ exec: async () => (savedToken ? { token_api: savedToken } : null) }),
        }),
      }),
    };
    return svc;
  };

  const makeFactory = (opts: {
    has?: boolean;
    check?: (token: string) => Promise<any>;
  }) =>
    ({
      hasProvider: () => opts.has ?? true,
      getProvider: () => ({ checkConnection: opts.check }),
    }) as any;

  const dto = (over: Partial<CheckProviderConnectionDto> = {}): CheckProviderConnectionDto =>
    ({ code: 'omoproxy', token_api: 'omo_px_ok', ...over }) as CheckProviderConnectionDto;

  it('trả về số dư và độ trễ khi key đúng', async () => {
    const svc = makeService();
    const factory = makeFactory({
      check: async () => ({ account: 'a@b.com', balance: 142.81, currency: 'USD' }),
    });

    const res = await svc.checkProviderConnection(factory, dto());

    expect(res.ok).toBe(true);
    expect(res.account).toBe('a@b.com');
    expect(res.balance).toBe(142.81);
    expect(res.currency).toBe('USD');
    expect(typeof res.latency_ms).toBe('number');
  });

  it('key sai là KẾT QUẢ, không phải exception', async () => {
    const svc = makeService();
    const factory = makeFactory({
      check: async () => {
        throw new Error('OmoProxy API error: Unauthorized');
      },
    });

    const res = await svc.checkProviderConnection(factory, dto());

    expect(res.ok).toBe(false);
    expect(res.message).toContain('Unauthorized');
  });

  it('báo rõ khi code chưa có adapter', async () => {
    const svc = makeService();
    const res = await svc.checkProviderConnection(makeFactory({ has: false }), dto({ code: 'ncc-x' }));

    expect(res.ok).toBe(false);
    expect(res.message).toContain('ncc-x');
  });

  it('báo rõ khi adapter không hỗ trợ kiểm tra', async () => {
    const svc = makeService();
    const res = await svc.checkProviderConnection(makeFactory({ check: undefined }), dto());

    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/chưa hỗ trợ/);
  });

  it('dùng key đang lưu khi sửa mà không nhập lại key', async () => {
    const svc = makeService('omo_px_saved');
    let seen = '';
    const factory = makeFactory({
      check: async (token: string) => {
        seen = token;
        return { balance: 1 };
      },
    });

    const res = await svc.checkProviderConnection(
      factory,
      dto({ token_api: '', partner_id: '507f1f77bcf86cd799439011' }),
    );

    expect(res.ok).toBe(true);
    expect(seen).toBe('omo_px_saved');
  });

  it('từ chối khi không có key nào để kiểm tra', async () => {
    const svc = makeService();
    const factory = makeFactory({ check: async () => ({ balance: 1 }) });
    const res = await svc.checkProviderConnection(factory, dto({ token_api: '  ' }));

    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/API key/);
  });
});

describe('PartnersService.checkAllConnections', () => {
  type CheckAllHost = Pick<PartnersService, 'checkAllConnections' | 'checkProviderConnection'>;

  const makeService = (partners: { _id: string; code: string; token_api: string }[]) => {
    const svc = Object.create(PartnersService.prototype) as CheckAllHost;
    (svc as any).partnerModel = {
      find: () => ({
        select: () => ({ lean: () => ({ exec: async () => partners }) }),
      }),
    };
    return svc;
  };

  const factoryFor = (results: Record<string, 'ok' | 'fail'>) =>
    ({
      hasProvider: () => true,
      getProvider: (code: string) => ({
        checkConnection: async () => {
          if (results[code] === 'fail') throw new Error(`${code}: Unauthorized`);
          return { balance: 100, currency: 'USD' };
        },
      }),
    }) as any;

  it('trả kết quả cho từng nhà cung cấp, kèm partner_id để ghép vào bảng', async () => {
    const svc = makeService([
      { _id: 'a1', code: 'omoproxy', token_api: 'k1' },
      { _id: 'b2', code: 'homeproxy', token_api: 'k2' },
    ]);

    const res = await svc.checkAllConnections(factoryFor({}), undefined);

    expect(res).toHaveLength(2);
    expect(res.map((r) => r.partner_id)).toEqual(['a1', 'b2']);
    expect(res.every((r) => r.ok)).toBe(true);
  });

  it('một nhà cung cấp hỏng không kéo cả bảng đổ theo', async () => {
    const svc = makeService([
      { _id: 'a1', code: 'omoproxy', token_api: 'k1' },
      { _id: 'b2', code: 'homeproxy', token_api: 'k2' },
    ]);

    const res = await svc.checkAllConnections(factoryFor({ homeproxy: 'fail' }), undefined);

    expect(res.find((r) => r.partner_id === 'a1')?.ok).toBe(true);
    expect(res.find((r) => r.partner_id === 'b2')?.ok).toBe(false);
    expect(res.find((r) => r.partner_id === 'b2')?.message).toContain('Unauthorized');
  });

  it('id toàn rác thì trả mảng rỗng, không quét cả bảng', async () => {
    const svc = makeService([{ _id: 'a1', code: 'omoproxy', token_api: 'k1' }]);
    const res = await svc.checkAllConnections(factoryFor({}), ['khong-phai-objectid']);
    expect(res).toEqual([]);
  });
});
