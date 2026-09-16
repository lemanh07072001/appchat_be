import { BadRequestException } from '@nestjs/common';
import { HomeproxyProvider } from './homeproxy.provider';

/**
 * `checkConnection` là thứ duy nhất chặn giữa "admin gõ nhầm key" và "khách
 * đặt đơn rồi mới phát hiện". Trước khi có method này, nút Kiểm tra kết nối
 * không hiện, key sai được lưu im lặng.
 */
describe('HomeproxyProvider.checkConnection', () => {
  let provider: HomeproxyProvider;
  const realFetch = global.fetch;

  const mockFetch = (status: number, payload: unknown) => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    }) as unknown as typeof fetch;
  };

  beforeEach(() => {
    provider = new HomeproxyProvider();
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  it('key đúng → không ném lỗi', async () => {
    mockFetch(200, { data: [], total: 0 });
    await expect(provider.checkConnection('token-that')).resolves.toBeDefined();
  });

  it('gọi endpoint chỉ-đọc bằng GET, kèm Bearer token', async () => {
    mockFetch(200, { data: [] });
    await provider.checkConnection('hp_token_abc');

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.homeproxy.vn/api/merchant/orders');
    // GET: kiểm tra key không được tạo ra bất cứ thứ gì bên nhà cung cấp.
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.headers.Authorization).toBe('Bearer hp_token_abc');
  });

  it('key sai → ném lỗi kèm nguyên văn message của nhà cung cấp', async () => {
    mockFetch(401, { message: 'Token invalid' });
    await expect(provider.checkConnection('token-sai')).rejects.toThrow(/Token invalid/);
  });

  it('không bịa số dư khi nhà cung cấp không có endpoint đó', async () => {
    // Thà để trống còn hơn hiện "0" — admin đọc số 0 thành ví đã cạn.
    mockFetch(200, { data: [] });
    const info = await provider.checkConnection('token-that');
    expect(info.balance).toBeUndefined();
    expect(info.currency).toBeUndefined();
  });

  it('lỗi mạng cũng thành kết quả kiểm tra, không làm sập request', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    await expect(provider.checkConnection('tok')).rejects.toThrow(BadRequestException);
  });
});
