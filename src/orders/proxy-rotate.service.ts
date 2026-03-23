import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Proxy, ProxyDocument } from '../schemas/proxies.schema';
import { Order, OrderDocument } from '../schemas/orders.schema';
import { Partner, PartnerDocument } from '../schemas/partners.schema';
import { REDIS_CLIENT } from '../redis/redis.module';
import type { Redis } from 'ioredis';

const ROTATE_CACHE_PREFIX = 'proxy:cdk:rotate:';
const HOMEPROXY_BASE_URL  = 'https://api.homeproxy.vn/api';
const TIMEOUT_MS          = 15_000;

interface RotateCacheEntry {
  result: any;
  cachedAt: number;       // Unix ms lúc lưu cache
  originalRemaining: number; // timeRemaining gốc từ API (giây)
}

@Injectable()
export class ProxyRotateService {
  private readonly logger = new Logger(ProxyRotateService.name);

  constructor(
    @InjectModel(Proxy.name)   private readonly proxyModel:   Model<ProxyDocument>,
    @InjectModel(Order.name)   private readonly orderModel:   Model<OrderDocument>,
    @InjectModel(Partner.name) private readonly partnerModel: Model<PartnerDocument>,
    @Inject(REDIS_CLIENT)      private readonly redis:        Redis,
  ) {}

  async rotateByCdkKey(cdkKey: string) {
    // ── 1. Tìm proxy theo cdk_key ──────────────────────────────────────────────
    const proxy = await this.proxyModel
      .findOne({ cdk_key: cdkKey })
      .select('_id provider_proxy_id order_id ip_address port auth_username auth_password')
      .lean()
      .exec();

    if (!proxy) throw new NotFoundException('Key không hợp lệ hoặc không tồn tại');
    if (!proxy.provider_proxy_id) throw new BadRequestException('Proxy này không có provider_proxy_id, không thể xoay');

    // ── 2. Lấy token_api từ partner qua order ─────────────────────────────────
    const order = await this.orderModel
      .findById(proxy.order_id)
      .select('partner_id')
      .lean()
      .exec();

    if (!order?.partner_id) throw new BadRequestException('Order không có partner');

    const partner = await this.partnerModel
      .findById(order.partner_id)
      .select('token_api')
      .lean()
      .exec();

    if (!partner?.token_api) throw new BadRequestException('Partner không có token_api');

    const proxyId  = proxy.provider_proxy_id;
    const cacheKey = `${ROTATE_CACHE_PREFIX}${proxyId}`;

    // ── 3. Kiểm tra cache — tính lại timeRemaining theo thời gian thực ────────
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      try {
        const entry: RotateCacheEntry = JSON.parse(cached);
        const elapsedSec  = Math.floor((Date.now() - entry.cachedAt) / 1000);
        const remaining   = entry.originalRemaining - elapsedSec;

        if (remaining > 0) {
          this.logger.debug(`Rotate cache HIT proxy ${proxyId}, remaining ${remaining}s`);
          return {
            ...entry.result,
            timeRemaining: remaining,
            message: `Chưa tới thời gian xoay: ${remaining}s`,
          };
        }

        // Hết thời gian chờ → xoá cache, gọi API mới
        await this.redis.del(cacheKey);
      } catch {
        // cache hỏng → tiếp tục gọi API
      }
    }

    // ── 4. Gọi HomeProxy rotate API ───────────────────────────────────────────
    const raw = await this.callRotateApi(partner.token_api, proxyId);

    // ── 5. Format response ────────────────────────────────────────────────────
    const result = this.formatResponse(raw, proxy);

    // ── 5b. Cập nhật proxy mới vào DB nếu xoay thành công ──────────────────
    if (!result.timeRemaining && raw.proxy) {
      const parts = raw.proxy.split(':');
      if (parts.length >= 4) {
        const [newIp, newPort, newUser, newPass] = parts;
        await this.proxyModel.updateOne(
          { _id: proxy._id },
          { $set: {
            prev_ip: proxy.ip_address,
            ip_address: newIp,
            port: Number(newPort),
            auth_username: newUser,
            auth_password: newPass,
          }},
        );
        this.logger.log(`Updated proxy ${proxy._id}: ${proxy.ip_address} → ${newIp}`);
      }
    }

    // ── 6. Cache để chặn spam — tối thiểu 60s ────────────────────────────────
    const MIN_COOLDOWN = 70;
    const cacheTtl = Math.max(result.timeRemaining ?? 0, MIN_COOLDOWN);
    const entry: RotateCacheEntry = {
      result,
      cachedAt:          Date.now(),
      originalRemaining: cacheTtl,
    };
    await this.redis.set(cacheKey, JSON.stringify(entry), 'EX', cacheTtl);
    this.logger.debug(`Rotate cached ${cacheTtl}s for proxy ${proxyId}`);

    return result;
  }

  private async callRotateApi(tokenApi: string, proxyId: string): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(`${HOMEPROXY_BASE_URL}/merchant/proxies/${proxyId}/rotate`, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'Authorization': `Bearer ${tokenApi}`,
          'Content-Type':  'application/json',
        },
      });
    } catch (err: any) {
      throw new BadRequestException(
        err?.name === 'AbortError'
          ? `HomeProxy rotate timeout after ${TIMEOUT_MS}ms`
          : `HomeProxy network error: ${err?.message}`,
      );
    } finally {
      clearTimeout(timer);
    }

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const msg = res.status === 503
        ? 'Xoay quá nhanh, vui lòng chờ ít nhất 60 giây giữa các lần xoay'
        : `HomeProxy rotate error [${res.status}]: ${data?.message ?? JSON.stringify(data)}`;
      throw new BadRequestException(msg);
    }

    return data;
  }

  private formatResponse(raw: any, proxy: ProxyDocument | any): Record<string, any> {
    const proxyStr = `${proxy.ip_address}:${proxy.port}:${proxy.auth_username}:${proxy.auth_password}`;

    const base = {
      status:     raw.status     ?? 'success',
      message:    raw.message    ?? 'Xoay proxy thành công',
      proxy:      raw.proxy      ?? proxyStr,
      ip:         raw.ip         ?? proxy.ip_address,
      lastRotate: raw.lastRotate != null ? String(raw.lastRotate) : null,
    };

    if (raw.timeRemaining != null && Number(raw.timeRemaining) > 0) {
      return {
        ...base,
        message:       raw.message ?? `Chưa tới thời gian xoay: ${raw.timeRemaining}s`,
        timeRemaining: Number(raw.timeRemaining),
      };
    }

    return base;
  }
}
