import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Announcement, AnnouncementDocument } from '../schemas/announcements.schema';
import { TranslationsService } from '../translations/translations.service';

@Injectable()
export class AnnouncementsService {
  constructor(
    @InjectModel(Announcement.name)
    private model: Model<AnnouncementDocument>,
    private readonly translationsService: TranslationsService,
  ) {}

  // ─── Admin: danh sách phân trang ──────────────────────────────────────
  async findAllPaginated(page = 1, limit = 10, search?: string, tag?: string) {
    const filter: any = {};
    if (search) {
      filter.title = new RegExp(search, 'i');
    }
    if (tag) filter.tag = tag;

    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.model
        .find(filter)
        .sort({ order: 1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      this.model.countDocuments(filter),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  // ─── Public: danh sách thông báo đang hoạt động ──────────────────────
  async findPublicList(locale?: string) {
    const docs = await this.model
      .find({ is_active: true })
      .select('title description image tag display_type order createdAt')
      .sort({ order: 1, createdAt: -1 })
      .lean()
      .exec();

    // Overlay bản dịch khi locale = en — thiếu bản dịch thì giữ tiếng Việt
    if (locale?.toLowerCase().startsWith('en') && docs.length) {
      const ids = docs.map((d) => d._id?.toString()).filter(Boolean);
      const translations = await this.translationsService.findByEntities('announcement', ids, 'en');
      const map = new Map(translations.map((t: any) => [t.entity_id.toString(), t.fields ?? {}]));
      for (const doc of docs as any[]) {
        const fields = map.get(doc._id?.toString());
        if (!fields) continue;
        if (typeof fields.title === 'string' && fields.title.trim()) doc.title = fields.title;
        if (typeof fields.description === 'string' && fields.description.trim()) doc.description = fields.description;
      }
    }
    return docs;
  }

  async findById(id: string) {
    const doc = await this.model.findById(id).exec();
    if (!doc) throw new BadRequestException('Thông báo không tồn tại');
    return doc;
  }

  async create(data: any) {
    return this.model.create(data);
  }

  async update(id: string, data: any) {
    const doc = await this.model.findByIdAndUpdate(id, data, { new: true }).exec();
    if (!doc) throw new BadRequestException('Thông báo không tồn tại');
    return doc;
  }

  async delete(id: string) {
    const doc = await this.model.findByIdAndDelete(id).exec();
    if (!doc) throw new BadRequestException('Thông báo không tồn tại');
    return { message: 'Đã xoá thông báo' };
  }

  async deleteMany(ids: string[]) {
    if (!ids?.length) throw new BadRequestException('Cần truyền danh sách ids');
    const result = await this.model.deleteMany({ _id: { $in: ids } }).exec();
    return { message: `Đã xoá ${result.deletedCount} thông báo` };
  }
}
