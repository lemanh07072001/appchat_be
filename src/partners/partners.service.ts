import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Partner, PartnerDocument } from '../schemas/partners.schema';
import { Model, Types } from 'mongoose';
import { CreatePartnerDto } from '../dto/create-partner.dto';
import { PaginationQueryDto } from '../dto/pagination-query.dto';

@Injectable()
export class PartnersService {
  constructor(
    @InjectModel(Partner.name)
    private partnerModel: Model<PartnerDocument>,
  ) {}

  async findAllPaginated(query: PaginationQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const search = query.search ?? '';
    const skip = (page - 1) * limit;

    const orConditions: any[] = [
      { name: { $regex: search, $options: 'i' } },
      { code: { $regex: search, $options: 'i' } },
      { token_api: { $regex: search, $options: 'i' } },
    ];

    if (Types.ObjectId.isValid(search)) {
      orConditions.push({ _id: new Types.ObjectId(search) });
    }

    const filter = search ? { $or: orConditions } : {};

    const [data, total] = await Promise.all([
      this.partnerModel.find(filter).skip(skip).limit(limit).sort({ order: 1, createdAt: -1 }).exec(),
      this.partnerModel.countDocuments(filter).exec(),
    ]);

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findAllList(status?: string) {
    const filter: any = {};
    if (status === 'true') filter.status = true;
    else if (status === 'false') filter.status = false;
    return this.partnerModel.find(filter).select('_id name code status').sort({ order: 1 }).exec();
  }

  async create(data: CreatePartnerDto): Promise<PartnerDocument> {
    const partner = new this.partnerModel(data);
    return partner.save();
  }

  async update(id: string, data: CreatePartnerDto): Promise<PartnerDocument> {
    const partner = await this.partnerModel.findById(id).exec();
    if (!partner) {
      throw new BadRequestException('Partner not found');
    }
    Object.assign(partner, data);
    return partner.save();
  }

  async duplicate(id: string): Promise<PartnerDocument> {
    const partner = await this.partnerModel.findById(id).exec();
    if (!partner) {
      throw new BadRequestException('Partner not found');
    }

    let copyName = `${partner.name} (copy)`;
    let count = 1;
    while (await this.partnerModel.findOne({ name: copyName }).exec()) {
      count++;
      copyName = `${partner.name} (copy ${count})`;
    }

    const newPartner = new this.partnerModel({
      name: copyName,
      status: partner.status,
      token_api: partner.token_api,
      code: partner.code,
      order: partner.order,
    });
    return newPartner.save();
  }

  async delete(id: string) {
    const partner = await this.partnerModel.findByIdAndDelete(id).exec();
    if (!partner) {
      throw new BadRequestException('Partner not found');
    }
    return { message: 'Partner deleted successfully' };
  }

  async deleteMany(ids: string[]) {
    const result = await this.partnerModel.deleteMany({ _id: { $in: ids } }).exec();
    return { message: `${result.deletedCount} partners deleted successfully` };
  }
}
