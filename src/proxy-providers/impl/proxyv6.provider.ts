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
} from '../proxy-provider.interface';

/**
 * Provider mẫu cho ProxyV6.
 * Thay thế BASE_URL và cách map response theo tài liệu API thực tế của họ.
 *
 * Khi thêm provider mới, copy file này → đổi tên → implement lại các phương thức.
 */
@Injectable()
export class Proxyv6Provider implements IProxyProvider {
  private readonly BASE_URL = 'https://api.proxyv6.com/v1'; // ← thay bằng URL thực

  // ─── Helper gọi API ─────────────────────────────────────────────────────────

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    token: string,
    body?: Record<string, any>,
  ): Promise<T> {
    const res = await fetch(`${this.BASE_URL}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await res.json();

    if (!res.ok) {
      throw new BadRequestException(
        `ProxyV6 API error [${res.status}]: ${data?.message ?? 'Unknown error'}`,
      );
    }

    return data as T;
  }

  // ─── Mua proxy ──────────────────────────────────────────────────────────────

  async buy(params: ProviderBuyParams): Promise<BuyResult> {
    const raw = await this.request<any>('POST', '/orders/buy', params.token_api, {
      quantity:      params.quantity,
      duration_days: params.duration_days,
      country:       params.country_code,
      type:          params.proxy_type,
      protocol:      params.protocol,
      isp:           params.isp,
    });

    // ── Map response của ProxyV6 sang BuyResult ──────────────────────────────
    // Thay đổi mapping theo cấu trúc JSON thực tế trả về
    return {
      provider_order_id: String(raw.order_id ?? raw.id),
      proxies: (raw.proxies ?? []).map((p: any) => ({
        host:     p.ip ?? p.host,
        port:     Number(p.port),
        username: p.username ?? p.user,
        password: p.password ?? p.pass,
        protocol: p.protocol ?? params.protocol ?? 'http',
      })),
      raw,
    };
  }

  // ─── Gia hạn ────────────────────────────────────────────────────────────────

  async renew(params: ProviderRenewParams): Promise<RenewResult> {
    const raw = await this.request<any>('POST', '/orders/renew', params.token_api, {
      order_id:      params.provider_order_id,
      duration_days: params.duration_days,
    });

    return {
      success:      raw.success ?? true,
      new_end_date: raw.end_date ? new Date(raw.end_date) : undefined,
      raw,
    };
  }

  // ─── Xoay IP (rotating proxy) ───────────────────────────────────────────────

  async rotate(params: ProviderRotateParams): Promise<RotateResult> {
    const raw = await this.request<any>('POST', '/orders/rotate', params.token_api, {
      order_id: params.provider_order_id,
    });

    return {
      new_host: raw.new_ip ?? raw.host,
      raw,
    };
  }

  // ─── Huỷ order ──────────────────────────────────────────────────────────────

  async cancel(params: ProviderCancelParams): Promise<void> {
    await this.request<any>('POST', '/orders/cancel', params.token_api, {
      order_id: params.provider_order_id,
    });
  }
}
