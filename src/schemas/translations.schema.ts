import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type TranslationDocument = Translation & Document;

/**
 * Bảng dịch dùng chung cho mọi entity (service, announcement, ...).
 * Mỗi doc = bản dịch của 1 entity sang 1 ngôn ngữ.
 * VD service: { entity_type: 'service', entity_id: <serviceId>, locale: 'en',
 *               fields: { name: 'Viettel Residential Proxy', note: { Speed: '...' } } }
 */
@Schema({ collection: 'translations', timestamps: true })
export class Translation {
  @Prop({ required: true, index: true })
  entity_type: string;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  entity_id: Types.ObjectId;

  @Prop({ default: 'en' })
  locale: string;

  // Các field đã dịch, cấu trúc tự do theo từng entity_type
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  fields: Record<string, any>;
}

export const TranslationSchema = SchemaFactory.createForClass(Translation);

// 1 entity chỉ có 1 bản dịch cho mỗi ngôn ngữ
TranslationSchema.index({ entity_type: 1, entity_id: 1, locale: 1 }, { unique: true });
