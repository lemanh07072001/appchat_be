import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { Proxy } from '../schemas/proxies.schema';
import { Order } from '../schemas/orders.schema';

export type CheckResult = {
  proxy_id: string;
  alive: boolean;
  ip?: string;
  latency_ms?: number;
  error?: string;
};

// Lightweight endpoints returning the caller IP — both for redundancy in case one is blocked
// by the proxy's upstream filters.
const TEST_URLS = [
  'https://api.ipify.org?format=json',
  'https://ifconfig.me/ip',
];
const TIMEOUT_MS = 10_000;

@Injectable()
export class ProxyCheckService {
  constructor(
    @InjectModel(Proxy.name) private readonly proxyModel: Model<Proxy>,
    @InjectModel(Order.name) private readonly orderModel: Model<Order>,
  ) {}

  async checkOne(proxyId: string, userId: string): Promise<CheckResult> {
    if (!Types.ObjectId.isValid(proxyId)) throw new NotFoundException('Invalid proxy id');
    const proxy = await this.proxyModel.findById(proxyId).lean();
    if (!proxy) throw new NotFoundException('Proxy not found');

    const order = await this.orderModel
      .findById(proxy.order_id)
      .select('user_id')
      .lean();
    if (!order) throw new NotFoundException('Owning order not found');
    if (String(order.user_id) !== String(userId))
      throw new ForbiddenException('You do not own this proxy');

    return this.runCheck(proxy);
  }

  async checkMany(orderId: string, userId: string): Promise<CheckResult[]> {
    if (!Types.ObjectId.isValid(orderId)) throw new NotFoundException('Invalid order id');
    const order = await this.orderModel.findById(orderId).select('user_id').lean();
    if (!order) throw new NotFoundException('Order not found');
    if (String(order.user_id) !== String(userId))
      throw new ForbiddenException('You do not own this order');

    const proxies = await this.proxyModel.find({ order_id: orderId }).lean();
    const results = await Promise.allSettled(proxies.map((p) => this.runCheck(p)));
    return results.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : {
            proxy_id: String(proxies[i]._id),
            alive: false,
            error: (r.reason as Error)?.message || 'Unhandled error',
          },
    );
  }

  private async runCheck(proxy: any): Promise<CheckResult> {
    const proxyId = String(proxy._id);
    if (proxy.cdk_key) {
      // CDK / rotating-key orders: no direct host to dial — skip.
      return { proxy_id: proxyId, alive: false, error: 'CDK / rotating key — không hỗ trợ check trực tiếp' };
    }

    const host = proxy.ip_address || proxy.domain;
    const port = proxy.port;
    const user = encodeURIComponent(proxy.auth_username ?? '');
    const pass = encodeURIComponent(proxy.auth_password ?? '');
    const protocol = String(proxy.protocol || 'http').toLowerCase();

    if (!host || !port) {
      return { proxy_id: proxyId, alive: false, error: 'Thiếu host/port' };
    }

    const auth = user && pass ? `${user}:${pass}@` : '';
    let agent: any;
    try {
      if (protocol === 'socks5' || protocol === 'socks4' || protocol === 'socks') {
        const scheme = protocol === 'socks4' ? 'socks4' : 'socks5';
        agent = new SocksProxyAgent(`${scheme}://${auth}${host}:${port}`);
      } else {
        agent = new HttpsProxyAgent(`http://${auth}${host}:${port}`);
      }
    } catch (err: any) {
      return { proxy_id: proxyId, alive: false, error: `Cấu hình agent lỗi: ${err?.message ?? err}` };
    }

    let lastErr: any;
    for (const url of TEST_URLS) {
      const start = Date.now();
      try {
        const res = await axios.get(url, {
          httpAgent: agent,
          httpsAgent: agent,
          timeout: TIMEOUT_MS,
          proxy: false,
          responseType: 'text',
          validateStatus: (s) => s >= 200 && s < 400,
        });
        const latency = Date.now() - start;
        const ip = this.parseIp(res.data);
        return { proxy_id: proxyId, alive: true, ip, latency_ms: latency };
      } catch (err: any) {
        lastErr = err;
      }
    }
    return {
      proxy_id: proxyId,
      alive: false,
      error: lastErr?.code || lastErr?.message || 'Không kết nối được',
    };
  }

  private parseIp(body: unknown): string | undefined {
    if (typeof body !== 'string') {
      if (body && typeof body === 'object' && 'ip' in (body as any)) return String((body as any).ip);
      return undefined;
    }
    const trimmed = body.trim();
    // Try JSON first, then raw text
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && 'ip' in parsed) return String(parsed.ip);
    } catch {
      // not JSON
    }
    // Heuristic: bare IP body
    if (/^[0-9a-f.:]+$/i.test(trimmed)) return trimmed;
    return undefined;
  }
}
