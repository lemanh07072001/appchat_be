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
 * OmoProxy — nhà cung cấp proxy residential bán theo dung lượng (GB).
 *
 * Body của `/orders/{id}/renew` và `/orders/{id}/extend` đã đối chiếu tài liệu
 * chính thức của nhà cung cấp; `POST /orders` thì tài liệu ghi tham số giá
 * (`gb` / `quantity` / `duration`) là "tuỳ sản phẩm", nên `buy()` vẫn lấy body
 * từ `service.body_api` do admin nhập — adapter không có cách nào biết sản phẩm
 * này bán theo GB hay theo số lượng, và đoán nghĩa là mua sai bằng tiền thật.
 *
 * Xoay IP và huỷ đơn: nhà cung cấp không có endpoint tương ứng.
 */
@ProxyProvider('omoproxy')
export class OmoproxyProvider implements IProxyProvider {
  readonly capabilities = { buy: true, renew: true, rotate: false, cancel: false };

  private readonly logger = new Logger(OmoproxyProvider.name);
  // Host cũ `be.omocaptcha.com/apiv2/proxy-api/v1` vẫn đang chạy và vẫn trả
  // đúng envelope `{success:false,error:{code:"UNAUTHENTICATED"}}`, nên gọi
  // nhầm vào đó trông y hệt lỗi sai API key — mất hẳn một buổi mới lần ra.
  // Đừng đổi lại trừ khi nhà cung cấp thông báo, và đổi thì sửa cả test ghim
  // URL ở dưới.
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
          ? `OmoProxy API timeout sau ${this.TIMEOUT_MS}ms`
          : `OmoProxy network error: ${err?.message}`,
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
      throw new BadRequestException(`OmoProxy API error: ${msg}`);
    }

    return payload.data as T;
  }

  // ─── Mua ─────────────────────────────────────────────────────────────────────

  /**
   * `POST /orders` — body `{ id, gb | quantity | duration }`, trong đó `id` là
   * id gói bắt buộc còn tham số giá thì tuỳ sản phẩm. Adapter KHÔNG tự điền
   * tham số giá: `ProviderBuyParams` không mang số GB (worker chỉ truyền
   * `quantity`/`duration_days`, số GB nằm ở `order.bandwidth_gb`), nên suy ra
   * `gb` từ `quantity` là mua sai dung lượng bằng tiền thật. Admin khai body ở
   * `service.body_api`; adapter chỉ điền hộ `id` khi thiếu.
   */
  async buy(params: ProviderBuyParams): Promise<BuyResult> {
    let body: Record<string, unknown> = {};
    if (params.body_api) {
      try {
        body = JSON.parse(params.body_api);
      } catch {
        throw new BadRequestException(
          'OmoProxy: body_api của dịch vụ không phải JSON hợp lệ',
        );
      }
    }

    if (Object.keys(body).length === 0) {
      throw new BadRequestException(
        'OmoProxy: chưa cấu hình body_api cho dịch vụ. ' +
          'Cần id gói lấy từ dashboard OmoProxy kèm tham số giá của sản phẩm, ' +
          'ví dụ {"id":1,"gb":5}',
      );
    }

    if (params.id_service && body.id === undefined) body.id = params.id_service;

    const data = await this.request<any>('POST', '/orders', params.token_api, body);

    // Tài liệu: `{ order_id, status }`. Giữ vài fallback vì response cũ từng
    // thấy đặt id ở chỗ khác.
    const orderId = data?.order_id ?? data?.id ?? data?.order?.id;
    if (orderId == null) {
      throw new BadRequestException(
        `OmoProxy không trả về id đơn: ${JSON.stringify(data).slice(0, 200)}`,
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
        `OmoProxy order ${orderId}: chưa lấy được proxy ngay — ${err?.message}`,
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
        `OmoProxy trả lưu lượng bằng đơn vị "${data?.unit}", chỉ hỗ trợ GB`,
      );
    }

    const used = Number(data?.usage);
    if (!Number.isFinite(used) || used < 0) {
      throw new BadRequestException(
        `OmoProxy trả usage không hợp lệ: ${JSON.stringify(data)}`,
      );
    }

    return { used_gb: used };
  }

  // ─── Kiểm tra kết nối ────────────────────────────────────────────────────────

  /**
   * `GET /me`. Tài liệu chỉ hứa `{ id, email, username }`; bản chạy thật còn
   * trả thêm `balance` / `voucher` / `total_available` / `currency`.
   *
   * Ưu tiên `total_available` (số dư + voucher) vì đó mới là số tiền thực sự
   * tiêu được. Không có số dư trong response thì BỎ TRỐNG, không trả 0 — admin
   * đọc "số dư 0" thành "ví đã cạn" rồi đi tìm lỗi không tồn tại.
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

    const rawBalance = data?.total_available ?? data?.balance;
    const balance = Number(rawBalance);
    const hasBalance = rawBalance != null && Number.isFinite(balance);

    return {
      account: data?.email ?? data?.username,
      ...(hasBalance ? { balance, currency: data?.currency ?? 'USD' } : {}),
    };
  }

  // ─── Nạp thêm dung lượng ─────────────────────────────────────────────────────

  /**
   * `POST /orders/{id}/extend` — body `{ gb }`, tối thiểu 0.1 GB, response
   * `{ traffic }` = tổng dung lượng sau khi nạp.
   *
   * Chặn dưới 0.1 GB ngay tại đây: `OrdersService.topUpBandwidth()` đã trừ tiền
   * khách TRƯỚC khi gọi, nên thà ném lỗi để nó hoàn tiền còn hơn để nhà cung
   * cấp trả 422 sau khi ví đã bị trừ.
   */
  async extendBandwidth(
    token_api: string,
    provider_order_id: string,
    gb: number,
  ): Promise<{ raw?: any }> {
    if (!provider_order_id) {
      throw new BadRequestException('OmoProxy: đơn chưa có provider_order_id để nạp thêm');
    }

    if (!Number.isFinite(gb) || gb < 0.1) {
      throw new BadRequestException(
        `OmoProxy: số GB nạp thêm phải ≥ 0.1, nhận được ${gb}`,
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
   * `POST /orders/{id}/renew` — nhà cung cấp nhận `duration` là **bậc gói dạng
   * chuỗi** tính theo tháng (`"1"`, `"3"`, `"6"`), KHÔNG phải số ngày. Hệ thống
   * lại bán theo ngày (`service.pricing[duration_days]`), nên phải quy đổi.
   *
   * Quy đổi sai bậc = khách trả tiền 90 ngày mà chỉ nhận 30. Vì vậy luôn gọi
   * `preview: true` trước (tài liệu ghi rõ: chỉ báo giá, KHÔNG trừ tiền), đối
   * chiếu `days` họ trả về với số ngày khách đã mua, lệch quá thì dừng — lúc
   * này `OrdersService` sẽ hoàn tiền vì chưa có request nào tiêu tiền chạy.
   *
   * Bậc suy ra không khớp cách nhà cung cấp đánh số thì admin ghi đè bằng
   * `provider_metadata.renew_duration` trên đơn, không cần sửa code.
   */
  async renew(params: ProviderRenewParams): Promise<RenewResult> {
    const { token_api, provider_order_id, duration_days } = params;

    if (!provider_order_id) {
      throw new BadRequestException('OmoProxy: đơn chưa có provider_order_id để gia hạn');
    }

    // Số ngày là mẫu số của mọi kiểm tra bên dưới. Để lọt 0 vào đây thì
    // `|days - 0|` khớp với mọi phản hồi rỗng và bài kiểm tra thành vô dụng.
    if (!Number.isFinite(duration_days) || duration_days < 1) {
      throw new BadRequestException(
        `OmoProxy: số ngày gia hạn không hợp lệ (${duration_days})`,
      );
    }

    const override = params.provider_metadata?.renew_duration;
    const months = Math.max(1, Math.round(duration_days / 30));
    const duration = override != null ? String(override) : String(months);

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
        `OmoProxy: preview gia hạn không trả về số ngày (${JSON.stringify(preview).slice(0, 200)}). ` +
          'Không xác minh được bậc gói thì dừng, đừng trừ tiền khách.',
      );
    }

    // ponytail: dung sai = max(3, số tháng) ngày vì tháng dương lịch dài ngắn
    // khác nhau (6 tháng = 181–184 ngày). Nếu nhà cung cấp đổi sang bậc theo
    // tuần/ngày thì siết lại bằng bảng ánh xạ khai trong service config.
    const tolerance = Math.max(3, months);
    if (Math.abs(previewDays - duration_days) > tolerance) {
      throw new BadRequestException(
        `OmoProxy: bậc gia hạn "${duration}" cho ${previewDays} ngày nhưng đơn bán ${duration_days} ngày. ` +
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
    throw new BadRequestException('OmoProxy: không có API xoay IP');
  }

  async cancel(_params: ProviderCancelParams): Promise<void> {
    throw new BadRequestException('OmoProxy: không có API huỷ đơn');
  }
}
