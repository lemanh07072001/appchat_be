import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import {
  OrderStatusEnum,
  PaymentStatusEnum,
  PaymentMethodEnum,
} from '../enum/order.enum';

export type OrderDocument = Order & Document & {
  createdAt: Date;
  updatedAt: Date;
};

@Schema({ timestamps: true })
export class Order {
  @Prop({ required: true, unique: true })
  order_code: string;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  user_id: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Service', required: true })
  service_id: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Partner', default: null })
  partner_id: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Country', default: null })
  country_id: Types.ObjectId;

  // ─── Loại proxy ───────────────────────────────────────────
  @Prop({ type: String, default: '' })
  proxy_type: string;

  // ─── Số lượng & thời hạn ──────────────────────────────────
  @Prop({ default: 1 })
  quantity: number;                  // số IP (proxy tĩnh), 1 nếu proxy xoay

  @Prop({ required: true })
  duration_days: number;

  // ─── Bandwidth (chỉ dùng cho proxy xoay) ─────────────────
  @Prop({ type: Number, default: null })
  bandwidth_gb: number;

  @Prop({ type: Number, default: 0 })
  bandwidth_used_gb: number;

  // ─── Giá ──────────────────────────────────────────────────
  @Prop({ type: Number, required: true })
  price_per_unit: number;

  @Prop({ type: Number, default: null })
  cost_per_unit: number;

  @Prop({ type: Number, default: 0 })
  discount_amount: number;

  @Prop({ type: Number, required: true })
  total_price: number;               // sau discount

  @Prop({ type: Number, default: null })
  total_cost: number;

  @Prop({ type: Number, default: null })
  profit: number;

  @Prop({ default: 'VND' })
  currency: string;

  // ─── Trạng thái order ─────────────────────────────────────
  @Prop({ type: Number, enum: OrderStatusEnum, default: OrderStatusEnum.PENDING })
  status: OrderStatusEnum;

  // ─── Thanh toán (tách riêng khỏi status order) ────────────
  @Prop({ type: Number, enum: PaymentStatusEnum, default: PaymentStatusEnum.UNPAID })
  payment_status: PaymentStatusEnum;

  @Prop({ type: String, enum: PaymentMethodEnum, default: null })
  payment_method: PaymentMethodEnum | null;

  @Prop({ type: Types.ObjectId, ref: 'Payment', default: null })
  payment_id: Types.ObjectId;

  // ─── Thời gian hoạt động ──────────────────────────────────
  @Prop({ type: Date, default: null })
  start_date: Date;

  @Prop({ type: Date, default: null })
  end_date: Date;

  // ─── Thông tin xác thực proxy ─────────────────────────────
  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  credentials: {
    host?: string;
    port?: number;
    username?: string;
    password?: string;
  } | null;

  // ─── Config mở rộng theo loại proxy ──────────────────────
  // static:   { ip_list: ['1.2.3.4:3128', ...] }
  // rotating: { rotation_time: 10, gateway_host: 'gate.example.com' }
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  config: Record<string, any>;

  // ─── Provider bên ngoài ───────────────────────────────────
  @Prop({ default: '' })
  provider_order_id: string;

  // ─── Gia hạn ──────────────────────────────────────────────
  @Prop({ default: false })
  auto_renew: boolean;

  @Prop({ type: Types.ObjectId, ref: 'Order', default: null })
  renewed_from: Types.ObjectId;   // order gốc đã gia hạn từ đây

  @Prop({ type: Types.ObjectId, ref: 'Order', default: null })
  renewed_to: Types.ObjectId;     // order mới sau khi gia hạn

  // ─── Ghi chú ──────────────────────────────────────────────
  @Prop({ default: '' })
  error_message: string;

  @Prop({ default: '' })
  admin_note: string;
}

export const OrderSchema = SchemaFactory.createForClass(Order);

OrderSchema.index({ user_id: 1, status: 1 });
OrderSchema.index({ end_date: 1, status: 1 });
OrderSchema.index({ status: 1, provider_order_id: 1 }); // polling PROCESSING orders
