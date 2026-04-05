import { Injectable, BadRequestException } from '@nestjs/common';
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
export class ProxysieutocProvider implements IProxyProvider {
  private readonly BASE_URL   = 'https://proxysieutoc.com/api/apiv1';
  private readonly TIMEOUT_MS = 30_000;

  // ─── Helper HTTP ─────────────────────────────────────────────────────────────

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    params: Record<string, string | number>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.TIMEOUT_MS);

    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }

    const url = `${this.BASE_URL}${path}?${qs.toString()}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        signal: controller.signal,
      });
    } catch (err: any) {
      throw new BadRequestException(
        err?.name === 'AbortError'
          ? `ProxySieuToc API timeout after ${this.TIMEOUT_MS}ms`
          : `ProxySieuToc network error: ${err?.message}`,
      );
    } finally {
      clearTimeout(timer);
    }

    const data = await res.json().catch(() => ({}));

    if (data?.status !== 'SUCCESS') {
      throw new BadRequestException(
        `ProxySieuToc API error: ${data?.message ?? JSON.stringify(data)}`,
      );
    }

    return data as T;
  }

  // ─── Parse proxy string "host:port:username:password" ────────────────────────

  private parseProxy(proxyStr: string, proxyIpStr?: string): ProxyCredential {
    const parts = proxyStr.split(':');
    const ipParts = proxyIpStr?.split(':');

    return {
      host:     ipParts?.[0] ?? parts[0] ?? '',
      port:     Number(ipParts?.[1] ?? parts[1] ?? 0),
      username: parts[2] ?? '',
      password: parts[3] ?? '',
      protocol: 'http',
      domain:   parts[0] ?? undefined,
    };
  }

  // ─── Mua proxy ───────────────────────────────────────────────────────────────

  async buy(params: ProviderBuyParams): Promise<BuyResult> {
    interface BuyResponse {
      status: string;
      statusCode: number;
      message: string;
      order_code: string;
      name_product: string;
      id_product: number;
      value_order: number;
      quantity: number;
      note: string;
      proxies: string[];
      proxiesip: string[];
      timeday: string;
      timestamp: number;
    }

    // Parse body_api JSON để lấy id_product, VD: "{ id_product: 2629 }"
    let idProduct = '';
    if (params.body_api) {
      try {
        // Hỗ trợ cả JSON chuẩn và JSON không có quotes ở key
        const normalized = params.body_api.replace(/(\w+)\s*:/g, '"$1":');
        const parsed = JSON.parse(normalized);
        idProduct = String(parsed.id_product ?? '');
      } catch {
        // Fallback: regex lấy số sau "id_product"
        const match = params.body_api.match(/id_product\s*[:=]\s*(\d+)/);
        idProduct = match?.[1] ?? '';
      }
    }

    if (!idProduct) {
      throw new BadRequestException('ProxySieuToc: thiếu id_product trong body_api');
    }

    const raw = await this.request<BuyResponse>('POST', '/buy.php', {
      token:      params.token_api,
      id_product: idProduct,
      quantity:   params.quantity,
      note:       `order_${Date.now()}`,
    });

    if (!raw.order_code) {
      throw new BadRequestException('ProxySieuToc không trả về order_code');
    }

    // Map proxies + proxiesip → ProxyCredential[]
    const proxies: ProxyCredential[] = (raw.proxies ?? []).map((p, i) =>
      this.parseProxy(p, raw.proxiesip?.[i]),
    );

    return {
      provider_order_id: raw.order_code,
      proxies,
      raw,
    };
  }

  // ─── Gia hạn ─────────────────────────────────────────────────────────────────
  // ProxySieuToc chưa có API renew → throw lỗi

  async renew(_params: ProviderRenewParams): Promise<RenewResult> {
    throw new BadRequestException('ProxySieuToc chưa hỗ trợ gia hạn proxy');
  }

  // ─── Xoay IP ─────────────────────────────────────────────────────────────────
  // ProxySieuToc chưa có API rotate → throw lỗi

  async rotate(_params: ProviderRotateParams): Promise<RotateResult> {
    throw new BadRequestException('ProxySieuToc chưa hỗ trợ xoay IP');
  }

  // ─── Huỷ ─────────────────────────────────────────────────────────────────────
  // ProxySieuToc chưa có API cancel → throw lỗi

  async cancel(_params: ProviderCancelParams): Promise<void> {
    throw new BadRequestException('ProxySieuToc chưa hỗ trợ huỷ đơn hàng');
  }
}
