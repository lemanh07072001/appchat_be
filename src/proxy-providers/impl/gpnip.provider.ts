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
 * GPNIP — nhà cung cấp proxy bán theo dung lượng (GB), cấu trúc API gần giống
 * OmoProxy nên adapter đi theo đúng pattern của `omoproxy.provider.ts`.
 *
 * `POST /orders` chấp nhận `{ packageId, duration, gb, country, ips, pool,
 * voucher_code }` nhưng tài liệu không nói rõ tham số nào bắt buộc cho từng
 * loại gói — cũng như OmoProxy, body lấy từ `service.body_api` do admin khai,
 * adapter chỉ điền hộ `packageId` khi thiếu để tránh đoán tham số giá bằng
 * tiền thật của khách.
 *
 * Xoay IP và huỷ đơn: nhà cung cấp không có endpoint tương ứng.
 */
@ProxyProvider('gpnip')
export class GpnipProvider implements IProxyProvider {
  readonly capabilities = { buy: true, renew: true, rotate: false, cancel: false };

  private readonly logger = new Logger(GpnipProvider.name);
  private readonly BASE_URL = 'https://api.omoproxy.com/v1';
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
          ? `GPNIP API timeout sau ${this.TIMEOUT_MS}ms`
          : `GPNIP network error: ${err?.message}`,
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
      throw new BadRequestException(`GPNIP API error: ${msg}`);
    }

    return payload.data as T;
  }

  // ─── Mua ─────────────────────────────────────────────────────────────────────

  /**
   * `POST /orders` — body `{ packageId, duration, gb, country, ips, pool,
   * voucher_code }`. Adapter KHÔNG tự điền tham số giá (`gb`/`ips`/...):
   * `ProviderBuyParams` không mang đủ thông tin để suy ra đúng gói, suy đoán
   * nghĩa là mua sai bằng tiền thật. Admin khai body ở `service.body_api`,
   * adapter chỉ điền hộ `packageId` khi thiếu (lấy từ `id_service`).
   *
   * Response `{ order_id, status }` — `status=1` mới là "active", nhưng nhà
   * cung cấp không cho biết endpoint nào để chờ tới lúc đó; đi theo đúng
   * pattern OmoProxy: thử lấy proxy MỘT LẦN ngay sau khi tạo đơn, lỗi thì nuốt
   * lại và để scheduler lấy lại sau — không chặn giao dịch chỉ vì đơn còn
   * pending ở phía nhà cung cấp.
   */
  async buy(params: ProviderBuyParams): Promise<BuyResult> {
    let body: Record<string, unknown> = {};
    if (params.body_api) {
      try {
        body = JSON.parse(params.body_api);
      } catch {
        throw new BadRequestException(
          'GPNIP: body_api của dịch vụ không phải JSON hợp lệ',
        );
      }
    }

    if (Object.keys(body).length === 0) {
      throw new BadRequestException(
        'GPNIP: chưa cấu hình body_api cho dịch vụ. ' +
          'Cần packageId lấy từ dashboard GPNIP kèm tham số giá của sản phẩm, ' +
          'ví dụ {"packageId":1,"gb":5,"country":"US"}',
      );
    }

    if (params.id_service && body.packageId === undefined) {
      body.packageId = params.id_service;
    }

    const data = await this.request<any>('POST', '/orders', params.token_api, body);

    const orderId = data?.order_id ?? data?.id ?? data?.order?.id;
    if (orderId == null) {
      throw new BadRequestException(
        `GPNIP không trả về id đơn: ${JSON.stringify(data).slice(0, 200)}`,
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
        `GPNIP order ${orderId}: chưa lấy được proxy ngay — ${err?.message}`,
      );
      return [] as ProxyCredential[];
    });

    return {
      provider_order_id: String(orderId),
      proxies,
      provider_metadata: { status: data?.status },
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
      `/orders/${provider_order_id}/proxies?format=json`,
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
   * Response: `{ traffic, usage, remaining, unit: "GB", expired_at }`.
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
        `GPNIP trả lưu lượng bằng đơn vị "${data?.unit}", chỉ hỗ trợ GB`,
      );
    }

    const used = Number(data?.usage);
    if (!Number.isFinite(used) || used < 0) {
      throw new BadRequestException(
        `GPNIP trả usage không hợp lệ: ${JSON.stringify(data)}`,
      );
    }

    return { used_gb: used };
  }

  // ─── Kiểm tra kết nối ────────────────────────────────────────────────────────

  /**
   * `GET /me` — tài liệu ghi `{ id, email, username, balance, currency }`.
   * Không có số dư trong response thì BỎ TRỐNG, không trả 0 — admin đọc
   * "số dư 0" thành "ví đã cạn" rồi đi tìm lỗi không tồn tại.
   */
  async checkConnection(token_api: string): Promise<ProviderConnectionInfo> {
    interface MeResponse {
      id?: string | number;
      email?: string;
      username?: string;
      balance?: number;
      currency?: string;
    }

    const data = await this.request<MeResponse>('GET', '/me', token_api);

    const rawBalance = data?.balance;
    const balance = Number(rawBalance);
    const hasBalance = rawBalance != null && Number.isFinite(balance);

    return {
      account: data?.email ?? data?.username,
      ...(hasBalance ? { balance, currency: data?.currency ?? 'USD' } : {}),
    };
  }

  // ─── Nạp thêm dung lượng ─────────────────────────────────────────────────────

  /**
   * `POST /orders/{id}/extend` — body `{ gb }`, tối thiểu 0.1 GB.
   *
   * Chặn dưới 0.1 GB ngay tại đây: `OrdersService.topUpBandwidth()` đã trừ tiền
   * khách TRƯỚC khi gọi, nên thà ném lỗi để nó hoàn tiền còn hơn để nhà cung
   * cấp trả lỗi sau khi ví đã bị trừ.
   */
  async extendBandwidth(
    token_api: string,
    provider_order_id: string,
    gb: number,
  ): Promise<{ raw?: any }> {
    if (!provider_order_id) {
      throw new BadRequestException('GPNIP: đơn chưa có provider_order_id để nạp thêm');
    }

    if (!Number.isFinite(gb) || gb < 0.1) {
      throw new BadRequestException(
        `GPNIP: số GB nạp thêm phải ≥ 0.1, nhận được ${gb}`,
      );
    }

    const data = await this.request<{ traffic?: number }>(
      'POST',
      `/orders/${provider_order_id}/extend`,
      token_api,
      { gb },
    );

    return { raw: data };
  }

  // ─── Gia hạn ─────────────────────────────────────────────────────────────────

  /**
   * `POST /orders/{id}/renew` — nhà cung cấp nhận `duration` là chuỗi dạng
   * `"N_days"` (vd `"30_days"`, `"90_days"`), khớp trực tiếp với
   * `duration_days` mà hệ thống bán — không cần quy đổi bậc như OmoProxy.
   *
   * Vẫn giữ đúng pattern preview-rồi-chốt của OmoProxy: gọi `preview: true`
   * trước (chỉ báo giá, KHÔNG trừ tiền), đối chiếu số ngày họ trả về với số
   * ngày khách đã mua, lệch thì dừng — lúc này `OrdersService` sẽ hoàn tiền vì
   * chưa có request nào tiêu tiền chạy.
   *
   * Bậc suy ra không khớp cách nhà cung cấp đánh số thì admin ghi đè bằng
   * `provider_metadata.renew_duration` trên đơn, không cần sửa code.
   */
  async renew(params: ProviderRenewParams): Promise<RenewResult> {
    const { token_api, provider_order_id, duration_days } = params;

    if (!provider_order_id) {
      throw new BadRequestException('GPNIP: đơn chưa có provider_order_id để gia hạn');
    }

    // Số ngày là mẫu số của mọi kiểm tra bên dưới. Để lọt 0 vào đây thì
    // `|days - 0|` khớp với mọi phản hồi rỗng và bài kiểm tra thành vô dụng.
    if (!Number.isFinite(duration_days) || duration_days < 1) {
      throw new BadRequestException(
        `GPNIP: số ngày gia hạn không hợp lệ (${duration_days})`,
      );
    }

    const override = params.provider_metadata?.renew_duration;
    const duration = override != null ? String(override) : `${duration_days}_days`;

    const path = `/orders/${provider_order_id}/renew`;

    interface RenewResponse {
      duration?: string;
      days?: number;
      price?: number;
      expired_at?: string;
    }

    // ① Báo giá — miễn phí, và là chỗ duy nhất biết được bậc này thật sự dài bao nhiêu ngày.
    const preview = await this.request<RenewResponse>('POST', path, token_api, {
      duration,
      preview: true,
    });

    // `Number(null)` là 0 chứ không phải NaN — kiểm tra null tách riêng, nếu
    // không thì "thiếu số ngày" bị hiểu thành "gia hạn 0 ngày".
    const previewDays = preview?.days == null ? NaN : Number(preview.days);
    if (!Number.isFinite(previewDays)) {
      throw new BadRequestException(
        `GPNIP: preview gia hạn không trả về số ngày (${JSON.stringify(preview).slice(0, 200)}). ` +
          'Không xác minh được bậc gói thì dừng, đừng trừ tiền khách.',
      );
    }

    // Duration đã khớp trực tiếp theo ngày nên dung sai chỉ để chừa sai số
    // làm tròn tháng/tuần phía nhà cung cấp, không cần biên độ rộng như
    // OmoProxy (bậc theo tháng).
    const tolerance = 1;
    if (Math.abs(previewDays - duration_days) > tolerance) {
      throw new BadRequestException(
        `GPNIP: bậc gia hạn "${duration}" cho ${previewDays} ngày nhưng đơn bán ${duration_days} ngày. ` +
          'Đặt provider_metadata.renew_duration cho đúng bậc của nhà cung cấp rồi thử lại.',
      );
    }

    // ② Chốt — tới đây mới thật sự tiêu tiền.
    const data = await this.request<RenewResponse>('POST', path, token_api, { duration });

    const expiredAt = data?.expired_at ? new Date(data.expired_at) : undefined;

    return {
      success: true,
      new_end_date:
        expiredAt && !Number.isNaN(expiredAt.getTime()) ? expiredAt : undefined,
      raw: data,
    };
  }

  // ─── Không có endpoint tương ứng ─────────────────────────────────────────────

  async rotate(_params: ProviderRotateParams): Promise<RotateResult> {
    throw new BadRequestException('GPNIP: không có API xoay IP');
  }

  async cancel(_params: ProviderCancelParams): Promise<void> {
    throw new BadRequestException('GPNIP: không có API huỷ đơn');
  }
}
