import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type ServiceDocument = Service & Document & {
  createdAt: Date;
  updatedAt: Date;
};

@Schema({ timestamps: true })
export class Service {
  @Prop({ type: Number, default: 0, select: false })
  connector_checkout_revision: number;
  /** Server-managed package selection. Never accepted from a customer order payload. */
  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  connector_binding: {
    accountId: string;
    connectorCode: string;
    connectorVersion: number;
    packages: Record<string, string>;
  } | null;

  @Prop({ required: true })
  name: string;

  @Prop({ default: '' })
  type: string;

  @Prop({ default: true })
  status: boolean;

  @Prop({ default: '' })
  proxy_type: string;

  @Prop({ default: '' })
  ip_version: string;

  @Prop({ type: Types.ObjectId, ref: 'Partner', default: null })
  partner: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Country', default: null })
  country: Types.ObjectId;

  @Prop({ default: '' })
  body_api: string;

  @Prop({ default: '' })
  id_service: string;

  @Prop({ type: [String], default: [] })
  protocol: string[];

  /** Public purchase UX, set only when binding a versioned Connector definition. */
  @Prop({ type: String, enum: ['fixed', 'select', 'dual'], default: undefined })
  connector_protocol_mode?: 'fixed' | 'select' | 'dual';

  /**
   * Cổng gateway của dịch vụ, do admin tự khai — KHÔNG phụ thuộc nhà cung cấp.
   *
   * Cổng là thuộc tính hạ tầng của sản phẩm (ví dụ `v3-v6-dc` luôn là 50/51),
   * không phải thuộc tính của từng đơn. Nhà cung cấp lại không khai đều: field
   * `ports` trong `/packages` trả `null`, và response của đơn có thể thiếu
   * `port_socks` — lúc đó khách mất hẳn SOCKS5.
   *
   * 0 = chưa khai, dùng cổng nhà cung cấp trả về. Khác 0 = THẮNG cổng nhà cung
   * cấp: với sản phẩm dùng DẢI cổng (Residential Pool 10000–10009) thì chỉ
   * admin biết nên dùng cổng nào.
   *
   * Đọc sống (không snapshot vào đơn): nhà cung cấp đổi cổng thì mọi đơn đang
   * chạy phải đổi theo, snapshot là để lại một loạt đơn trỏ vào cổng đã chết.
   */
  @Prop({ default: 0, min: 0, max: 65535 })
  port_http: number;

  @Prop({ default: 0, min: 0, max: 65535 })
  port_socks: number;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  note: Record<string, string>;

  @Prop({ type: [{ name: String, code: String }], default: [] })
  isp: { name: string; code: string }[];

  /** Optional multi-country selection with shared VND pricing. Does not replace legacy country. */
  @Prop({ type: [{ _id: false, name: String, code: String }], default: [] })
  country_choices: { name: string; code: string }[];

  @Prop({ default: 'private' })
  usage_type: string;

  @Prop({ default: true })
  is_show: boolean;

  @Prop({ default: false })
  api_enabled: boolean;

  @Prop({ default: true })
  show_user_pass: boolean;

  @Prop({ default: true })
  allow_renew: boolean;

  /**
   * Cách tính tiền của dịch vụ.
   *   'duration'  — bán theo thời hạn (mặc định, toàn bộ dịch vụ cũ)
   *   'bandwidth' — bán theo dung lượng GB
   */
  @Prop({ default: 'duration', enum: ['duration', 'bandwidth'] })
  pricing_mode: string;

  /**
   * Bảng giá. Hình dạng value phụ thuộc `pricing_mode`:
   *
   *   duration  → key là số ngày
   *               { "30": { price: 90000, cost: 60000 } }
   *
   *   bandwidth → key là mã gói (dùng chính số GB cho dễ đọc)
   *               { "50": { gb: 50, days: 30, price: 650000, cost: 400000 } }
   *               `days` = hạn dùng của gói; 0 hoặc thiếu = không giới hạn thời gian.
   */
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  pricing: Record<string, any>;

  /**
   * Bậc giá cho `pricing_mode: 'bandwidth'` khi khách **tự nhập số GB**.
   *
   * Giá phẳng: toàn bộ số GB tính theo `price_per_gb` của bậc đang đứng, KHÔNG
   * luỹ tiến từng bậc như thuế. Hệ quả có chủ đích: mua 50GB có thể rẻ hơn 49GB —
   * frontend phải nói thẳng điều đó ra thay vì giấu.
   *
   * Chỉ khai `min_gb`; trần của một bậc là `min_gb` của bậc kế tiếp. Nhờ vậy
   * bảng bậc không bao giờ hở hay chồng lấn.
   *
   *   [ { min_gb: 1,   price_per_gb: 20000, cost_per_gb: 12400, days: 30 },
   *     { min_gb: 10,  price_per_gb: 17000, cost_per_gb: 11800, days: 30 },
   *     { min_gb: 50,  price_per_gb: 14000, cost_per_gb: 10900, days: 60 } ]
   *
   * Mảng rỗng = dịch vụ vẫn bán gói cố định qua `pricing` (hình dạng cũ).
   * Hai chế độ cùng tồn tại, không cần migrate dữ liệu cũ.
   */
  @Prop({
    type: [
      {
        _id: false,
        min_gb: { type: Number, required: true, min: 1 },
        price_per_gb: { type: Number, required: true, min: 0 },
        cost_per_gb: { type: Number, default: null },
        days: { type: Number, default: 0 },
      },
    ],
    default: [],
  })
  bandwidth_tiers: {
    min_gb: number;
    price_per_gb: number;
    cost_per_gb: number | null;
    days: number;
  }[];

  /** Trần số GB mỗi đơn khi bán theo bậc. Sàn lấy từ `bandwidth_tiers[0].min_gb`. */
  @Prop({ default: 1000, min: 1 })
  bandwidth_max_gb: number;

  // Giá ưu đãi cho user cụ thể, lưu số tiền giảm trên 1 proxy / ngày theo duration.
  // Cấu trúc: { [userId]: { [duration_days]: discount_amount } }
  // VD: { "6a1666...": { "30": 500 } } → user X mua gói 30 ngày, giá/proxy/ngày giảm 500đ.
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  user_discounts: Record<string, Record<string, number>>;

  // Giới hạn số lượng proxy mua/đơn (mode duration: count × days).
  @Prop({ default: 1, min: 1 })
  min_quantity: number;

  @Prop({ default: 100, min: 1 })
  max_quantity: number;

  @Prop({ default: '' })
  badge: string;

  // Map số ngày → product ID của provider (HomeProxy có ID khác nhau theo thời hạn)
  // VD: { "1": "uuid-1day", "7": "uuid-7day", "30": "uuid-30day" }
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  duration_ids: Record<string, string>;

  @Prop({ default: 0 })
  order: number;
}

export const ServiceSchema = SchemaFactory.createForClass(Service);
