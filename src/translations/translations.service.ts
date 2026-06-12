import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Translation, TranslationDocument } from '../schemas/translations.schema';

// Thêm entity mới (vd blog) chỉ cần thêm vào danh sách này
const ALLOWED_ENTITY_TYPES = ['service', 'announcement'];

@Injectable()
export class TranslationsService {
  constructor(
    @InjectModel(Translation.name)
    private readonly translationModel: Model<TranslationDocument>,
  ) {}

  private validate(entityType: string, entityId: string): Types.ObjectId {
    if (!ALLOWED_ENTITY_TYPES.includes(entityType)) {
      throw new BadRequestException(`entity_type không hợp lệ: ${entityType}`);
    }
    if (!Types.ObjectId.isValid(entityId)) {
      throw new BadRequestException('entity_id không hợp lệ');
    }
    return new Types.ObjectId(entityId);
  }

  async findOne(entityType: string, entityId: string, locale = 'en') {
    const id = this.validate(entityType, entityId);
    return this.translationModel
      .findOne({ entity_type: entityType, entity_id: id, locale })
      .lean()
      .exec();
  }

  /** Lấy bản dịch của nhiều entity cùng lúc (cho trang public render list) */
  async findByEntities(entityType: string, entityIds: string[], locale = 'en') {
    if (!ALLOWED_ENTITY_TYPES.includes(entityType)) {
      throw new BadRequestException(`entity_type không hợp lệ: ${entityType}`);
    }
    const ids = entityIds.filter((i) => Types.ObjectId.isValid(i)).map((i) => new Types.ObjectId(i));
    return this.translationModel
      .find({ entity_type: entityType, entity_id: { $in: ids }, locale })
      .lean()
      .exec();
  }

  async upsert(entityType: string, entityId: string, fields: Record<string, any>, locale = 'en') {
    const id = this.validate(entityType, entityId);
    return this.translationModel
      .findOneAndUpdate(
        { entity_type: entityType, entity_id: id, locale },
        { $set: { fields } },
        { new: true, upsert: true },
      )
      .lean()
      .exec();
  }

  /** Xoá toàn bộ bản dịch của 1 entity (gọi khi xoá entity gốc) */
  async deleteByEntity(entityType: string, entityIds: string[]) {
    const ids = entityIds.filter((i) => Types.ObjectId.isValid(i)).map((i) => new Types.ObjectId(i));
    if (!ids.length) return;
    await this.translationModel.deleteMany({ entity_type: entityType, entity_id: { $in: ids } }).exec();
  }
}
