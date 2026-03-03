import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { ProxyAssignmentStatusEnum } from '../enum/proxy-assignment.enum';

export type ProxyAssignmentDocument = ProxyAssignment & Document & {
  createdAt: Date;
  updatedAt: Date;
};

@Schema({ timestamps: true })
export class ProxyAssignment {
  @Prop({ type: Types.ObjectId, ref: 'OrderItem', required: true })
  order_item_id: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Proxy', required: true })
  proxy_pool_id: Types.ObjectId;

  @Prop({ type: Date, required: true, default: Date.now })
  assigned_at: Date;

  @Prop({ type: Date, default: null })
  released_at: Date;

  @Prop({ type: String, enum: ProxyAssignmentStatusEnum, default: ProxyAssignmentStatusEnum.ACTIVE })
  status: ProxyAssignmentStatusEnum;
}

export const ProxyAssignmentSchema = SchemaFactory.createForClass(ProxyAssignment);
