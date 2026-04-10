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

interface BuyResponse {
  maloi: number;
  order_code: string;
}

interface ListProxyResponseItem {
  maloi: number;
  idproxy: string;
  loaiproxy: string;
  proxy: string;       // "host:port:username:password"
  ip: string;
  time: string;         // epoch seconds
  type: string;
}

@Injectable()
export class TwoProxyProvider implements IProxyProvider {
  private readonly logger     = new Logger(TwoProxyProvider.name);
  private readonly BASE_URL   = 'https://app.2proxy.vn/api/proxy.php';
  private readonly TIMEOUT_MS = 60_000;

  // ─── Helper HTTP ─────────────────────────────────────────────────────────────

  private async request<T>(params: Record<string, string | number>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.TIMEOUT_MS);

    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }

    let res: Response;
    try {
      res = await fetch(`${this.BASE_URL}?${qs.toString()}`, {
        method: 'GET',
        signal: controller.signal,
      });
    } catch (err: any) {
      throw new BadRequestException(
        err?.name === 'AbortError'
          ? `2Proxy API timeout after ${this.TIMEOUT_MS}ms`
          : `2Proxy network error: ${err?.message}`,
      );
    } finally {
      clearTimeout(timer);
    }

    const data = await res.json().catch(() => ({}));
    return data as T;
  }

  // ─── Parse "host:port:username:password" ────────────────────────────────────

  private parseProxyString(proxyStr: string): ProxyCredential {
    const parts = proxyStr.split(':');
    return {
      host:     parts[0] ?? '',
      port:     Number(parts[1] ?? 0),
      username: parts[2] ?? '',
      password: parts[3] ?? '',
      protocol: 'http',
    };
  }

  // ─── Mua proxy ──────────────────────────────────────────────────────────────
  // API mua trả về order_code, sau đó phải gọi listproxy để lấy proxy.

  async buy(params: ProviderBuyParams): Promise<BuyResult> {
    const { token_api: key, quantity, duration_days, id_service } = params;

    if (!id_service) {
      throw new BadRequestException('2Proxy: thiếu id_service (loaiproxy)');
    }

    // Bước 1: Mua đơn
    this.logger.log(`[BUY] gọi API với loaiproxy=${id_service}, quantity=${quantity}, ngay=${duration_days}`);
    const buyRaw = await this.request<BuyResponse | null>({
      key,
      sukien: 'mua',
      loaiproxy: id_service,
      quantity,
      ngay: duration_days,
    });
    this.logger.log(`[BUY] raw response: ${JSON.stringify(buyRaw)}`);

    if (!buyRaw) {
      throw new BadRequestException(`2Proxy: API trả về response rỗng hoặc null`);
    }

    if (!buyRaw || buyRaw.maloi !== 0 || !buyRaw.order_code) {
      throw new BadRequestException(
        `2Proxy buy error${!buyRaw ? ' (response rỗng/null)' : ` [maloi=${buyRaw.maloi}]`}: ${JSON.stringify(buyRaw ?? {})}`,
      );
    }

    this.logger.log(`[BUY] order_code=${buyRaw.order_code}`);

    // Proxy sẽ được lấy sau qua fetchOrderProxies (đơn async, proxy chưa ready ngay)
    return {
      provider_order_id: buyRaw.order_code,
      proxies: [],
      raw: { buy: buyRaw },
    };
  }

  // ─── Lấy proxy theo mã đơn ──────────────────────────────────────────────────

  async fetchOrderProxies(token_api: string, provider_order_id: string): Promise<ProxyCredential[]> {
    this.logger.log(`[LISTPROXY] gọi API với ma_don_hang=${provider_order_id}`);

    const raw = await this.request<ListProxyResponseItem[] | null>({
      key: token_api,
      sukien: 'listproxy',
      ma_don_hang: provider_order_id,
    });

    this.logger.log(`[LISTPROXY] raw response: ${JSON.stringify(raw)}`);

    // Trả [] thay vì throw — để worker polling tiếp
    if (!raw) {
      this.logger.warn(`[LISTPROXY] response null cho ma_don_hang=${provider_order_id} — trả [] để polling`);
      return [];
    }

    const items = Array.isArray(raw) ? raw : [raw];

    // maloi != 0 → chưa có proxy (đơn async, proxy chưa ready)
    const proxyItems = items.filter((item) => item.maloi === 0 && item.proxy);

    if (!proxyItems.length) {
      this.logger.warn(`[LISTPROXY] chưa có proxy cho ma_don_hang=${provider_order_id} — trả [] để polling`);
      return [];
    }

    return proxyItems.map((item) => {
      const cred = this.parseProxyString(item.proxy);
      return {
        ...cred,
        provider_proxy_id: item.idproxy,
        isp:               item.loaiproxy ?? '',
        location:          item.ip ?? undefined,
      };
    });
  }

  // ─── Gia hạn ────────────────────────────────────────────────────────────────

  async renew(params: ProviderRenewParams): Promise<RenewResult> {
    const { token_api: key, provider_proxy_ids, duration_days, id_service } = params;

    if (!provider_proxy_ids?.length) {
      throw new BadRequestException('2Proxy renew: thiếu provider_proxy_ids');
    }

    if (!id_service) {
      throw new BadRequestException('2Proxy renew: thiếu id_service (loaiproxy)');
    }

    // Gia hạn từng proxy
    const results = await Promise.all(
      provider_proxy_ids.map((idproxy) =>
        this.request<{ maloi: number; message?: string }>({
          key,
          sukien: 'gia_han',
          idproxy,
          ngay: duration_days,
          loaiproxy: id_service,
        }),
      ),
    );

    this.logger.log(`[RENEW] raw response: ${JSON.stringify(results)}`);

    const failed = results.filter((r) => !r || r.maloi !== 0);
    if (failed.length > 0) {
      throw new BadRequestException(
        `2Proxy renew error: ${JSON.stringify(failed)}`,
      );
    }

    return {
      success: true,
      raw: results,
    };
  }

  // ─── Xoay IP ─────────────────────────────────────────────────────────────────

  async rotate(_params: ProviderRotateParams): Promise<RotateResult> {
    throw new BadRequestException('2Proxy: chưa hỗ trợ xoay IP');
  }

  // ─── Huỷ ─────────────────────────────────────────────────────────────────────

  async cancel(_params: ProviderCancelParams): Promise<void> {
    throw new BadRequestException('2Proxy: chưa hỗ trợ huỷ đơn hàng');
  }
}
