import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { OrderLog, OrderLogDocument, OrderLogLevel, OrderLogStep } from '../schemas/order-log.schema';
import { Order, OrderDocument } from '../schemas/orders.schema';

@Injectable()
export class OrderLogService {
  constructor(
    @InjectModel(OrderLog.name)
    private readonly logModel: Model<OrderLogDocument>,
    @InjectModel(Order.name)
    private readonly orderModel: Model<OrderDocument>,
  ) {}

  async log(params: {
    order_id: string | Types.ObjectId;
    step: OrderLogStep;
    level?: OrderLogLevel;
    message: string;
    data?: Record<string, any>;
    duration_ms?: number;
    actor?: string;
  }): Promise<void> {
    try {
      await this.logModel.create({
        order_id:    new Types.ObjectId(params.order_id.toString()),
        step:        params.step,
        level:       params.level ?? OrderLogLevel.INFO,
        message:     params.message,
        data:        params.data ?? {},
        duration_ms: params.duration_ms ?? null,
        actor:       params.actor ?? 'system',
      });
    } catch {
      // Logging không được làm crash flow chính
    }
  }

  info(order_id: string | Types.ObjectId, step: OrderLogStep, message: string, data?: Record<string, any>, actor?: string) {
    return this.log({ order_id, step, level: OrderLogLevel.INFO, message, data, actor });
  }

  warn(order_id: string | Types.ObjectId, step: OrderLogStep, message: string, data?: Record<string, any>) {
    return this.log({ order_id, step, level: OrderLogLevel.WARN, message, data });
  }

  error(order_id: string | Types.ObjectId, step: OrderLogStep, message: string, data?: Record<string, any>, actor?: string) {
    return this.log({ order_id, step, level: OrderLogLevel.ERROR, message, data, actor });
  }

  /** Ghi nhiều log cùng lúc — 1 DB write thay vì N writes */
  async bulkLog(entries: Array<{
    order_id: string | Types.ObjectId;
    step: OrderLogStep;
    level?: OrderLogLevel;
    message: string;
    data?: Record<string, any>;
    actor?: string;
  }>): Promise<void> {
    if (!entries.length) return;
    try {
      await this.logModel.insertMany(
        entries.map(e => ({
          order_id:    new Types.ObjectId(e.order_id.toString()),
          step:        e.step,
          level:       e.level ?? OrderLogLevel.INFO,
          message:     e.message,
          data:        e.data ?? {},
          duration_ms: null,
          actor:       e.actor ?? 'system',
        })),
        { ordered: false },
      );
    } catch {
      // Logging không được làm crash flow chính
    }
  }

  /** Lấy toàn bộ log của 1 order, sorted theo thời gian */
  async findByOrder(orderId: string) {
    return this.logModel
      .find({ order_id: new Types.ObjectId(orderId) })
      .sort({ createdAt: 1 })
      .lean()
      .exec();
  }

  // Field nhạy cảm trong log.data — KHÔNG trả cho user (ẩn danh tính NCC)
  private static readonly SENSITIVE_LOG_KEYS = new Set([
    'partner_code', 'partner_id', 'provider', 'provider_order_id',
    'provider_proxy_id', 'provider_proxy_ids', 'provider_metadata',
    'provider_raw_response', 'raw_response', 'token_api', 'key',
  ]);

  // Tên NCC xuất hiện trong message → thay bằng "nhà cung cấp"
  private static readonly PROVIDER_NAME_RE =
    /\b(proxyvn|proxyseller|proxy-seller|homeproxy|twoproxy|2proxy|proxysieutoc|proxyv6|proxy\.vn)\b/gi;

  private sanitizeLogForUser(log: Record<string, any>) {
    const data: Record<string, any> = { ...(log.data ?? {}) };
    for (const k of Object.keys(data)) {
      if (OrderLogService.SENSITIVE_LOG_KEYS.has(k)) delete data[k];
    }
    const message = String(log.message ?? '').replace(
      OrderLogService.PROVIDER_NAME_RE,
      'nhà cung cấp',
    );
    return { ...log, message, data };
  }

  /** Lấy log của order — chỉ trả nếu order thuộc userId (đã ẩn thông tin NCC) */
  async findByOrderForUser(orderId: string, userId: string) {
    const order = await this.orderModel
      .findOne({ _id: new Types.ObjectId(orderId), user_id: new Types.ObjectId(userId) })
      .select('_id')
      .lean()
      .exec();
    if (!order) throw new ForbiddenException('Order không tồn tại hoặc không có quyền truy cập');
    const logs = await this.findByOrder(orderId);
    return logs.map((l) => this.sanitizeLogForUser(l));
  }
}
