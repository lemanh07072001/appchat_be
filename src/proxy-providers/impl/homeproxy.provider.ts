import { BadRequestException, Logger } from '@nestjs/common';
import { ProxyProvider } from '../proxy-provider.decorator';
import { randomBytes } from 'crypto';
import {
  IProxyProvider,
  ProviderBuyParams,
  ProviderCancelParams,
  ProviderRenewParams,
  ProviderRotateParams,
  BuyResult,
  RenewResult,
  RotateResult,
  ProviderConnectionInfo,
} from '../proxy-provider.interface';

@ProxyProvider('homeproxy')
export class HomeproxyProvider implements IProxyProvider {
  readonly capabilities = { buy: true, renew: true, rotate: true, cancel: true };

  private readonly logger      = new Logger(HomeproxyProvider.name);
  private readonly BASE_URL    = 'https://api.homeproxy.vn/api';
  private readonly TIMEOUT_MS  = 30_000;
  private readonly MAX_PAGES   = 50;

  // ─── Kiểm tra kết nối ────────────────────────────────────────────────────────

  /**
   * HomeProxy không có endpoint tài khoản hay số dư (đã dò: /merchant/me,
   * /merchant/profile, /merchant/balance, /merchant/account đều 404).
   * `GET /merchant/orders` là endpoint chỉ-đọc duy nhất có xác thực — token sai
   * trả 401 "Token invalid".
   *
   * Nên nó trả lời được đúng một câu, nhưng là câu admin cần nhất: key này còn
   * dùng được không. Trước đây không có method này thì nút "Kiểm tra kết nối"
   * không hiện, key sai được lưu im lặng và chỉ lộ ra khi khách đặt đơn thật.
   *
   * Không bịa `account` hay `balance`: giao diện hiển thị "key OK · —" khi
   * thiếu, trung thực hơn là hiện một con số không có thật.
   */
  async checkConnection(token_api: string): Promise<ProviderConnectionInfo> {
    // request() đã ném BadRequestException kèm message của nhà cung cấp khi
    // không ok; PartnersService bắt và biến thành kết quả "key lỗi".
    await this.request<unknown>('GET', '/merchant/orders', token_api);
    return {};
  }

  // ─── Helper HTTP ─────────────────────────────────────────────────────────────

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    token: string,
    body?: Record<string, any>,
  ): Promise<T> {
    const url = `${this.BASE_URL}${path}`;
    this.logger.log(`[${method}] → ${url}`);
    if (body) this.logger.debug(`[${method}] body: ${JSON.stringify(body)}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        signal: controller.signal,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type':  'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err: any) {
      throw new BadRequestException(
        err?.name === 'AbortError'
          ? `HomeProxy API timeout after ${this.TIMEOUT_MS}ms`
          : `HomeProxy network error: ${err?.message}`,
      );
    } finally {
      clearTimeout(timer);
    }

    const data = await res.json().catch(() => ({}));
    this.logger.debug(`[${method}] ← ${res.status} ${path}: ${JSON.stringify(data)}`);

    if (!res.ok) {
      const msg = data?.message ?? JSON.stringify(data);
      const friendly =
        msg === 'notEnoughProxy' ? 'Nhà cung cấp tạm hết proxy, vui lòng thử lại sau' : msg;
      const err = new BadRequestException(`HomeProxy API error [${res.status}]: ${friendly}`);
      (err as any).providerData = data;
      (err as any).providerStatus = res.status;
      (err as any).providerRawResponse = JSON.stringify(data);
      throw err;
    }

    return data as T;
  }

  // ─── Tạo credentials ngẫu nhiên cho proxy ────────────────────────────────────

  private generateCredentials(): { user: string; password: string } {
    const rand = () => randomBytes(6).toString('hex');
    return { user: `u${rand()}`, password: `p${rand()}${rand()}` };
  }

  // ─── Mua proxy ───────────────────────────────────────────────────────────────

  async buy(params: ProviderBuyParams): Promise<BuyResult> {
    const { user, password } = params.username && params.password
      ? { user: params.username, password: params.password }
      : this.generateCredentials();

    const rotateInterval = params.rotate_interval ?? 0;
    const isCdk          = params.is_cdk ?? false;
    const isRotating     = rotateInterval > 0 || params.proxy_type === 'rotating';

    const VALID_ISP = ['VIETTEL', 'VNPT', 'FPT'];
    const ispUpper = params.isp?.toUpperCase() ?? '';
    const provider = isRotating ? 'HOMEPROXY' : (VALID_ISP.includes(ispUpper) ? ispUpper : 'VIETTEL');

    const raw = await this.request<any>('POST', '/merchant/orders', params.token_api, {
      paymentMethod: 'WALLET',
      products: [
        {
          isCdk,
          dayOfUse:       params.duration_days,
          rotateInterval,
          user,
          password,
          protocolType:   params.protocol?.toLowerCase() === 'socks5' ? 'SOCKS' : 'HTTP',
          provider,
          quantity:       params.quantity,
          product: {
            id: params.id_service,
          },
        },
      ],
    });

    // ── Map response → BuyResult ────────────────────────────────────────────
    // Response: { id, products: [{ user, password, protocolType, ... }], ... }
    const providerOrderId = raw?.id ? String(raw.id) : '';
    if (!providerOrderId) {
      throw new BadRequestException('HomeProxy không trả về order ID');
    }

    return { provider_order_id: providerOrderId, proxies: [], raw };
  }

  // ─── Lấy proxy theo order ID (async — sau khi HomeProxy hoàn tất) ────────────

  async fetchOrderProxies(token_api: string, provider_order_id: string): Promise<any[]> {
    const filter   = encodeURIComponent(`orderId:$eq:string:${provider_order_id}`);
    const allItems: any[] = [];
    let page = 1;

    // Lấy hết tất cả trang, tối đa MAX_PAGES để tránh loop vô hạn
    while (page <= this.MAX_PAGES) {
      const raw = await this.request<any>(
        'GET',
        `/merchant/proxies?filter=${filter}&page=${page}&limit=100`,
        token_api,
      );

      const items: any[] = raw?.data ?? [];
      allItems.push(...items);

      if (!raw?.hasNextPage) break;
      page++;
    }

    return allItems.map((p: any) => {
      // HomeProxy trả "SOCKS" cho SOCKS5 — chuẩn hoá về enum của ProxyProtocolEnum
      const rawProto = (p.protocol ?? 'http').toLowerCase();
      const normalizedProto = rawProto === 'socks' ? 'socks5' : rawProto;
      return ({
      host:              p.proxy?.ipaddress?.ip ?? p.proxy?.ipaddress?.domain ?? '',
      port:              Number(p.proxy?.port ?? 0),
      username:          p.proxy?.username ?? '',
      password:          p.proxy?.password ?? '',
      protocol:          normalizedProto,
      provider_proxy_id: p.id != null ? String(p.id) : undefined,
      domain:            p.proxy?.ipaddress?.domain ?? undefined,
      prev_ip:           p.proxy?.ipaddress?.prevIp ?? undefined,
      location:          p.proxy?.ipaddress?.location ?? undefined,
      isp:               p.proxy?.ipaddress?.provider ?? undefined,
    });
    });
  }

  // ─── Gia hạn ─────────────────────────────────────────────────────────────────
  // API: POST /merchant/orders/renewal-proxies
  // Body: { userProxyIds: number[], dayOfRenewal: number, isRenewal: false, categoryTypeId: 1 }

  async renew(params: ProviderRenewParams): Promise<RenewResult> {
    const ids = (params.provider_proxy_ids ?? [])
      .map((id) => Number(id))
      .filter((n) => Number.isFinite(n) && n > 0);

    if (ids.length === 0) {
      throw new BadRequestException('HomeProxy: không có userProxyIds để gia hạn');
    }

    // categoryTypeId: 1 = proxy tĩnh. Rotating chưa có tài liệu → mặc định 1.
    // id_service được truyền xuống; nếu là số thì coi như categoryTypeId.
    const categoryTypeId = Number(params.id_service) || 1;

    const raw = await this.request<any>('POST', '/merchant/orders/renewal-proxies', params.token_api, {
      userProxyIds:   ids,
      dayOfRenewal:   params.duration_days,
      isRenewal:      false,
      categoryTypeId,
    });

    return {
      success:      raw?.success ?? true,
      new_end_date: raw?.endDate ? new Date(raw.endDate) : undefined,
      raw,
    };
  }

  // ─── Xoay IP ─────────────────────────────────────────────────────────────────
  // TODO: cập nhật khi có tài liệu API rotate của HomeProxy

  async rotate(params: ProviderRotateParams): Promise<RotateResult> {
    const raw = await this.request<any>('POST', '/orders/rotate', params.token_api, {
      orderId: params.provider_order_id,
    });

    return {
      new_host: raw.newIp ?? raw.ip ?? raw.host,
      raw,
    };
  }

  // ─── Huỷ ─────────────────────────────────────────────────────────────────────
  // TODO: cập nhật khi có tài liệu API cancel của HomeProxy

  async cancel(params: ProviderCancelParams): Promise<void> {
    await this.request<any>('POST', '/orders/cancel', params.token_api, {
      orderId: params.provider_order_id,
    });
  }
}
