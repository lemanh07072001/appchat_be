import { BadRequestException, Logger } from '@nestjs/common';
import { isIP } from 'net';
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

/** GPNIP reseller API — docs prod https://app.gpnip.com/vi/proxy/api,
 * docs dev https://dev-app.gpnip.com/en/proxy/api. Hai môi trường dùng chung
 * một hợp đồng API, chỉ khác host — chọn bằng env `GPNIP_BASE_URL`.
 * Provisioning is asynchronous. No documented purchase idempotency support.
 */
@ProxyProvider('gpnip')
export class GpnipProvider implements IProxyProvider {
  readonly capabilities = {
    buy: true,
    renew: true,
    rotate: false,
    cancel: false,
  };

  readonly retryBuy = false;

  private readonly logger = new Logger(GpnipProvider.name);
  /**
   * Mặc định là prod. Đổi môi trường bằng env chứ không sửa code.
   *
   * Env sai định dạng thì NÉM NGAY lúc khởi động, không âm thầm rơi về prod:
   * một lần test tưởng là dev mà chạy vào prod là một đơn bằng tiền thật.
   */
  private readonly BASE_URL = GpnipProvider.resolveBaseUrl();
  private readonly TIMEOUT_MS = 30_000;

  static resolveBaseUrl(): string {
    const raw = process.env.GPNIP_BASE_URL?.trim();
    if (!raw) return 'https://api.gpnip.com/api/v1/reseller';

    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`GPNIP_BASE_URL không phải URL hợp lệ: "${raw}"`);
    }
    // http chỉ cho localhost (mock server khi test) — ra Internet bằng http
    // là gửi API key dạng thô.
    const isLocal = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(
      url.hostname,
    );
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) {
      throw new Error(
        `GPNIP_BASE_URL phải dùng https (http chỉ cho localhost): "${raw}"`,
      );
    }
    return raw.replace(/\/+$/, '');
  }

  // ─── Helper HTTP ─────────────────────────────────────────────────────────────

  /**
   * Mọi phản hồi bọc trong `{ success, data }`; lỗi là
   * `{ success: false, error: { code, message } }`.
   */
  /**
   * `retries`: số lần thử LẠI khi fetch NÉM (lỗi kết nối hoặc timeout) — KHÔNG
   * phải khi nhận được phản hồi HTTP. Chỉ truyền > 0 cho call CHỈ ĐỌC
   * (idempotent): GET và POST /check-price. TUYỆT ĐỐI để 0 cho call thay đổi
   * trạng thái (POST /orders, /renew, /extend, PUT …) vì thử lại một request đã
   * có thể tới nơi sẽ tạo trùng đơn.
   *
   * Vì sao cần: môi trường prod có IPv6 hỏng + kết nối tới Cloudflare chập chờn
   * (kiểm chứng 2026-10-27: ~10% call IPv4 bị rớt kết nối tức thì kiểu
   * ECONNRESET, ngoài các lần treo do thử IPv6). Một lần rớt ở bước preflight là
   * khách "không mua được". Thử lại với kết nối mới xử lý gọn các lỗi đó.
   */
  private async request<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    token: string,
    body?: Record<string, unknown>,
    envelope = false,
    retries = 0,
  ): Promise<T> {
    let lastErr: any;
    for (let attempt = 0; attempt <= retries; attempt++) {
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
        clearTimeout(timer);
        lastErr = err;
        // Lỗi kết nối / timeout (fetch NÉM) — thử lại nếu còn lượt.
        if (attempt < retries) {
          this.logger.warn(
            `GPNIP ${method} ${path}: lỗi kết nối (${err?.name ?? err?.message}), ` +
              `thử lại ${attempt + 1}/${retries}`,
          );
          await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
          continue;
        }
        throw new BadRequestException(
          err?.name === 'AbortError'
            ? `GPNIP API timeout sau ${this.TIMEOUT_MS}ms`
            : `GPNIP network error: ${err?.message}`,
        );
      }
      clearTimeout(timer);

      // Có phản hồi HTTP: KHÔNG thử lại (đây là câu trả lời của NCC, kể cả lỗi
      // nghiệp vụ) để tránh lặp lại một thao tác có thể đã thay đổi trạng thái.
      const payload: any = await res.json().catch(() => ({}));
      if (!res.ok || payload?.success !== true) {
        const msg =
          payload?.error?.message ?? payload?.message ?? `HTTP ${res.status}`;
        throw new BadRequestException(`GPNIP API error: ${msg}`);
      }
      return (envelope ? payload : payload.data) as T;
    }
    // Không bao giờ tới đây (vòng lặp luôn return hoặc throw), nhưng để chắc.
    throw new BadRequestException(
      `GPNIP network error: ${lastErr?.message ?? 'unknown'}`,
    );
  }

  // ─── Mua ─────────────────────────────────────────────────────────────────────

  /** Pure validation shared by checkout and worker: never calls the provider. */
  buildBuyBody(params: ProviderBuyParams): Record<string, unknown> {
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(params.body_api || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error();
      body = { ...parsed };
    } catch {
      throw new BadRequestException('GPNIP: body_api must be a JSON object');
    }
    const packageId = GpnipProvider.normalisePackageId(
      body.packageId ?? body.id ?? params.id_service,
    );
    if (packageId === null) {
      throw new BadRequestException(
        'GPNIP: configure a valid package ID from /packages',
      );
    }
    delete body.id;
    body.packageId = packageId;
    if (!Number.isSafeInteger(params.quantity) || params.quantity < 1) {
      throw new BadRequestException('GPNIP: invalid proxy quantity');
    }
    if (params.pricing_mode === 'bandwidth') {
      if (
        !Number.isFinite(params.bandwidth_gb) ||
        Number(params.bandwidth_gb) < 0.1
      ) {
        throw new BadRequestException(
          'GPNIP: actual order bandwidth_gb is required',
        );
      }
      body.gb = params.bandwidth_gb;
    } else if (body.gb !== undefined) {
      throw new BadRequestException(
        'GPNIP: GB template requires bandwidth pricing',
      );
    }
    if (body.ips !== undefined) body.ips = params.quantity;
    if (
      !Number.isSafeInteger(params.duration_days) ||
      params.duration_days < 0
    ) {
      throw new BadRequestException('GPNIP: invalid order duration');
    }
    if (params.duration_days > 0)
      body.duration = String(params.duration_days) + 'd';
    else delete body.duration;
    // Static packages declare period (days) and ips in purchaseFields.
    // Derive both from the billed order, never from a stale template.
    const isStatic = body.period !== undefined;
    if (isStatic) {
      if (params.duration_days < 1)
        throw new BadRequestException('GPNIP: static proxies require a positive duration');
      body.period = String(params.duration_days);
      delete body.duration;
    }
    if (params.country_code && body.country === undefined)
      body.country = params.country_code;
    // GPNIP (từ 2026-10-27): các field purchaseFields của gói static PHẢI nằm
    // trong `serviceOptions`, không để top-level. Kiểm chứng trên API thật:
    // top-level `period` bị bỏ qua (đơn mặc định về 30 ngày) và /check-price
    // trả 422 "Send the period in serviceOptions.period". Gói GB/per_ip giữ
    // nguyên hình dạng cũ — chỉ gói static (có `period` trong template) mới gói
    // country/period/ips vào serviceOptions.
    if (isStatic) {
      const serviceOptions: Record<string, unknown> = {};
      for (const key of ['country', 'period', 'ips']) {
        if (body[key] !== undefined) {
          serviceOptions[key] = body[key];
          delete body[key];
        }
      }
      body.serviceOptions = serviceOptions;
    }
    return body;
  }

  /**
   * ID gói của GPNIP là ObjectId 24 ký tự hex, KHÔNG phải số nguyên như tài
   * liệu ghi.
   *
   * Kiểm chứng trên api.gpnip.com ngày 2026-10-19:
   *   GET /packages/1                        -> 400 "Invalid ID format"
   *   GET /packages/000000000000000000000001 -> 404 "Package not found."
   * Tức là chuỗi hex mới đúng dạng; ép về số là chặn mọi lần mua.
   *
   * Vẫn nhận số nguyên vì tài liệu khai `int` — có thể tài khoản hoặc phiên bản
   * khác dùng int thật. Nhận cả hai không nới lỏng an toàn: `preflightBuy` đọc
   * `GET /packages/{id}` và chặn ID không tồn tại TRƯỚC khi trừ ví.
   */
  static normalisePackageId(raw: unknown): string | number | null {
    if (typeof raw === 'number') {
      return Number.isSafeInteger(raw) && raw >= 1 ? raw : null;
    }
    const text = String(raw ?? '').trim();
    if (!text) return null;
    if (/^[0-9a-fA-F]{24}$/.test(text)) return text.toLowerCase();
    if (/^[1-9][0-9]*$/.test(text)) {
      const n = Number(text);
      return Number.isSafeInteger(n) ? n : null;
    }
    return null;
  }

  validateBuy(params: ProviderBuyParams): void {
    this.buildBuyBody(params);
  }

  async listPackages(token: string, page = 1, perPage = 20): Promise<any> {
    if (
      !Number.isInteger(page) ||
      page < 1 ||
      !Number.isInteger(perPage) ||
      perPage < 1 ||
      perPage > 100
    ) {
      throw new BadRequestException('GPNIP: invalid pagination');
    }
    return this.request(
      'GET',
      '/packages?page=' + page + '&per_page=' + perPage,
      token,
      undefined,
      true,
      2,
    );
  }

  async preflightBuy(params: ProviderBuyParams): Promise<void> {
    const body = this.buildBuyBody(params);
    // Gói static gói country/period/ips vào `serviceOptions` (xem buildBuyBody).
    // Đọc field static TỪ ĐÂY, không phải top-level.
    const so = (body.serviceOptions ?? {}) as Record<string, any>;
    const pkg = await this.request<any>(
      'GET',
      '/packages/' + body.packageId,
      params.token_api,
      undefined,
      false,
      2,
    );
    const mode = pkg?.pricing?.mode;
    const staticPerIp = pkg?.servicePricing?.quantity_field === 'ips' &&
      Array.isArray(pkg?.purchaseFields) &&
      pkg.purchaseFields.some((field: any) => field.key === 'period');
    if (staticPerIp) {
      if (params.pricing_mode === 'bandwidth' || so.ips !== params.quantity ||
          so.period !== String(params.duration_days)) {
        throw new BadRequestException('GPNIP: static packages require duration pricing and ips/period in body_api');
      }
      for (const field of pkg.purchaseFields) {
        const value = so[field.key];
        if (field.required && (value === undefined || value === null || value === ''))
          throw new BadRequestException(`GPNIP: missing static purchase field ${field.key}`);
        if (value !== undefined && Array.isArray(field.options) && field.options.length &&
            !field.options.some((option: any) => String(option.value).toUpperCase() === String(value).toUpperCase()))
          throw new BadRequestException(`GPNIP: unsupported static purchase field ${field.key}`);
        if (field.type === 'number' && value !== undefined &&
            (!Number.isSafeInteger(value) || (field.min != null && Number(value) < field.min) ||
             (field.max != null && Number(value) > field.max)))
          throw new BadRequestException(`GPNIP: invalid static purchase field ${field.key}`);
      }
    }
    // Giá trị THẬT đọc được 2026-10-19: 'tiered_per_gb' (6/7 gói) và 'time'
    // (1/7). Tài liệu không liệt kê 'time'; giữ lại 'per_time'/'fixed' cho
    // trường hợp tài liệu đúng ở tài khoản khác, nhưng thiếu 'time' là từ chối
    // oan một gói đang bán được.
    if (
      !['tiered_per_gb', 'per_ip', 'per_time', 'time', 'fixed'].includes(mode)
    ) {
      throw new BadRequestException(
        'GPNIP: pricing mode not supported for automatic sales',
      );
    }
    if ((mode === 'tiered_per_gb') !== (params.pricing_mode === 'bandwidth')) {
      throw new BadRequestException(
        'GPNIP: local pricing mode does not match provider package',
      );
    }
    // API thật dùng `durationDays` (camelCase), tài liệu ghi `duration_days`.
    // Đọc một tên là luôn nhận undefined -> so sánh với 0 -> từ chối oan.
    const pkgDurationDays = Number(
      pkg?.durationDays ?? pkg?.duration_days ?? 0,
    );
    if (mode === 'fixed' && pkgDurationDays !== params.duration_days) {
      throw new BadRequestException(
        'GPNIP: fixed package duration does not match the billed duration',
      );
    }
    if (mode === 'per_ip' && body.ips === undefined) {
      throw new BadRequestException(
        'GPNIP: per-IP packages require ips in body_api',
      );
    }
    if (mode !== 'per_ip' && !staticPerIp && params.quantity !== 1) {
      throw new BadRequestException(
        'GPNIP: this package supports one order/gateway per purchase',
      );
    }
    /**
     * Shape THẬT (2026-10-19):
     *   { supported: true, kind: 'stock', product: 'ipv6-datacenter',
     *     inventory: { product_type: 'ipv6-datacenter',
     *                  stock: { available: true } } }
     *
     * KHÔNG có field `status` ở đâu cả — tài liệu nói "if the status is
     * anything other than healthy, do not purchase". Bản trước chỉ soi
     * `status`, nên `available: false` LỌT QUA: hết hàng vẫn mua, tức là trừ
     * tiền khách để lấy một đơn không bao giờ được cấp.
     *
     * Nên soi cả hai: `status` khác 'healthy', HOẶC `available` là false.
     *
     * Nhưng không phải gói nào cũng CÓ endpoint này. Ba gói proxy tĩnh
     * (proxy6-v3/v4/v6) trả HTTP 500 "Cấu hình nhà cung cấp không hợp lệ"
     * (kiểm chứng 2026-10-27) trong khi gói GB/time trả 200 kèm inventory.
     * LỖI ĐỌC tồn kho KHÁC tín hiệu hết hàng — hết hàng là 200 kèm
     * `available: false`. Để `request()` ném lỗi ở đây là chặn 100% đơn
     * static, trong khi chốt thật nằm ở `/check-price` + khớp giá catalog
     * ngay bên dưới. Nên: đọc được thì soi như cũ; đọc không được thì bỏ qua
     * và log, không chặn đơn.
     */
    let stock: any = null;
    try {
      stock = await this.request<any>(
        'GET',
        '/packages/' + body.packageId + '/stock',
        params.token_api,
        undefined,
        false,
        2,
      );
    } catch (err: any) {
      this.logger.warn(
        `GPNIP: bỏ qua kiểm tồn kho gói ${body.packageId} ` +
          `(endpoint /stock không khả dụng: ${err?.message ?? err}). ` +
          `Vẫn chốt bằng /check-price và khớp giá catalog.`,
      );
    }
    const unhealthy = (value: any): boolean => {
      if (!value || typeof value !== 'object') return false;
      if ('available' in value && value.available === false) return true;
      if ('status' in value && value.status !== 'healthy') return true;
      return Object.values(value).some(unhealthy);
    };
    if (stock && stock?.supported !== false && unhealthy(stock?.inventory)) {
      throw new BadRequestException(
        'GPNIP: hết hàng hoặc tồn kho không sẵn sàng; chưa trừ ví',
      );
    }
    const quote = await this.request<any>(
      'POST',
      '/check-price',
      params.token_api,
      // Static: period/country/ips phải nằm trong serviceOptions (API trả 422
      // nếu để `period` top-level). Các mode khác giữ hình dạng phẳng cũ.
      staticPerIp
        ? { id: body.packageId, serviceOptions: so }
        : {
            id: body.packageId,
            duration: body.duration,
            gb: body.gb,
            country: body.country,
            ips: body.ips,
            pool: body.pool,
          },
      false,
      2,
    );
    if (
      quote?.price == null ||
      !Number.isFinite(Number(quote.price)) ||
      Number(quote.price) < 0
    ) {
      throw new BadRequestException('GPNIP: invalid quote; wallet not charged');
    }
    if (staticPerIp) {
      const rows = pkg?.servicePricing?.rows;
      const row = Array.isArray(rows) ? rows.find((entry: any) =>
        String(entry?.when?.period) === so.period &&
        Object.entries(entry.when ?? {}).every(([key, value]) =>
          String(so[key]).toUpperCase() === String(value).toUpperCase())) : undefined;
      const expected = Number(row?.price) * params.quantity;
      const quotedList = Number(quote.list_price ?? quote.price);
      if (!row || !Number.isFinite(expected) || expected <= 0 ||
          !Number.isFinite(quotedList) || Math.abs(quotedList - expected) > 0.000001) {
        this.logger.warn('GPNIP static catalog/quote mismatch; purchase blocked before wallet debit');
        throw new BadRequestException('GPNIP: static quote does not match catalog duration/quantity; wallet not charged');
      }
    }
  }

  async buy(params: ProviderBuyParams): Promise<BuyResult> {
    const body = this.buildBuyBody(params);

    const data = await this.request<any>(
      'POST',
      '/orders',
      params.token_api,
      body,
    );

    const orderId = this.pickProviderOrderId(data);
    if (orderId == null) {
      throw new BadRequestException(
        `GPNIP không trả về id đơn: ${JSON.stringify(data).slice(0, 200)}`,
      );
    }

    // Return the order ID immediately so the worker can persist it before polling.
    return {
      provider_order_id: orderId,
      proxies: [],
      provider_metadata: { status: data?.status },
      raw: data,
    };
  }

  /**
   * Chọn ID đơn DÙNG ĐƯỢC làm tham số đường dẫn.
   *
   * Chi tiết đơn thật trả về ba trường định danh khác định dạng nhau:
   *   id       = "6ad36c775a0fd3280a199639"                 <- ObjectId, path OK
   *   uuid     = "acct_e4tkz2edvn9a91d6x0zerx9bg0"          <- path 400
   *   order_id = "omo-eddfc447-e645-45fa-95d2-69a730929597" <- path 400
   *
   * Tài liệu nói `POST /orders` trả `order_id`, nên cách viết hiển nhiên là lấy
   * `order_id` trước — và đó là cái bẫy: GPNIP chỉ nhận ObjectId 24 hex ở path
   * (kiểm chứng 2026-10-19: GET /orders/1 -> 400 "Invalid ID format"). Lưu
   * `omo-…` vào `provider_order_id` nghĩa là đơn đã trừ tiền khách rồi mà mọi
   * lệnh sau — poll, usage, proxies, extend, renew — đều 400 vĩnh viễn.
   *
   * Nên: ưu tiên ứng viên nào ĐÚNG DẠNG path. Không có cái nào đúng dạng thì
   * vẫn trả ứng viên đầu tiên (đơn đã mua rồi, mất ID là mất luôn đường đối
   * soát) nhưng log lỗi để người vận hành biết phải xử lý tay.
   */
  private pickProviderOrderId(data: any): string | null {
    const candidates = [
      data?.id,
      data?.order?.id,
      data?.data?.id,
      data?.order_id,
      data?.uuid,
    ]
      .map((v) => (v == null ? '' : String(v).trim()))
      .filter((v) => v !== '');

    if (candidates.length === 0) return null;

    const usable = candidates.find(
      (v) => GpnipProvider.normalisePackageId(v) !== null,
    );
    if (usable) return usable;

    this.logger.error(
      `GPNIP trả id đơn không dùng được làm path param: ${candidates[0]} — ` +
        `đơn đã tạo ở nhà cung cấp, cần đối soát bằng GET /orders`,
    );
    return candidates[0];
  }

  // ─── Cổng theo sản phẩm (nguồn DỰ PHÒNG) ────────────────────────────────────

  /**
   * Cặp cổng HTTP/SOCKS5 theo sản phẩm, do chủ hệ thống cung cấp 2026-10-20.
   *
   * CHỈ dùng khi đơn KHÔNG trả cổng. Cổng nhà cung cấp trả về luôn thắng: bảng
   * chép tay rồi sẽ cũ, mà sai cổng là proxy khách không kết nối được.
   *
   * Vì sao vẫn cần: `/packages` CÓ field `ports`, nhưng đang `null` cho cả 7
   * gói trên tài khoản này (kiểm chứng 2026-10-20) — không đọc được cổng từ
   * danh mục. Và `fetchOrderProxies` NÉM LỖI khi cổng không hợp lệ, nên một
   * đơn socks5 của sản phẩm không khai `port_socks` sẽ cấp thất bại hoàn toàn.
   *
   * KHÔNG lấy hostname từ bảng đó: bảng ghi `*.proxyserver.bot` còn đơn thật
   * trả `*.gpnip.com` — cùng tiền tố subdomain, khác apex (GPNIP là nhãn trắng
   * của proxyserver.bot). Host đúng chỉ có trong response của đơn.
   *
   * Những dòng KHÔNG đưa vào đây, kèm lý do:
   *   Mobile USA, Shared ISP EU, Premium Unlimited Residential — không gói nào
   *     trên tài khoản này mang `product` tương ứng, nên không biết khoá nào.
   *   Residential Pool 1–6 — cổng là một DẢI (10000–10009), không phải một cặp.
   *   Dedicated ISP, Dedicated ISP v2 — cổng thay đổi theo từng IP.
   * Cả bảng gốc nằm trong docs/gpnip-setup.md.
   */
  static readonly PRODUCT_PORTS: Record<
    string,
    { http: number; socks: number }
  > = {
    residential: { http: 8080, socks: 1080 },
    'residential-lite': { http: 6969, socks: 9696 },
    datacenter: { http: 777, socks: 666 },
    mobile: { http: 8080, socks: 1080 },
    isp: { http: 30, socks: 31 },
    'ipv6-residential': { http: 30, socks: 31 },
    // Khớp đơn thật đã mua: port_http 50, port_socks 51.
    'ipv6-datacenter': { http: 50, socks: 51 },
    // Cùng một cổng cho cả hai giao thức — không phải lỗi chép bảng.
    'unlimited-residential': { http: 10507, socks: 10507 },
  };

  /**
   * Khoá tra bảng. API dùng lẫn gạch dưới và gạch ngang cho cùng một sản phẩm
   * (gửi `unlimited_residential`, echo `unlimited-residential`), nên chuẩn hoá
   * về gạch ngang trước khi tra.
   */
  private static portsFor(
    product: unknown,
  ): { http: number; socks: number } | undefined {
    const key = String(product ?? '')
      .trim()
      .toLowerCase()
      .replace(/_/g, '-');
    return GpnipProvider.PRODUCT_PORTS[key];
  }

  /**
   * Cổng nhà cung cấp trả về, hoặc cổng trong bảng nếu đơn không khai.
   *
   * Trả 0 khi không có nguồn nào — caller tự ném lỗi nếu đó là cổng đang cần.
   * Đoán một con số bất kỳ ở đây là cấp cho khách một proxy không kết nối được.
   */
  private resolvePort(
    raw: unknown,
    product: unknown,
    kind: 'http' | 'socks',
    provider_order_id: string,
    configured?: number,
  ): number {
    // Cổng admin khai thắng trước tiên: lựa chọn tường minh của con người, và
    // sản phẩm dùng dải cổng thì nhà cung cấp trả về cổng nào cũng chỉ là một
    // cổng trong dải.
    const own = Number(configured);
    if (Number.isInteger(own) && own >= 1 && own <= 65535) return own;

    const given = Number(raw);
    if (Number.isInteger(given) && given >= 1 && given <= 65535) return given;

    const fallback = GpnipProvider.portsFor(product)?.[kind];
    if (!fallback) return 0;

    this.logger.warn(
      `GPNIP đơn ${provider_order_id}: không có cổng ${kind} trong response ` +
        `(sản phẩm ${String(product) || 'không rõ'}) — dùng bảng dự phòng ` +
        `${fallback}. Kiểm tra lại nếu khách báo không kết nối được.`,
    );
    return fallback;
  }

  // ─── Đọc proxy của đơn ───────────────────────────────────────────────────────

  async fetchOrderProxies(
    token_api: string,
    provider_order_id: string,
    context?: {
      metadata?: Record<string, any>;
      protocol?: string;
      ports?: { http?: number; socks?: number };
    },
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

    const detail = await this.request<
      ProxiesResponse & { status?: number | string; proxy_type?: string }
    >('GET', '/orders/' + provider_order_id, token_api);
    if (detail?.status !== 1 && detail?.status !== 'active') return [];

    // Sản phẩm của đơn — khoá tra `PRODUCT_PORTS` khi đơn thiếu cổng. Chỉ
    // `/orders/{id}` mang field này, `/orders/{id}/proxies` thì không.
    const product = detail?.proxy_type;

    const data = Array.isArray(detail.proxies)
      ? detail
      : await this.request<ProxiesResponse>(
          'GET',
          `/orders/${provider_order_id}/proxies?format=json`,
          token_api,
        );

    const wantSocks = (context?.protocol ?? '').toLowerCase().includes('socks');

    if (!Array.isArray(data?.proxies))
      throw new BadRequestException('GPNIP: invalid proxies response');
    return data.proxies.map((p) => {
      const httpPort = this.resolvePort(
        p.port_http,
        product,
        'http',
        provider_order_id,
        context?.ports?.http,
      );
      const socksPort = this.resolvePort(
        p.port_socks,
        product,
        'socks',
        provider_order_id,
        context?.ports?.socks,
      );
      const port = wantSocks ? socksPort : httpPort;
      if (!p.host || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new BadRequestException('GPNIP: invalid proxy host or port');
      }
      return {
        host: p.host,
        port,
        username: p.username,
        password: p.password,
        // Local stable identifier: GPNIP renews whole orders, not individual IPs.
        // `httpPort` đã chuẩn hoá nên id không đổi với cổng chuỗi ("8080" -> 8080).
        provider_proxy_id:
          'gpnip:' + provider_order_id + ':' + p.host + ':' + httpPort,
        protocol: wantSocks ? 'socks5' : 'http',
        // Giữ cả hai cổng để đổi giao thức sau này không phải gọi lại API.
        // Lưu cổng ĐÃ giải quyết: thiếu `port_socks` ở đây là nút SOCKS5 trong
        // modal của khách bị tắt dù sản phẩm có hỗ trợ.
        provider_metadata: {
          port_http: httpPort || p.port_http,
          port_socks: socksPort || p.port_socks,
        },
      };
    });
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

    const data = await this.request<MeResponse>(
      'GET',
      '/me',
      token_api,
      undefined,
      false,
      2,
    );

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
      throw new BadRequestException(
        'GPNIP: đơn chưa có provider_order_id để nạp thêm',
      );
    }

    if (!Number.isFinite(gb) || gb < 0.1) {
      throw new BadRequestException(
        `GPNIP: số GB nạp thêm phải ≥ 0.1, nhận được ${gb}`,
      );
    }

    const data = await this.request<{ order?: { traffic?: number } }>(
      'POST',
      `/orders/${provider_order_id}/extend`,
      token_api,
      { gb },
    );

    return { raw: data };
  }

  // ─── Gia hạn ─────────────────────────────────────────────────────────────────

  /** Preview quotes only (order:null); commit returns order.expired_at. */
  async renew(params: ProviderRenewParams): Promise<RenewResult> {
    const { token_api, provider_order_id, duration_days } = params;

    if (!provider_order_id) {
      throw new BadRequestException(
        'GPNIP: đơn chưa có provider_order_id để gia hạn',
      );
    }

    if (!Number.isFinite(duration_days) || duration_days < 1) {
      throw new BadRequestException(
        `GPNIP: số ngày gia hạn không hợp lệ (${duration_days})`,
      );
    }

    if (!Number.isSafeInteger(duration_days)) {
      throw new BadRequestException('GPNIP: renewal days must be an integer');
    }
    const duration = String(duration_days) + '_days';
    const path = '/orders/' + provider_order_id + '/renew';
    // Preview returns prices and order:null, NOT a days field.
    const preview = await this.request<any>('POST', path, token_api, {
      duration,
      preview: true,
    });
    if (
      preview?.price == null ||
      !Number.isFinite(Number(preview.price)) ||
      Number(preview.price) < 0
    ) {
      throw new BadRequestException('GPNIP: invalid renewal quote');
    }
    const data = await this.request<any>('POST', path, token_api, { duration });

    const expiredAt = data?.order?.expired_at
      ? new Date(data.order.expired_at)
      : undefined;

    return {
      success: true,
      new_end_date:
        expiredAt && !Number.isNaN(expiredAt.getTime()) ? expiredAt : undefined,
      raw: data,
    };
  }

  // ─── Đối soát đơn phía nhà cung cấp ──────────────────────────────────────────

  /**
   * `GET /orders` — chỉ đọc, giữ nguyên `meta` phân trang.
   *
   * Đây là đường đối soát khi `POST /orders` timeout: đơn có thể đã tạo xong ở
   * phía GPNIP mà mình không nhận được response. Không có endpoint này thì
   * cách duy nhất là mở trang nhà cung cấp xem tay.
   */
  async listProviderOrders(
    token: string,
    page = 1,
    perPage = 20,
    status?: number,
  ): Promise<unknown> {
    if (
      !Number.isInteger(page) ||
      page < 1 ||
      !Number.isInteger(perPage) ||
      perPage < 1 ||
      perPage > 100
    ) {
      throw new BadRequestException('GPNIP: invalid pagination');
    }
    const query = new URLSearchParams({
      page: String(page),
      per_page: String(perPage),
    });
    if (status !== undefined && status !== null) {
      // Tài liệu: status 0–5. Gửi số ngoài khoảng là nhận 422 sau một vòng
      // network — chặn tại đây rẻ hơn.
      if (!Number.isInteger(status) || status < 0 || status > 5) {
        throw new BadRequestException('GPNIP: order status filter must be 0-5');
      }
      query.set('status', String(status));
    }
    return this.request('GET', `/orders?${query.toString()}`, token, undefined, true);
  }

  // ─── Danh mục địa lý ─────────────────────────────────────────────────────────

  /**
   * Sáu giá trị `product` tài liệu liệt kê cho `GET /countries`.
   *
   * KHÔNG dùng làm allow-list: danh sách này THIẾU. Catalog thật còn có
   * `ipv6-datacenter` và `ipv6-residential`, và GPNIP nhận cả hai
   * (kiểm chứng 2026-10-19: product=ipv6-datacenter -> echo 'ipv6-datacenter',
   * 1 nước 'us'). Chặn theo danh sách này là từ chối đúng product của gói
   * đang bán. Giữ lại để gợi ý ở giao diện.
   */
  static readonly DOCUMENTED_PRODUCTS = [
    'residential',
    'residential-lite',
    'datacenter',
    'isp',
    'unlimited_residential',
    'mobile',
  ];

  /**
   * `GET /countries?product=` — vùng phủ khác nhau theo loại sản phẩm, nên
   * không có danh sách quốc gia "chung" để cache một lần cho mọi gói.
   *
   * API THẬT trả khác tài liệu. Tài liệu ghi `[{ name, iso_code }]`, nhưng
   * api.gpnip.com trả:
   *   { product, supported: { country: ["us", ...], state, city, ... },
   *     capabilities: { country: true, state: false, ... }, generated_at }
   *
   * Chuẩn hoá cả hai dạng về một kiểu: đọc đúng một dạng là chỗ còn lại im
   * lặng trả danh sách rỗng, và admin kết luận "nhà cung cấp không có quốc gia
   * nào" trong khi thực tế có hàng trăm.
   *
   * `raw` giữ nguyên để admin xem được state/city/asn — những thứ kiểu chuẩn
   * hoá này không chứa.
   */
  /**
   * Gom mã ISO-2 từ mọi dạng payload địa lý mà GPNIP trả về.
   *
   * Ba dạng đã gặp trên cùng một nhà cung cấp:
   *   `[{ name, iso_code }]`        — dạng tài liệu của `/countries`
   *   `{ supported: { country: [] } }` — dạng THẬT của `/countries`
   *   `[]` / `{ countries: [] }`    — `/orders/{id}/geo`
   * Đọc đúng một dạng là chỗ còn lại im lặng trả rỗng, và người đọc kết luận
   * "không có quốc gia nào" trong khi thực tế có hàng trăm.
   *
   * Mã luôn viết HOA: API trả chữ thường ("us"), tài liệu ví dụ chữ hoa
   * ("VN"), cấu hình nội bộ dùng chữ hoa. Để lẫn hai kiểu là mã không khớp
   * được với bất cứ thứ gì.
   */
  static extractIsoCodes(data: unknown): string[] {
    const d = data as any;
    const raw: unknown[] = Array.isArray(d)
      ? d.map((c: any) => c?.iso_code ?? c?.code ?? c?.country ?? c)
      : Array.isArray(d?.supported?.country)
        ? d.supported.country
        : Array.isArray(d?.countries)
          ? d.countries.map(
              (c: any) => c?.iso_code ?? c?.code ?? c?.country ?? c,
            )
          : [];

    return [
      ...new Set(
        raw
          .filter((c): c is string => typeof c === 'string' && c.trim() !== '')
          .map((c) => c.trim().toUpperCase())
          // Chỉ nhận mã ISO-2 chữ cái. Payload geo còn trộn state/city/asn —
          // nhận bừa là đẩy "california" vào ô chọn quốc gia.
          .filter((c) => /^[A-Z]{2}$/.test(c)),
      ),
    ];
  }

  async listCountries(
    token: string,
    product = 'residential',
  ): Promise<{
    product: string;
    iso_codes: string[];
    capabilities?: Record<string, boolean>;
    raw: unknown;
  }> {
    // Chỉ kiểm tra HÌNH DẠNG, không kiểm tra thành viên trong danh sách tài
    // liệu: danh sách đó thiếu `ipv6-datacenter`/`ipv6-residential` mà GPNIP
    // vẫn nhận. Nguồn đúng của `product` là field `product` của gói, không
    // phải một enum chép tay.
    if (!/^[a-z0-9][a-z0-9_-]{1,40}$/.test(product)) {
      throw new BadRequestException(
        `GPNIP: product không hợp lệ: "${product}"`,
      );
    }

    const data = await this.request<any>(
      'GET',
      `/countries?product=${encodeURIComponent(product)}`,
      token,
    );

    const iso_codes = GpnipProvider.extractIsoCodes(data);

    return {
      // API echo lại product đã chuẩn hoá ("unlimited-residential" khi gửi
      // "unlimited_residential") — trả cái NCC nói, không trả cái mình gửi.
      product:
        typeof data?.product === 'string' && data.product ? data.product : product,
      iso_codes,
      capabilities:
        data?.capabilities && typeof data.capabilities === 'object'
          ? data.capabilities
          : undefined,
      raw: data,
    };
  }

  /**
   * Danh sách quốc gia của ĐÚNG gói đó — đây mới là cách dùng đúng.
   *
   * Mỗi gói mang field `product` riêng (`ipv6-datacenter`, `residential`,
   * `mobile`, …) và vùng phủ khác nhau hẳn: ipv6-datacenter chỉ 1 nước (US),
   * residential 166 nước, residential-lite 202. Để người dùng tự chọn product
   * là mời họ chọn sai, rồi cấu hình dịch vụ bằng một mã quốc gia mà gói đó
   * không bán.
   *
   * Hai request (đọc gói, rồi đọc quốc gia) vì `product` chỉ có trong gói.
   */
  async listCountriesForPackage(
    token: string,
    packageId: string,
  ): Promise<{
    package_id: string;
    product: string;
    iso_codes: string[];
    capabilities?: Record<string, boolean>;
    raw: unknown;
  }> {
    const id = GpnipProvider.normalisePackageId(packageId);
    if (id === null) {
      throw new BadRequestException(
        'GPNIP: dịch vụ chưa khai ID gói hợp lệ, không tra được quốc gia',
      );
    }

    const pkg = await this.request<any>('GET', `/packages/${id}`, token);
    const product = pkg?.product;
    if (typeof product !== 'string' || !product.trim()) {
      throw new BadRequestException(
        'GPNIP: gói không khai `product`, không suy ra được vùng phủ',
      );
    }

    const countries = await this.listCountries(token, product.trim());
    return { package_id: String(id), ...countries };
  }

  /**
   * `GET /orders/{id}/geo` — catalog địa lý theo đúng sản phẩm của đơn, khỏi
   * phải đoán `product` như `/countries`. Nhà cung cấp không cấu hình geo thì
   * trả mảng rỗng, KHÔNG phải lỗi.
   */
  async fetchOrderGeo(
    token: string,
    provider_order_id: string,
  ): Promise<{
    iso_codes: string[];
    capabilities?: Record<string, boolean>;
    raw: unknown;
  }> {
    if (!provider_order_id) {
      throw new BadRequestException('GPNIP: đơn chưa có provider_order_id');
    }
    const data = await this.request<any>(
      'GET',
      `/orders/${encodeURIComponent(provider_order_id)}/geo`,
      token,
    );

    // Chuẩn hoá ngay tại adapter: caller dựng ô chọn quốc gia từ danh sách
    // này, nên hình dạng riêng của từng nhà cung cấp không được chảy ra ngoài.
    return {
      iso_codes: GpnipProvider.extractIsoCodes(data),
      capabilities:
        data?.capabilities && typeof data.capabilities === 'object'
          ? data.capabilities
          : undefined,
      raw: data,
    };
  }

  // ─── Đổi mật khẩu proxy ──────────────────────────────────────────────────────

  /**
   * `PUT /orders/{id}/password` — tài liệu: 6–32 ký tự, CHỈ chữ và số.
   *
   * Trả về mật khẩu nhà cung cấp đang dùng thật, không phải cái mình gửi lên:
   * caller phải ghi đúng giá trị đó vào proxy nội bộ, lệch một ký tự là khách
   * nhìn thấy mật khẩu không kết nối được.
   */
  async changeProxyPassword(
    token: string,
    provider_order_id: string,
    newPassword: string,
  ): Promise<{ password: string; raw?: any }> {
    if (!provider_order_id) {
      throw new BadRequestException(
        'GPNIP: đơn chưa có provider_order_id để đổi mật khẩu',
      );
    }
    if (!/^[A-Za-z0-9]{6,32}$/.test(newPassword ?? '')) {
      throw new BadRequestException(
        'GPNIP: mật khẩu phải 6–32 ký tự, chỉ gồm chữ và số',
      );
    }

    const data = await this.request<{
      updated?: boolean;
      message?: string;
      password?: string;
    }>('PUT', `/orders/${encodeURIComponent(provider_order_id)}/password`, token, {
      new_password: newPassword,
    });

    // `success: true` mà `updated: false` nghĩa là nhà cung cấp nhận request
    // nhưng không đổi. Coi đó là thành công là để khách giữ mật khẩu cũ mà
    // tưởng đã đổi.
    if (data?.updated === false) {
      throw new BadRequestException(
        `GPNIP: đổi mật khẩu không được áp dụng: ${data?.message ?? 'không rõ lý do'}`,
      );
    }

    const applied =
      typeof data?.password === 'string' && data.password
        ? data.password
        : newPassword;

    return { password: applied, raw: data };
  }

  // ─── Whitelist IP ────────────────────────────────────────────────────────────

  /**
   * `PUT /orders/{id}/allowed-ips` — tài liệu: tối đa 10 IP hợp lệ.
   *
   * Mảng rỗng = xoá whitelist (quay về xác thực user/pass), đó là trạng thái
   * hợp lệ nên không chặn.
   */
  async setAllowedIps(
    token: string,
    provider_order_id: string,
    ips: string[],
  ): Promise<{ allowed_ips: string[]; raw?: any }> {
    if (!provider_order_id) {
      throw new BadRequestException(
        'GPNIP: đơn chưa có provider_order_id để đặt whitelist IP',
      );
    }
    if (!Array.isArray(ips)) {
      throw new BadRequestException('GPNIP: allowed_ips phải là một mảng');
    }

    const cleaned = ips.map((v) => String(v ?? '').trim());
    for (const ip of cleaned) {
      // isIP của Node nhận cả IPv4 và IPv6, khỏi tự viết regex sai.
      if (!isIP(ip)) {
        throw new BadRequestException(`GPNIP: IP không hợp lệ: "${ip}"`);
      }
    }

    // Lọc trùng TRƯỚC khi đếm: 10 dòng trong đó 3 dòng trùng vẫn là 8 IP thật,
    // từ chối thì khách không hiểu vì sao.
    const unique = [...new Set(cleaned)];
    if (unique.length > 10) {
      throw new BadRequestException(
        `GPNIP: tối đa 10 IP trong whitelist, nhận được ${unique.length}`,
      );
    }

    const data = await this.request<{
      allowed_ips?: string[];
      updated?: boolean;
    }>(
      'PUT',
      `/orders/${encodeURIComponent(provider_order_id)}/allowed-ips`,
      token,
      { allowed_ips: unique },
    );

    if (data?.updated === false) {
      throw new BadRequestException('GPNIP: whitelist IP không được áp dụng');
    }

    return {
      allowed_ips: Array.isArray(data?.allowed_ips) ? data.allowed_ips : unique,
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
