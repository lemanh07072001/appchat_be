import { Injectable, BadRequestException } from '@nestjs/common';
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
} from '../proxy-provider.interface';

@Injectable()
export class HomeproxyProvider implements IProxyProvider {
  private readonly BASE_URL    = 'https://api.homeproxy.vn/api';
  private readonly TIMEOUT_MS  = 30_000;
  private readonly MAX_PAGES   = 50;

  // ─── Helper HTTP ─────────────────────────────────────────────────────────────

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    token: string,
    body?: Record<string, any>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(`${this.BASE_URL}${path}`, {
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

    if (!res.ok) {
      throw new BadRequestException(
        `HomeProxy API error [${res.status}]: ${data?.message ?? JSON.stringify(data)}`,
      );
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
    const { user, password } = this.generateCredentials();

    const rotateInterval = params.rotate_interval ?? 0;
    const isCdk          = params.is_cdk ?? false;

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
          location:       'random',
          provider:       params.isp?.toUpperCase() || 'HOMEPROXY',
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

    return allItems.map((p: any) => ({
      host:              p.proxy?.ipaddress?.ip ?? p.proxy?.ipaddress?.domain ?? '',
      port:              Number(p.proxy?.port ?? 0),
      username:          p.proxy?.username ?? '',
      password:          p.proxy?.password ?? '',
      protocol:          (p.protocol ?? 'http').toLowerCase(),
      provider_proxy_id: p.id != null ? String(p.id) : undefined,
      domain:            p.proxy?.ipaddress?.domain ?? undefined,
      prev_ip:           p.proxy?.ipaddress?.prevIp ?? undefined,
      location:          p.proxy?.ipaddress?.location ?? undefined,
      isp:               p.proxy?.ipaddress?.provider ?? undefined,
    }));
  }

  // ─── Gia hạn ─────────────────────────────────────────────────────────────────
  // TODO: cập nhật khi có tài liệu API gia hạn của HomeProxy

  async renew(params: ProviderRenewParams): Promise<RenewResult> {
    const raw = await this.request<any>('POST', '/orders/renew', params.token_api, {
      orderId:      params.provider_order_id,
      dayOfUse:     params.duration_days,
    });

    return {
      success:      raw.success ?? true,
      new_end_date: raw.endDate ? new Date(raw.endDate) : undefined,
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
