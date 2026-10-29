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
} from '../proxy-provider.interface';

interface PsResponse<T> {
  status: 'success' | 'error';
  data: T | null;
  errors: { message: string; code: number; customData: any }[];
}

interface OrderMakeData {
  orderId: string | number;
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

@ProxyProvider('proxyseller')
export class ProxysellerProvider implements IProxyProvider {
  readonly capabilities = { buy: true, renew: true, rotate: false, cancel: false, countrySelection: true };

  private readonly logger = new Logger(ProxysellerProvider.name);
  private readonly BASE_URL = 'https://proxy-seller.com/personal/api/v1';
  private readonly TIMEOUT_MS = 60_000;
  private readonly DEFAULT_TYPE = 'ipv4';

  // ─── Helper HTTP ─────────────────────────────────────────────────────────────

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, any>,
    query?: Record<string, string | number>,
    apiVersion: 'v1' | 'v2' = 'v1',
  ): Promise<PsResponse<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.TIMEOUT_MS);

    let url = `${this.BASE_URL.replace(/v1$/, apiVersion)}${path}`;
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

    if (params.country_policy_configured) {
      if (!params.country_code || !params.country_provider_value) {
        throw new BadRequestException('ProxySeller requires a configured countryId mapping');
      }
      extra.countryId = params.country_provider_value;
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

    // Protocol: chỉ gửi nếu service config (body_api.protocol) hoặc order (params.protocol) có yêu cầu.
    // ProxySeller chấp nhận "HTTP" hoặc "SOCKS" — chuẩn hoá từ socks/socks5 → "SOCKS", còn lại → "HTTP".
    const rawProto = String(extra.protocol ?? params.protocol ?? '').toLowerCase();
    if (rawProto) {
      payload.protocol = rawProto === 'socks' || rawProto === 'socks5' ? 'SOCKS' : 'HTTP';
    }

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
    context?: { metadata?: Record<string, any>; protocol?: string },
  ): Promise<ProxyCredential[]> {
    const { type, orderId } = this.parseOrderRef(
      provider_order_id,
      context?.metadata,
    );

    this.logger.log(`[LIST] type=${type} orderId=${orderId}`);
    const raw = await this.request<ProxyListData>(
      'GET',
      `/${token_api}/proxy/list/${type}`,
      undefined,
      { orderId },
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

    // Chọn port theo protocol ĐÃ MUA (order): HTTP → port_http, SOCKS5 → port_socks.
    // Fallback item.protocol nếu order không truyền protocol.
    const orderProto = String(context?.protocol ?? '').toLowerCase();
    return items.map((item) => {
      const proto = orderProto || (item.protocol || 'HTTP').toLowerCase();
      const isSocks = proto === 'socks' || proto === 'socks5';
      const port = isSocks ? item.port_socks : item.port_http;
      return {
        host: item.ip,
        port: Number(port),
        username: item.login,
        password: item.password,
        protocol: isSocks ? 'socks5' : 'http', // chuẩn hoá: http | socks5
        provider_proxy_id: String(item.id),
        country_code: (item.country_alpha3 || item.country || '').toLowerCase(),
        provider_metadata: item, // lưu nguyên raw item
      } as ProxyCredential;
    });
  }

  // ─── Gia hạn ─────────────────────────────────────────────────────────────────

  private async resolveRenewalPeriodId(key: string, type: string, days: number): Promise<string> {
    const raw = await this.request<{ items?: { period?: unknown } }>(
      'GET', `/${key}/reference/list/${type}`, undefined, undefined, 'v2',
    );
    if (raw?.status !== 'success') {
      throw new BadRequestException(`ProxySeller renewal reference lookup failed: ${JSON.stringify(raw?.errors ?? [])}`);
    }
    const periods = raw.data?.items?.period;
    if (!Array.isArray(periods)) {
      throw new BadRequestException('ProxySeller renewal reference: missing data.items.period array');
    }
    const positiveDays = (value: unknown): number | undefined => {
      if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) return undefined;
      const n = Number(value);
      return Number.isSafeInteger(n) && n > 0 ? n : undefined;
    };
    const codeDays = (value: unknown): number | undefined => {
      if (typeof value !== 'string') return undefined;
      // Machine codes only; numeric IDs and localized display names are not durations.
      const match = /^(\d+)(d|w|m|y)$/.exec(value);
      if (!match) return undefined;
      return positiveDays(Number(match[1]) * ({ d: 1, w: 7, m: 30, y: 365 }[match[2]]!));
    };
    const matches: string[] = [];
    for (const entry of periods) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const id = entry.id;
      const validId = (typeof id === 'string' && id.trim().length > 0) ||
        (typeof id === 'number' && Number.isSafeInteger(id) && id > 0);
      const explicit = [entry.days, entry.period].filter(value => value !== undefined && value !== null);
      const durations = explicit.length
        ? explicit.map(value => positiveDays(value) ?? codeDays(value))
        : [entry.id, entry.code, entry.value].map(codeDays).filter(value => value !== undefined);
      if (!durations.includes(days)) continue;
      if (!validId || durations.some(value => value !== days)) {
        throw new BadRequestException(`ProxySeller renewal reference: ambiguous period for ${days} days (${type})`);
      }
      matches.push(String(id));
    }
    // Even repeated rows are rejected: do not silently choose one catalog entry.
    if (matches.length !== 1) {
      throw new BadRequestException(`ProxySeller renewal reference: ${matches.length ? 'ambiguous period' : 'no matching period'} for ${days} days (${type})`);
    }
    return matches[0];
  }

  private renewalPayload(params: ProviderRenewParams) {
    const {
      provider_order_id,
      provider_proxy_ids,
      duration_days,
      id_service,
      provider_metadata,
    } = params;

    const ids = (provider_proxy_ids ?? []).map(String).filter(Boolean);

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
      provider_metadata?.proxyseller_type || (provider_order_id?.includes(':') ? parsed.type : id_service) || this.DEFAULT_TYPE,
    );
    if (type === 'resident') throw new BadRequestException('ProxySeller: resident không hỗ trợ endpoint gia hạn này');
    if (!Number.isSafeInteger(duration_days) || duration_days <= 0) {
      throw new BadRequestException('ProxySeller: renewal duration_days must be a positive integer');
    }
    const byOrder = ['ipv6', 'mix', 'mix_isp'].includes(type);
    if (byOrder && !parsed.orderId) throw new BadRequestException('ProxySeller renew: thiếu provider_order_id');
    const payload = {
      ...(byOrder ? { orderIds: [parsed.orderId] } : { ids }),
      paymentId: 'balance',
      coupon: '',
    };
    return { type, payload };
  }

  validateRenew(params: ProviderRenewParams): void {
    this.renewalPayload(params);
  }

  async renew(params: ProviderRenewParams): Promise<RenewResult> {
    const { type, payload: selection } = this.renewalPayload(params);
    const periodId = await this.resolveRenewalPeriodId(params.token_api, type, params.duration_days);
    const payload = { ...selection, periodId };

    this.logger.log(`[RENEW] type=${type} payload=${JSON.stringify(payload)}`);
    const raw = await this.request<OrderMakeData>('POST', `/${params.token_api}/prolong/make/${type}`, payload, undefined, 'v2');
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
