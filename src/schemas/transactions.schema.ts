import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type TransactionDocument = Transaction & Document & {
  createdAt: Date;
  updatedAt: Date;
};

export enum TransactionStatus {
  PENDING    = 'pending',     // Mới nhận, chưa xử lý
  PROCESSED  = 'processed',   // Đã cộng tiền thành công
  UNMATCHED  = 'unmatched',   // Không tìm được user
  DUPLICATE  = 'duplicate',   // Trùng transaction_id
  FAILED     = 'failed',      // Lỗi khi xử lý
  REJECTED   = 'rejected',    // Admin huỷ giao dịch
}

@Schema({ timestamps: true })
export class Transaction {
  // ─── Dữ liệu gốc từ pays2 ─────────────────────────────────────────────────
  @Prop({ required: true, unique: true })
  transaction_id: number;

  @Prop({ required: true })
  gateway: string;            // VCB, MB, TCB, ...

  @Prop({ required: true })
  transaction_date: Date;

  @Prop({ default: '' })
  transaction_number: string;

  @Prop({ default: '' })
  account_number: string;

  @Prop({ default: '' })
  content: string;            // Nội dung chuyển khoản (chứa mã user)

  @Prop({ default: '' })
  code: string;               // Mã nạp tiền tách từ content (VD: NAP123456)

  @Prop({ default: 'IN' })
  transfer_type: string;      // IN | OUT

  @Prop({ required: true, type: Number })
  transfer_amount: number;    // Số tiền (VND)

  @Prop({ default: '' })
  checksum: string;

  // ─── Xử lý nghiệp vụ ──────────────────────────────────────────────────────
  @Prop({ default: TransactionStatus.PENDING })
  status: TransactionStatus;

  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  user_id: Types.ObjectId | null;   // User được cộng tiền

  @Prop({ type: Number, default: 0 })
  balance_before: number;           // Số dư trước khi cộng

  @Prop({ type: Number, default: 0 })
  balance_after: number;            // Số dư sau khi cộng

  @Prop({ default: 'auto' })
  source: string;                    // auto | manual

  @Prop({ default: '' })
  note: string;                     // Ghi chú xử lý (lỗi, lý do, ...)

  @Prop({ type: Object, default: null })
  raw_payload: Record<string, any> | null;  // Toàn bộ dữ liệu gốc từ pays2

  @Prop({ type: Object, default: null })
  raw_headers: Record<string, any> | null;  // Headers từ request pays2
}

export const TransactionSchema = SchemaFactory.createForClass(Transaction);

// Index để thống kê nhanh
TransactionSchema.index({ status: 1 });
TransactionSchema.index({ user_id: 1 });
TransactionSchema.index({ gateway: 1 });
TransactionSchema.index({ transaction_date: -1 });
TransactionSchema.index({ createdAt: -1 });
