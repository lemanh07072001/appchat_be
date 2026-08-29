import { BadRequestException } from '@nestjs/common';
import { OmoproxyProvider } from './omoproxy.provider';

/**
 * `fetchUsage` là con số quyết định lúc nào đơn của khách bị dừng. Sai đơn vị
 * hoặc nuốt dữ liệu rác ở đây là tính sai dung lượng khách đã trả tiền.
 */
describe('OmoproxyProvider', () => {
  let provider: OmoproxyProvider;
  const realFetch = global.fetch;

  const mockJson = (payload: unknown, ok = true) => {
    global.fetch = jest.fn().mockResolvedValue({
      ok,
      status: ok ? 200 : 400,
      json: async () => payload,
    }) as unknown as typeof fetch;
  };

  beforeEach(() => {
    provider = new OmoproxyProvider();
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

  describe('extendBandwidth', () => {
    it('gửi đúng { gb } tới /extend', async () => {
      mockJson({ success: true, data: { traffic: 15 } });
      await provider.extendBandwidth('tok', '481', 5);

      const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
      expect(url).toContain('/orders/481/extend');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ gb: 5 });
    });

    it('chặn dưới mức tối thiểu 0.1 GB trước khi gọi API', async () => {
      mockJson({ success: true, data: { traffic: 15 } });
      await expect(provider.extendBandwidth('tok', '481', 0.05)).rejects.toThrow(
        BadRequestException,
      );
      // Tiền khách đã bị trừ trước khi vào đây — không được gửi request rác.
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('từ chối đơn chưa có provider_order_id thay vì gọi /orders//extend', async () => {
      mockJson({ success: true, data: { traffic: 15 } });
      await expect(provider.extendBandwidth('tok', '', 5)).rejects.toThrow(
        BadRequestException,
      );
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('renew', () => {
    /** Trả lần lượt từng payload cho từng lần fetch. */
    const mockSeq = (...payloads: unknown[]) => {
      const fn = jest.fn();
      for (const p of payloads) {
        fn.mockResolvedValueOnce({ ok: true, status: 200, json: async () => p });
      }
      global.fetch = fn as unknown as typeof fetch;
      return fn;
    };

    const ok = (days: number, expired = '2026-09-01T00:00:00+07:00') => ({
      success: true,
      data: { duration: '1', days, price: 5, expired_at: expired },
    });

    it('báo giá trước rồi mới chốt, quy đổi 90 ngày → bậc "3"', async () => {
      const fetchMock = mockSeq(ok(90), ok(90, '2026-10-01T00:00:00+07:00'));

      const res = await provider.renew({
        token_api: 'tok',
        provider_order_id: '481',
        duration_days: 90,
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
        duration: '3',
        preview: true,
      });
      // Lần chốt KHÔNG được mang preview, nếu không thì chẳng gia hạn gì cả.
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ duration: '3' });
      expect(res.success).toBe(true);
      expect(res.new_end_date).toEqual(new Date('2026-10-01T00:00:00+07:00'));
    });

    it('preview lệch số ngày thì dừng, KHÔNG gọi request tiêu tiền', async () => {
      // Đơn bán 90 ngày nhưng bậc suy ra chỉ cho 30 → khách sẽ mất 60 ngày.
      const fetchMock = mockSeq(ok(30));

      await expect(
        provider.renew({ token_api: 'tok', provider_order_id: '481', duration_days: 90 }),
      ).rejects.toThrow(/90 ngày/);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('chấp nhận lệch trong dung sai của tháng dương lịch (6 tháng = 184 ngày)', async () => {
      const fetchMock = mockSeq(ok(184), ok(184));
      await expect(
        provider.renew({ token_api: 'tok', provider_order_id: '481', duration_days: 180 }),
      ).resolves.toMatchObject({ success: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('preview thiếu days thì dừng thay vì tiêu tiền mù', async () => {
      const fetchMock = mockSeq({ success: true, data: { price: 5 } });

      await expect(
        provider.renew({ token_api: 'tok', provider_order_id: '481', duration_days: 30 }),
      ).rejects.toThrow(BadRequestException);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('days = null vẫn là thiếu dữ liệu, không phải "0 ngày"', async () => {
      // Number(null) === 0, nên nếu không tách null ra thì đơn 0 ngày sẽ khớp
      // với phản hồi rỗng và chốt tiền thật.
      const fetchMock = mockSeq({ success: true, data: { days: null, price: 5 } });

      await expect(
        provider.renew({ token_api: 'tok', provider_order_id: '481', duration_days: 30 }),
      ).rejects.toThrow(/không trả về số ngày/);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('từ chối duration_days = 0 trước khi gọi API', async () => {
      // Với 0 ngày thì phép so |days - 0| khớp mọi phản hồi rỗng → bài kiểm tra vô dụng.
      mockJson(ok(30));
      await expect(
        provider.renew({ token_api: 'tok', provider_order_id: '481', duration_days: 0 }),
      ).rejects.toThrow(/số ngày gia hạn không hợp lệ/);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('admin ghi đè được bậc qua provider_metadata.renew_duration', async () => {
      const fetchMock = mockSeq(ok(30), ok(30));

      await provider.renew({
        token_api: 'tok',
        provider_order_id: '481',
        duration_days: 30,
        provider_metadata: { renew_duration: 'monthly' },
      });

      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
        duration: 'monthly',
        preview: true,
      });
    });

    it('từ chối đơn chưa có provider_order_id', async () => {
      mockJson(ok(30));
      await expect(
        provider.renew({ token_api: 'tok', provider_order_id: '', duration_days: 30 }),
      ).rejects.toThrow(BadRequestException);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('checkConnection', () => {
    it('bỏ trống số dư khi /me không trả về, thay vì báo 0', async () => {
      mockJson({ success: true, data: { id: 1, email: 'a@b.c', username: 'ab' } });
      const info = await provider.checkConnection('tok');
      expect(info).toEqual({ account: 'a@b.c' });
    });

    it('ưu tiên total_available khi có', async () => {
      mockJson({
        success: true,
        data: { email: 'a@b.c', balance: 3, total_available: 7.5, currency: 'USD' },
      });
      await expect(provider.checkConnection('tok')).resolves.toEqual({
        account: 'a@b.c',
        balance: 7.5,
        currency: 'USD',
      });
    });
  });

  describe('capabilities', () => {
    it('khai gia hạn được để admin bật nút Gia hạn', () => {
      expect(provider.capabilities).toMatchObject({ buy: true, renew: true });
    });
  });
});
