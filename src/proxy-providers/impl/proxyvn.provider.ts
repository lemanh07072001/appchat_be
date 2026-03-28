import { Injectable, BadRequestException, Logger } from '@nestjs/common';
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

@Injectable()
export class ProxyvnProvider implements IProxyProvider {
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

    const proxies: ProxyCredential[] = items
      .filter((item) => item?.status === 100)
      .map((item) => ({
        host:              item.ip,
        port:              Number(item.port),
        username:          item.user ?? '',
        password:          item.password ?? '',
        protocol:          (item.type ?? type).toLowerCase().replace('https', 'http'),
        provider_proxy_id: item.idproxy,
        isp:               item.loaiproxy ?? loaiproxy,
      }));

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

    const results: { idproxy: string; success: boolean; message?: string }[] = [];

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
        results.push({ idproxy, success: true });
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

    return {
      success: true,
      raw: { results, successCount, failCount },
    };
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
