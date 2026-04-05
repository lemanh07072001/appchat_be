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

  /** Lấy log của order — chỉ trả về nếu order thuộc về userId */
  async findByOrderForUser(orderId: string, userId: string) {
    const order = await this.orderModel
      .findOne({ _id: new Types.ObjectId(orderId), user_id: new Types.ObjectId(userId) })
      .select('_id')
      .lean()
      .exec();
    if (!order) throw new ForbiddenException('Order không tồn tại hoặc không có quyền truy cập');
    return this.findByOrder(orderId);
  }
}
