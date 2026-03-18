import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BlogPost, BlogPostDocument } from '../schemas/blog-post.schema';

@Injectable()
export class BlogService {
  constructor(
    @InjectModel(BlogPost.name) private blogModel: Model<BlogPostDocument>,
  ) {}

  // Public
  async getPublished(page = 1, limit = 12, tag?: string) {
    const filter: any = { status: 'published' };
    if (tag) filter.tags = tag;
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.blogModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)
        .select('-content').lean(),
      this.blogModel.countDocuments(filter),
    ]);
    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async getBySlug(slug: string) {
    const post = await this.blogModel.findOneAndUpdate(
      { slug, status: 'published' },
      { $inc: { views: 1 } },
      { new: true },
    ).lean();
    if (!post) throw new NotFoundException('Bài viết không tồn tại');
    return post;
  }

  // Admin
  async adminList(page = 1, limit = 20, search?: string, status?: string) {
    const filter: any = {};
    if (status) filter.status = status;
    if (search) filter.title = { $regex: search, $options: 'i' };
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.blogModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)
        .select('-content').lean(),
      this.blogModel.countDocuments(filter),
    ]);
    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async adminGetById(id: string) {
    const post = await this.blogModel.findById(id).lean();
    if (!post) throw new NotFoundException('Bài viết không tồn tại');
    return post;
  }

  async create(dto: Partial<BlogPost>) {
    if (!dto.slug && dto.title) {
      dto.slug = this.toSlug(dto.title);
    }
    return this.blogModel.create(dto);
  }

  async update(id: string, dto: Partial<BlogPost>) {
    const post = await this.blogModel.findByIdAndUpdate(id, dto, { new: true }).lean();
    if (!post) throw new NotFoundException('Bài viết không tồn tại');
    return post;
  }

  async delete(id: string) {
    await this.blogModel.findByIdAndDelete(id);
    return { ok: true };
  }

  private toSlug(text: string): string {
    return text
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd').replace(/Đ/g, 'D')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
  }
}
