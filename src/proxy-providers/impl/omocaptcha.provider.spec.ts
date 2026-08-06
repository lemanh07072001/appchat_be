import { BadRequestException } from '@nestjs/common';
import { OmocaptchaProvider } from './omocaptcha.provider';

/**
 * `fetchUsage` là con số quyết định lúc nào đơn của khách bị dừng. Sai đơn vị
 * hoặc nuốt dữ liệu rác ở đây là tính sai dung lượng khách đã trả tiền.
 */
describe('OmocaptchaProvider', () => {
  let provider: OmocaptchaProvider;
  const realFetch = global.fetch;

  const mockJson = (payload: unknown, ok = true) => {
    global.fetch = jest.fn().mockResolvedValue({
      ok,
      status: ok ? 200 : 400,
      json: async () => payload,
    }) as unknown as typeof fetch;
  };

  beforeEach(() => {
    provider = new OmocaptchaProvider();
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  describe('fetchUsage', () => {
    it('đọc số GB đã dùng từ envelope { success, data }', async () => {
      mockJson({
        success: true,
        data: { traffic: 50, usage: 17.25, remaining: 32.75, unit: 'GB' },
      });
      await expect(provider.fetchUsage('tok', '481')).resolves.toEqual({ used_gb: 17.25 });
    });

    it('nhận usage = 0 là hợp lệ, không nhầm với thiếu dữ liệu', async () => {
      mockJson({ success: true, data: { traffic: 10, usage: 0, unit: 'GB' } });
      await expect(provider.fetchUsage('tok', '481')).resolves.toEqual({ used_gb: 0 });
    });

    it('từ chối đơn vị khác GB thay vì ghi số sai đơn vị vào đơn', async () => {
      mockJson({ success: true, data: { usage: 17000, unit: 'MB' } });
      await expect(provider.fetchUsage('tok', '481')).rejects.toThrow(BadRequestException);
    });

    it('từ chối usage thiếu hoặc không phải số', async () => {
      mockJson({ success: true, data: { traffic: 50, unit: 'GB' } });
      await expect(provider.fetchUsage('tok', '481')).rejects.toThrow(BadRequestException);

      mockJson({ success: true, data: { usage: 'nhiều', unit: 'GB' } });
      await expect(provider.fetchUsage('tok', '481')).rejects.toThrow(BadRequestException);
    });

    it('ném lỗi kèm message của nhà cung cấp khi success = false', async () => {
      mockJson({ success: false, error: { code: 404, message: 'Đơn không tồn tại' } });
      await expect(provider.fetchUsage('tok', '999')).rejects.toThrow('Đơn không tồn tại');
    });

    it('gửi Bearer token đúng chỗ', async () => {
      mockJson({ success: true, data: { usage: 1, unit: 'GB' } });
      await provider.fetchUsage('omo_px_abc', '481');

      const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
      expect(url).toContain('/orders/481/usage');
      expect(init.headers.Authorization).toBe('Bearer omo_px_abc');
    });
  });

  describe('fetchOrderProxies', () => {
    const payload = {
      success: true,
      data: {
        format: 'host:port:user:pass',
        proxies: [
          { host: '1.2.3.4', port_http: 8080, port_socks: 1080, username: 'u', password: 'p' },
        ],
      },
    };

    it('lấy cổng HTTP theo mặc định', async () => {
      mockJson(payload);
      const [proxy] = await provider.fetchOrderProxies('tok', '481');
      expect(proxy).toMatchObject({ host: '1.2.3.4', port: 8080, protocol: 'http' });
    });

    it('lấy cổng SOCKS khi đơn chọn socks5', async () => {
      mockJson(payload);
      const [proxy] = await provider.fetchOrderProxies('tok', '481', { protocol: 'socks5' });
      expect(proxy).toMatchObject({ port: 1080, protocol: 'socks5' });
      // Giữ cả hai cổng để đổi giao thức sau không phải gọi lại API.
      expect(proxy.provider_metadata).toEqual({ port_http: 8080, port_socks: 1080 });
    });
  });

  describe('buy', () => {
    it('từ chối khi dịch vụ chưa cấu hình body_api', async () => {
      mockJson({ success: true, data: { id: 1 } });
      await expect(
        provider.buy({ token_api: 'tok', quantity: 1, duration_days: 0 }),
      ).rejects.toThrow(/body_api/);
    });

    it('từ chối body_api không phải JSON', async () => {
      mockJson({ success: true, data: { id: 1 } });
      await expect(
        provider.buy({ token_api: 'tok', quantity: 1, duration_days: 0, body_api: '{id:' }),
      ).rejects.toThrow(/JSON/);
    });
  });

  describe('năng lực chưa xác minh', () => {
    it('renew ném lỗi nói rõ còn thiếu gì', async () => {
      await expect(
        provider.renew({ token_api: 'tok', provider_order_id: '1', duration_days: 30 }),
      ).rejects.toThrow(/chưa xác minh/);
    });

    it('chưa implement extendBandwidth nên nút nạp GB vẫn phải tắt', () => {
      // Đỏ khi ai đó implement — lúc đó nhớ xác minh body thật trước.
      expect((provider as any).extendBandwidth).toBeUndefined();
    });
  });
});
