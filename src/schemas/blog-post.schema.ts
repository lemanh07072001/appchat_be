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

  // ─── New fields ─────────────────────────────────────
  @Prop({ default: 'FastProxyVN' })
  author: string;

  @Prop({ default: '' })
  category: string;

  @Prop({ default: false })
  is_featured: boolean;

  @Prop({ default: true })
  toc_enabled: boolean;

  @Prop({ default: '' })
  cta_text: string;

  @Prop({ default: '' })
  cta_button_text: string;

  @Prop({ default: '' })
  cta_link: string;
}

export const BlogPostSchema = SchemaFactory.createForClass(BlogPost);

// slug already has unique index from @Prop — no need to duplicate
BlogPostSchema.index({ status: 1, createdAt: -1 });
BlogPostSchema.index({ tags: 1 });
BlogPostSchema.index({ is_featured: 1, status: 1 });
BlogPostSchema.index({ category: 1, status: 1 });
