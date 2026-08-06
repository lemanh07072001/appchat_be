import { BadRequestException, Logger } from '@nestjs/common';
import { ProxyProvider } from '../proxy-provider.decorator';
import {
  IProxyProvider,
  ProviderBuyParams,
  ProviderCancelParams,
  ProviderRenewParams,
  ProviderRotateParams,
  BuyResult,
  RenewResult,
  RotateResult,
  ProxyCredential,
  ProviderConnectionInfo,
} from '../proxy-provider.interface';

/**
 * OMOCaptcha — nhà cung cấp proxy residential bán theo dung lượng (GB).
 *
 * Trạng thái xác minh (bằng API key thật):
 *   ĐÃ XÁC MINH  GET /me · /orders · /orders/{id} · /orders/{id}/usage
 *                /orders/{id}/proxies
 *   CHƯA XÁC MINH  body của POST /orders, /orders/{id}/extend, /orders/{id}/renew
 *
 * Vì vậy `buy()` lấy body từ `service.body_api` do admin nhập — không đoán —
 * còn `renew()` và nạp thêm dung lượng thì chưa implement. Đoán body của một
 * endpoint tiêu tiền thật là cách nhanh nhất để mất tiền mà không ai biết.
 */
@ProxyProvider('omocaptcha')
export class OmocaptchaProvider implements IProxyProvider {
  // Chưa xác minh được body của /renew nên khai đúng là chưa gia hạn được.
  // Xoay IP và huỷ đơn thì OMOCaptcha không có endpoint tương ứng.
  readonly capabilities = { buy: true, renew: false, rotate: false, cancel: false };

  private readonly logger = new Logger(OmocaptchaProvider.name);
  private readonly BASE_URL = 'https://be.omocaptcha.com/apiv2/proxy-api/v1';
  private readonly TIMEOUT_MS = 30_000;

  // ─── Helper HTTP ─────────────────────────────────────────────────────────────

  /**
   * Mọi phản hồi bọc trong `{ success, data }`; lỗi là
   * `{ success: false, error: { code, message } }`.
   */
  private async request<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    token: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(`${this.BASE_URL}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err: any) {
      throw new BadRequestException(
        err?.name === 'AbortError'
          ? `OMOCaptcha API timeout sau ${this.TIMEOUT_MS}ms`
          : `OMOCaptcha network error: ${err?.message}`,
      );
    } finally {
      clearTimeout(timer);
    }

    const payload: any = await res.json().catch(() => ({}));

    if (!res.ok || payload?.success !== true) {
      const msg =
        payload?.error?.message ??
        payload?.message ??
        `HTTP ${res.status}`;
      throw new BadRequestException(`OMOCaptcha API error: ${msg}`);
    }

    return payload.data as T;
  }

  // ─── Mua ─────────────────────────────────────────────────────────────────────

  /**
   * Body của `POST /orders` chưa được xác minh, nên toàn bộ do admin nhập ở
   * `service.body_api` (JSON). Adapter chỉ thêm số GB vào — nếu template đã có
   * sẵn trường đó thì template thắng.
   */
  async buy(params: ProviderBuyParams): Promise<BuyResult> {
    let body: Record<string, unknown> = {};
    if (params.body_api) {
      try {
        body = JSON.parse(params.body_api);
      } catch {
        throw new BadRequestException(
          'OMOCaptcha: body_api của dịch vụ không phải JSON hợp lệ',
        );
      }
    }

    if (Object.keys(body).length === 0) {
      throw new BadRequestException(
        'OMOCaptcha: chưa cấu hình body_api cho dịch vụ. ' +
          'Cần id gói lấy từ dashboard OMOCaptcha, ví dụ {"id":"...","traffic":10}',
      );
    }

    if (params.id_service && body.id === undefined) body.id = params.id_service;

    const data = await this.request<any>('POST', '/orders', params.token_api, body);

    // Id đơn của họ là số nguyên. Chấp nhận vài chỗ đặt tên khác nhau vì response
    // của endpoint này chưa xác minh được.
    const orderId = data?.id ?? data?.order?.id ?? data?.order_id;
    if (orderId == null) {
      throw new BadRequestException(
        `OMOCaptcha không trả về id đơn: ${JSON.stringify(data).slice(0, 200)}`,
      );
    }

    const proxies = await this.fetchOrderProxies(
      params.token_api,
      String(orderId),
      { protocol: params.protocol },
    ).catch((err) => {
      // Đơn đã tạo bên họ rồi — đừng để việc đọc proxy thất bại làm hỏng cả
      // giao dịch. Scheduler sẽ lấy lại sau.
      this.logger.warn(
        `OMOCaptcha order ${orderId}: chưa lấy được proxy ngay — ${err?.message}`,
      );
      return [] as ProxyCredential[];
    });

    return {
      provider_order_id: String(orderId),
      proxies,
      provider_metadata: { uuid: data?.uuid, title: data?.title },
      raw: data,
    };
  }

  // ─── Đọc proxy của đơn ───────────────────────────────────────────────────────

  async fetchOrderProxies(
    token_api: string,
    provider_order_id: string,
    context?: { metadata?: Record<string, any>; protocol?: string },
  ): Promise<ProxyCredential[]> {
    interface ProxiesResponse {
      format?: string;
      proxies?: {
        host: string;
        port_http: number;
        port_socks: number;
        username: string;
        password: string;
      }[];
    }

    const data = await this.request<ProxiesResponse>(
      'GET',
      `/orders/${provider_order_id}/proxies`,
      token_api,
    );

    const wantSocks = (context?.protocol ?? '').toLowerCase().includes('socks');

    return (data?.proxies ?? []).map((p) => ({
      host: p.host,
      port: Number(wantSocks ? p.port_socks : p.port_http) || 0,
      username: p.username,
      password: p.password,
      protocol: wantSocks ? 'socks5' : 'http',
      // Giữ cả hai cổng để đổi giao thức sau này không phải gọi lại API.
      provider_metadata: { port_http: p.port_http, port_socks: p.port_socks },
    }));
  }

  // ─── Đọc lưu lượng đã dùng ───────────────────────────────────────────────────

  /**
   * Điểm cắm để `orders-bandwidth.scheduler.ts` cập nhật `bandwidth_used_gb`.
   * Response đã xác minh: `{ traffic, usage, remaining, unit: "GB", expired_at }`.
   */
  async fetchUsage(
    token_api: string,
    provider_order_id: string,
  ): Promise<{ used_gb: number }> {
    interface UsageResponse {
      traffic?: number;
      usage?: number;
      remaining?: number;
      unit?: string;
    }

    const data = await this.request<UsageResponse>(
      'GET',
      `/orders/${provider_order_id}/usage`,
      token_api,
    );

    const unit = (data?.unit ?? 'GB').toUpperCase();
    if (unit !== 'GB') {
      // Hệ thống lõi luôn làm việc bằng GB. Đơn vị lạ thì dừng, đừng âm thầm
      // ghi một con số sai đơn vị vào đơn của khách.
      throw new BadRequestException(
        `OMOCaptcha trả lưu lượng bằng đơn vị "${data?.unit}", chỉ hỗ trợ GB`,
      );
    }

    const used = Number(data?.usage);
    if (!Number.isFinite(used) || used < 0) {
      throw new BadRequestException(
        `OMOCaptcha trả usage không hợp lệ: ${JSON.stringify(data)}`,
      );
    }

    return { used_gb: used };
  }

  // ─── Kiểm tra kết nối ────────────────────────────────────────────────────────

  /**
   * `GET /me` — shape đã xác minh:
   * `{ id, email, username, balance, voucher, total_available, currency }`.
   *
   * Dùng `total_available` (số dư + voucher) làm số dư hiển thị, vì đó mới là
   * số tiền thực sự tiêu được.
   */
  async checkConnection(token_api: string): Promise<ProviderConnectionInfo> {
    interface MeResponse {
      email?: string;
      username?: string;
      balance?: number;
      total_available?: number;
      currency?: string;
    }

    const data = await this.request<MeResponse>('GET', '/me', token_api);

    return {
      account: data?.email ?? data?.username,
      balance: Number(data?.total_available ?? data?.balance) || 0,
      currency: data?.currency ?? 'USD',
    };
  }

  // ─── Chưa xác minh được body → chưa implement ────────────────────────────────

  async renew(_params: ProviderRenewParams): Promise<RenewResult> {
    throw new BadRequestException(
      'OMOCaptcha: chưa xác minh được body của POST /orders/{id}/renew',
    );
  }

  async rotate(_params: ProviderRotateParams): Promise<RotateResult> {
    throw new BadRequestException('OMOCaptcha: không có API xoay IP');
  }

  async cancel(_params: ProviderCancelParams): Promise<void> {
    throw new BadRequestException('OMOCaptcha: không có API huỷ đơn');
  }

  // CỐ Ý chưa implement `extendBandwidth`: endpoint POST /orders/{id}/extend có
  // tồn tại nhưng chưa biết tên trường mang số GB. Implement bằng cách đoán
  // nghĩa là gửi một request tiêu tiền thật mà không chắc nó làm gì. Khi xác
  // minh được, thêm method vào đây là nút "Nạp thêm GB" tự bật.
}
