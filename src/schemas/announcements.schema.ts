import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type AnnouncementDocument = Announcement & Document & {
  createdAt: Date;
  updatedAt: Date;
};

@Schema({ timestamps: true })
export class Announcement {
  @Prop({ required: true })
  title: string;

  @Prop({ default: '' })
  description: string; // HTML content

  @Prop({ default: '' })
  image: string;

  @Prop({ default: 'system' })
  tag: string; // update | promotion | system

  @Prop({ default: 'default' })
  display_type: string; // default | modal | banner

  @Prop({ default: true })
  is_active: boolean;

  @Prop({ default: 0 })
  order: number;
}

export const AnnouncementSchema = SchemaFactory.createForClass(Announcement);

AnnouncementSchema.index({ is_active: 1, order: 1 });
