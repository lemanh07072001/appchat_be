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

@ProxyProvider('proxyvn')
export class ProxyvnProvider implements IProxyProvider {
  readonly capabilities = { buy: true, renew: true, rotate: true, cancel: true };

  private readonly logger     = new Logger(ProxyvnProvider.name);
  private readonly BASE_URL   = 'https://proxy.vn/apiv2';
  private readonly TIMEOUT_MS = 30_000;

  // ─── Helper HTTP ─────────────────────────────────────────────────────────────

  private async request<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
      });
    } catch (err: any) {
      throw new BadRequestException(
        err?.name === 'AbortError'
          ? `ProxyVN API timeout after ${this.TIMEOUT_MS}ms`
          : `ProxyVN network error: ${err?.message}`,
      );
    } finally {
      clearTimeout(timer);
    }

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new BadRequestException(
        `ProxyVN API error [${res.status}]: ${JSON.stringify(data)}`,
      );
    }

    return data as T;
  }

  // ─── Map status code thành lỗi ──────────────────────────────────────────────

  private checkError(items: any[]): void {
    for (const item of items) {
      const s = item?.status;
      if (s === 100 || s === 200 || s === 201) continue;

      const messages: Record<number, string> = {
        101: 'Key không tồn tại',
        102: 'Không đủ tiền',
        103: 'Loại proxy này đang hết hàng',
        104: 'Lỗi không xác định',
      };
      throw new BadRequestException(
        `ProxyVN error [${s}]: ${messages[s] ?? item?.comen ?? 'Unknown'}`,
      );
    }
  }

  // ─── Mua proxy ──────────────────────────────────────────────────────────────

  async buy(params: ProviderBuyParams): Promise<BuyResult> {
    const {
      token_api: key,
      quantity,
      duration_days,
      protocol,
      id_service,
    } = params;

    const type = protocol?.toUpperCase() === 'SOCKS5' ? 'SOCKS5' : 'HTTP';
    if (!id_service) {
      throw new BadRequestException('ProxyVN: thiếu id_service (loaiproxy)');
    }
    const loaiproxy = id_service;

    const url =
      `${this.BASE_URL}/muaproxy.php` +
      `?key=${encodeURIComponent(key)}` +
      `&loaiproxy=${encodeURIComponent(loaiproxy)}` +
      `&soluong=${quantity}` +
      `&ngay=${duration_days}` +
      `&type=${type}` +
      `&user=random` +
      `&password=random`;

    const safeUrl = url.replace(/key=[^&]+/, 'key=***');
    this.logger.log(`[BUY] → ${safeUrl}`);

    const raw = await this.request<any[]>(url);

    this.logger.debug(`[BUY] ← response: ${JSON.stringify(raw)}`);

    // raw là mảng: các item proxy (status=100) + item summary (status=200/201)
    const items = Array.isArray(raw) ? raw : [raw];
    this.checkError(items);

    // ProxyVN trả về user có prefix timestamp + 2 ký tự (vd: "1775392699mdYJyLNo")
    // Auth username thực tế chỉ là phần suffix random sau prefix. Cắt prefix để lưu đúng.
    const stripUserPrefix = (raw: string) => (raw ?? '').replace(/^\d{10}.{2}/, '');

    const proxies: ProxyCredential[] = items
      .filter((item) => item?.status === 100)
      .map((item) => {
        // Chuẩn hoá protocol về enum ProxyProtocolEnum (http/https/socks5):
        // - "HTTPS" → "http" (proxy không phân biệt http/https phía client)
        // - "SOCKS" → "socks5" (tránh Mongoose drop validation âm thầm)
        const rawProto = (item.type ?? type).toLowerCase().replace('https', 'http');
        const normalizedProto = rawProto === 'socks' ? 'socks5' : rawProto;
        return ({
        host:              item.ip,
        port:              Number(item.port),
        username:          stripUserPrefix(item.user),
        password:          item.password ?? '',
        protocol:          normalizedProto,
        provider_proxy_id: item.idproxy,
        isp:               item.loaiproxy ?? loaiproxy,
        });
      });

    return { provider_order_id: '', proxies, raw };
  }

  // ─── Gia hạn ────────────────────────────────────────────────────────────────

  async renew(params: ProviderRenewParams): Promise<RenewResult> {
    const { token_api: key, duration_days, provider_proxy_ids, id_service } = params;

    if (!provider_proxy_ids?.length) {
      throw new BadRequestException('ProxyVN: không có proxy nào để gia hạn');
    }
    if (!id_service) {
      throw new BadRequestException('ProxyVN: thiếu id_service (loaiproxy)');
    }

    const results: { idproxy: string; success: boolean; message?: string; time?: number }[] = [];

    for (const idproxy of provider_proxy_ids) {
      const url =
        `${this.BASE_URL}/giahanproxy.php` +
        `?key=${encodeURIComponent(key)}` +
        `&loaiproxy=${encodeURIComponent(id_service)}` +
        `&ngay=${duration_days}` +
        `&idproxy=${encodeURIComponent(idproxy)}`;

      const safeUrl = url.replace(/key=[^&]+/, 'key=***');
      this.logger.log(`[RENEW] → ${safeUrl}`);

      try {
        const raw = await this.request<any>(url);
        this.logger.debug(`[RENEW] ← idproxy=${idproxy}: ${JSON.stringify(raw)}`);

        const items = Array.isArray(raw) ? raw : [raw];
        this.checkError(items);

        // Lấy `time` (epoch seconds — thời gian proxy hết hạn) từ response
        const timeField = items.find((i) => i?.status === 100 && i?.time)?.time;
        results.push({ idproxy, success: true, time: timeField ? Number(timeField) : undefined });
      } catch (err: any) {
        this.logger.error(`[RENEW] ✗ idproxy=${idproxy}: ${err?.message}`);
        results.push({ idproxy, success: false, message: err?.message });
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;

    if (successCount === 0) {
      throw new BadRequestException(
        `ProxyVN: gia hạn thất bại tất cả ${failCount} proxy — ${results.map(r => r.message).join('; ')}`,
      );
    }

    // Lấy thời điểm hết hạn xa nhất trong tất cả proxy đã gia hạn thành công
    const maxTime = results
      .filter((r) => r.success && r.time)
      .reduce((max, r) => Math.max(max, r.time!), 0);
    const new_end_date = maxTime > 0 ? new Date(maxTime * 1000) : undefined;

    return {
      success: true,
      new_end_date,
      raw: { results, successCount, failCount },
    };
  }

  // ─── Lấy lại proxy theo idproxy ──────────────────────────────────────────────
  // ProxyVN không có "order id"; list proxy theo loaiproxy + idproxy (danh sách
  // id, cách nhau dấu phẩy). Dùng để admin refresh dữ liệu proxy đã chọn.

  async fetchProxiesByIds(
    token_api: string,
    provider_proxy_ids: string[],
    context?: { id_service?: string },
  ): Promise<ProxyCredential[]> {
    const loaiproxy = (context?.id_service ?? '').trim();
    if (!loaiproxy) {
      throw new BadRequestException(
        'ProxyVN: thiếu loaiproxy (id_service = order.config.isp) để list proxy',
      );
    }

    const ids = (provider_proxy_ids ?? [])
      .map((x) => String(x).trim())
      .filter(Boolean);
    const idParam = ids.length ? ids.join(',') : 'all';

    const url =
      `${this.BASE_URL}/listproxy.php` +
      `?key=${encodeURIComponent(token_api)}` +
      `&loaiproxy=${encodeURIComponent(loaiproxy)}` +
      `&idproxy=${encodeURIComponent(idParam)}`;

    const safeUrl = url.replace(/key=[^&]+/, 'key=***');
    this.logger.log(`[LISTPROXY] → ${safeUrl}`);

    const raw = await this.request<any[]>(url);
    this.logger.debug(`[LISTPROXY] ← ${JSON.stringify(raw)}`);

    const items = Array.isArray(raw) ? raw : [raw];
    const wanted = new Set(ids);

    return items
      // listproxy.php trả proxy gộp dạng "ip:port:user:pass" trong field `proxy`
      // (khác muaproxy.php có field port/user/password rời) — phải tách chuỗi.
      .filter((item) => item && (item.proxy || item.ip))
      // chỉ giữ đúng idproxy đã yêu cầu (an toàn khi API trả 'all')
      .filter((item) => wanted.size === 0 || wanted.has(String(item.idproxy)))
      .map((item) => {
        const parts = String(item.proxy ?? '').split(':');
        const rawProto = String(item.type ?? 'http').toLowerCase().replace('https', 'http');
        const normalizedProto = rawProto === 'socks' ? 'socks5' : rawProto;
        return {
          host:              parts[0] || item.ip,
          port:              Number(parts[1]),
          username:          parts[2] ?? '',
          password:          parts[3] ?? '',
          protocol:          normalizedProto,
          provider_proxy_id: String(item.idproxy ?? ''),
          isp:               loaiproxy,
        } as ProxyCredential;
      });
  }

  // ─── Xoay IP ────────────────────────────────────────────────────────────────
  // TODO: implement khi có tài liệu API rotate của ProxyVN

  async rotate(params: ProviderRotateParams): Promise<RotateResult> {
    throw new BadRequestException('ProxyVN: API rotate chưa được implement');
  }

  // ─── Huỷ ────────────────────────────────────────────────────────────────────
  // TODO: implement khi có tài liệu API cancel của ProxyVN

  async cancel(params: ProviderCancelParams): Promise<void> {
    throw new BadRequestException('ProxyVN: API huỷ chưa được implement');
  }
}
