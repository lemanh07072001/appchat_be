import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ChatMessageDocument = ChatMessage & Document & {
  createdAt: Date;
  updatedAt: Date;
};

@Schema({ timestamps: true })
export class ChatMessage {
  @Prop({ required: true })
  room_id: string;             // userId of the user

  @Prop({ required: true, enum: ['user', 'admin'] })
  sender_type: string;

  @Prop({ default: '' })
  content: string;

  @Prop({ default: 'text', enum: ['text', 'image'] })
  type: string;

  @Prop({ default: false })
  recalled: boolean;

  @Prop({ default: false })
  read: boolean;
}

export const ChatMessageSchema = SchemaFactory.createForClass(ChatMessage);

ChatMessageSchema.index({ room_id: 1, createdAt: 1 });
ChatMessageSchema.index({ createdAt: -1 });
