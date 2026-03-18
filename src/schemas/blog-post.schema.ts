import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type BlogPostDocument = BlogPost & Document & {
  createdAt: Date;
  updatedAt: Date;
};

@Schema({ timestamps: true })
export class BlogPost {
  @Prop({ required: true })
  title: string;

  @Prop({ required: true, unique: true })
  slug: string;

  @Prop({ default: '' })
  excerpt: string;

  @Prop({ default: '' })
  content: string;

  @Prop({ default: '' })
  thumbnail: string;

  @Prop({ default: 'draft', enum: ['draft', 'published'] })
  status: string;

  @Prop({ type: [String], default: [] })
  tags: string[];

  @Prop({ default: '' })
  meta_title: string;

  @Prop({ default: '' })
  meta_description: string;

  @Prop({ type: Number, default: 0 })
  views: number;
}

export const BlogPostSchema = SchemaFactory.createForClass(BlogPost);

BlogPostSchema.index({ slug: 1 });
BlogPostSchema.index({ status: 1, createdAt: -1 });
BlogPostSchema.index({ tags: 1 });
