import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import * as https from 'node:https';
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
} from '../proxy-provider.interface';

interface PsResponse<T> {
  status: 'success' | 'error';
  data: T | null;
  errors: { message: string; code: number; customData: any }[];
}

interface OrderMakeData {
  orderId: number;
  total: number;
  listBaseOrderNumbers: string[];
  balance: number;
}

interface ProxyListItem {
  id: string;
  order_id: string;
  order_number: string;
  base_order_number: string;
  basket_id: string;
  ip: string;
  ip_only: string;
  protocol: string; // "HTTP" | "SOCKS"
  port_http: number;
  port_socks: number;
  login: string;
  password: string;
  auth_ip: string;
  rotation: any;
  link_reboot: string;
  country: string; // tên quốc gia, vd "Japan"
  country_alpha3: string; // ISO alpha-3, vd "JPN"
  status: string; // vd "Active"
  status_type: string; // vd "ACTIVE"
  can_prolong: boolean;
  date_start: string; // dd.mm.yyyy
  date_end: string; // dd.mm.yyyy
  comment: string;
  auto_renew: string; // "Y" | "N"
  auto_renew_period: string;
  is_uptime?: boolean;
}

interface ProxyListData {
  items?: ProxyListItem[];
  // khi không truyền type, API trả nhiều nhóm: { ipv4: { items: [] }, isp: { items: [] }, ... }
  [key: string]: any;
}

@Injectable()
export class ProxysellerProvider implements IProxyProvider {
  private readonly logger = new Logger(ProxysellerProvider.name);
  private readonly BASE_URL = 'https://proxy-seller.com/personal/api/v1';
  private readonly TIMEOUT_MS = 60_000;
  private readonly DEFAULT_TYPE = 'ipv4';

  // ─── Helper HTTP ─────────────────────────────────────────────────────────────

  /**
   * GET + body — fetch không cho phép, fallback sang raw node:https.
   * ProxySeller `/proxy/list/{type}` chỉ đọc params từ body, không từ query string.
   */
  private getWithBody<T>(
    path: string,
    body: Record<string, any>,
  ): Promise<PsResponse<T>> {
    return new Promise((resolve, reject) => {
      const url = new URL(`${this.BASE_URL}${path}`);
      const payload = JSON.stringify(body);
      const req = https.request(
        {
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname + url.search,
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
          timeout: this.TIMEOUT_MS,
        },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              resolve(JSON.parse(data) as PsResponse<T>);
            } catch {
              reject(
                new BadRequestException(
                  `ProxySeller invalid JSON: ${data.slice(0, 200)}`,
                ),
              );
            }
          });
        },
      );
      req.on('timeout', () => {
        req.destroy();
        reject(
          new BadRequestException(
            `ProxySeller API timeout after ${this.TIMEOUT_MS}ms`,
          ),
        );
      });
      req.on('error', (err) => {
        reject(
          new BadRequestException(`ProxySeller network error: ${err.message}`),
        );
      });
      req.write(payload);
      req.end();
    });
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, any>,
    query?: Record<string, string | number>,
  ): Promise<PsResponse<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.TIMEOUT_MS);

    let url = `${this.BASE_URL}${path}`;
    if (query && Object.keys(query).length) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
      }
      const qStr = qs.toString();
      if (qStr) url += `?${qStr}`;
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        signal: controller.signal,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body:    body ? JSON.stringify(body) : undefined,
      });
    } catch (err: any) {
      throw new BadRequestException(
        err?.name === 'AbortError'
          ? `ProxySeller API timeout after ${this.TIMEOUT_MS}ms`
          : `ProxySeller network error: ${err?.message}`,
      );
    } finally {
      clearTimeout(timer);
    }

    const data = (await res.json().catch(() => ({}))) as PsResponse<T>;
    return data;
  }

  private resolveType(raw?: string): string {
    const t = (raw || this.DEFAULT_TYPE).toLowerCase();
    const allowed = ['ipv4', 'ipv6', 'mobile', 'isp', 'mix', 'mix_isp', 'resident'];
    if (!allowed.includes(t)) {
      throw new BadRequestException(`ProxySeller: id_service "${raw}" không hợp lệ. Cho phép: ${allowed.join(', ')}`);
    }
    return t;
  }

  // Map duration_days → periodId theo format proxy-seller (1w, 2w, 1m, ...)
  private mapDurationToPeriodId(days: number): string | null {
    const map: Record<number, string> = {
      1: '1d',
      7: '1w',
      14: '2w',
      30: '1m',
      60: '2m',
      90: '3m',
      180: '6m',
      365: '1y',
    };
    return map[days] ?? null;
  }

  // ─── Mua proxy ───────────────────────────────────────────────────────────────

  async buy(params: ProviderBuyParams): Promise<BuyResult> {
    const {
      token_api: key,
      quantity,
      id_service,
      body_api,
      duration_days,
      user_id,
    } = params;

    const type = this.resolveType(id_service);

    // body_api JSON cho phép override mặc định (vd: { "periodId": "1m", "countryId": 20 })
    let extra: Record<string, any> = {};
    if (body_api) {
      try {
        const normalized = body_api.replace(/(\w+)\s*:/g, '"$1":');
        extra = JSON.parse(normalized);
      } catch {
        // bỏ qua, dùng object rỗng
      }
    }

    // periodId: ưu tiên body_api.periodId, fallback auto-map từ duration_days
    const periodId = extra.periodId ?? this.mapDurationToPeriodId(duration_days);
    if (!periodId) {
      throw new BadRequestException(
        `ProxySeller: không map được periodId cho duration_days=${duration_days}. ` +
          `Hỗ trợ: 1, 7, 14, 30, 60, 90, 180, 365. Hoặc set periodId trong body_api.`,
      );
    }

    // countryId: bắt buộc, luôn lấy từ body_api (vd: { "countryId": "1293" })
    if (
      extra.countryId === undefined ||
      extra.countryId === null ||
      extra.countryId === ''
    ) {
      throw new BadRequestException(
        'ProxySeller: thiếu countryId trong body_api của service',
      );
    }

    // customTargetName = "proxy" + userId để dễ trace từ phía ProxySeller
    const customTargetName: string = user_id
      ? `proxy${user_id}`
      : ((extra.customTargetName as string | undefined) ?? '');

    const payload: Record<string, any> = {
      countryId: String(extra.countryId),
      periodId: String(periodId),
      paymentId: String(extra.paymentId ?? 1), // 1 = balance
      quantity,
      customTargetName,
    };

    this.logger.log(`[BUY] type=${type} payload=${JSON.stringify(payload)}`);
    const raw = await this.request<OrderMakeData>(
      'POST',
      `/${key}/order/make`,
      payload,
    );
    this.logger.log(`[BUY] raw response: ${JSON.stringify(raw)}`);

    if (raw.status !== 'success' || !raw.data?.orderId) {
      throw new BadRequestException(`ProxySeller buy error: ${JSON.stringify(raw.errors ?? raw)}`);
    }

    return {
      // raw orderId — type lưu vào provider_metadata.proxyseller_type
      provider_order_id: String(raw.data.orderId),
      proxies: [], // lấy sau qua fetchOrderProxies
      provider_metadata: {
        proxyseller_order_id: raw.data.orderId,
        proxyseller_type: type,
        listBaseOrderNumbers: raw.data.listBaseOrderNumbers ?? [],
      },
      raw,
    };
  }

  // ─── Helper parse provider_order_id (backward-compat) ───────────────────────
  /**
   * Lấy `{ type, orderId }` từ provider_order_id + metadata.
   * - Format mới: provider_order_id = "4742113" (raw), type ← metadata.proxyseller_type
   * - Format cũ:  provider_order_id = "ipv4:4742113" (composed) → tách bằng dấu ":"
   */
  private parseOrderRef(
    provider_order_id: string,
    metadata?: Record<string, any>,
  ): { type: string; orderId: string } {
    if (provider_order_id.includes(':')) {
      const [t, id] = provider_order_id.split(':');
      return { type: t, orderId: id };
    }
    const metaType = metadata?.proxyseller_type as string | undefined;
    return {
      type: metaType || this.DEFAULT_TYPE,
      orderId: provider_order_id,
    };
  }

  // ─── Lấy proxy theo order ────────────────────────────────────────────────────

  async fetchOrderProxies(
    token_api: string,
    provider_order_id: string,
    context?: { metadata?: Record<string, any> },
  ): Promise<ProxyCredential[]> {
    const { type, orderId } = this.parseOrderRef(
      provider_order_id,
      context?.metadata,
    );

    const body = {
      orderId,
      latest: 'N',
      ends: 'Y',
    };

    this.logger.log(`[LIST] type=${type} orderId=${orderId}`);
    const raw = await this.getWithBody<ProxyListData>(
      `/${token_api}/proxy/list/${type}`,
      body,
    );
    this.logger.log(`[LIST] raw response: ${JSON.stringify(raw)}`);

    if (raw.status !== 'success' || !raw.data) {
      this.logger.warn(`[LIST] chưa có proxy cho orderId=${orderId} — trả [] để polling`);
      return [];
    }

    const items: ProxyListItem[] = Array.isArray(raw.data.items) ? raw.data.items : [];
    if (!items.length) {
      this.logger.warn(`[LIST] items rỗng cho orderId=${orderId} — trả [] để polling`);
      return [];
    }

    return items.map((item) => {
      const proto = (item.protocol || 'HTTP').toLowerCase();
      const port = proto === 'socks' || proto === 'socks5' ? item.port_socks : item.port_http;
      return {
        host: item.ip,
        port: Number(port),
        username: item.login,
        password: item.password,
        protocol: proto === 'socks' ? 'socks5' : proto, // chuẩn hoá về 'socks5'
        provider_proxy_id: String(item.id),
        country_code: (item.country_alpha3 || item.country || '').toLowerCase(),
        provider_metadata: item, // lưu nguyên raw item
      } as ProxyCredential;
    });
  }

  // ─── Gia hạn ─────────────────────────────────────────────────────────────────

  async renew(params: ProviderRenewParams): Promise<RenewResult> {
    const {
      token_api: key,
      provider_order_id,
      provider_proxy_ids,
      duration_days,
      id_service,
      provider_metadata,
    } = params;

    // ưu tiên ids = từng proxy id; fallback dùng orderId nếu không có
    const ids = provider_proxy_ids?.length
      ? provider_proxy_ids.map((x) => Number(x)).filter((x) => !isNaN(x))
      : [];

    if (!ids.length) {
      throw new BadRequestException(
        'ProxySeller renew: thiếu provider_proxy_ids',
      );
    }

    // Resolve type: provider_metadata.proxyseller_type > old "type:id" format > id_service > default
    const parsed = this.parseOrderRef(
      provider_order_id ?? '',
      provider_metadata as Record<string, any> | undefined,
    );
    const type = this.resolveType(
      parsed.type || id_service || this.DEFAULT_TYPE,
    );

    // periodId truyền qua id_service (vd: "ipv4|7" — type|periodId) nếu không có cách khác.
    // Tạm dùng duration_days map → periodId nếu khách dùng số ngày chuẩn của ProxySeller.
    const periodId = String(duration_days);

    const payload = {
      ids,
      periodId,
      paymentId: 1,
      coupon: '',
    };

    this.logger.log(`[RENEW] type=${type} payload=${JSON.stringify(payload)}`);
    const raw = await this.request<OrderMakeData>('POST', `/${key}/prolong/make/${type}`, payload);
    this.logger.log(`[RENEW] raw response: ${JSON.stringify(raw)}`);

    if (raw.status !== 'success' || !raw.data?.orderId) {
      throw new BadRequestException(`ProxySeller renew error: ${JSON.stringify(raw.errors ?? raw)}`);
    }

    return {
      success: true,
      raw,
    };
  }

  // ─── Xoay IP (reboot) ────────────────────────────────────────────────────────
  // Endpoint reboot ProxySeller dùng token gắn riêng cho từng proxy, không phải api key.
  // Vì interface chỉ có provider_order_id → chưa support được rotate đúng nghĩa.

  async rotate(_params: ProviderRotateParams): Promise<RotateResult> {
    throw new BadRequestException('ProxySeller: chưa hỗ trợ xoay IP qua API key chung');
  }

  // ─── Huỷ ─────────────────────────────────────────────────────────────────────

  async cancel(_params: ProviderCancelParams): Promise<void> {
    throw new BadRequestException('ProxySeller: chưa hỗ trợ huỷ đơn hàng');
  }
}
