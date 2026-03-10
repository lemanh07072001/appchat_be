import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Service, ServiceDocument } from '../schemas/services.schema';
import { Model, Types } from 'mongoose';
import { CreateServiceDto } from '../dto/create-service.dto';
import { PaginationQueryDto } from '../dto/pagination-query.dto';

@Injectable()
export class ServicesService {
  constructor(
    @InjectModel(Service.name)
    private serviceModel: Model<ServiceDocument>,
  ) {}

  async findPublicList(category?: 'static' | 'rotating', usage_type?: string, ip_version?: string) {
    const filter: any = { status: true };
    if (category) filter.type = category;
    if (usage_type) filter.usage_type = usage_type;
    if (ip_version) filter.ip_version = ip_version;
    return this.serviceModel
      .find(filter)
      .populate('country', 'name code')
      .select('-partner -body_api')
      .sort({ createdAt: -1 })
      .lean()
      .exec();
  }

  async findAllPaginated(query: PaginationQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const search = query.search ?? '';
    const skip = (page - 1) * limit;

    const orConditions: any[] = [
      { name: { $regex: search, $options: 'i' } },
      { type: { $regex: search, $options: 'i' } },
    ];

    if (Types.ObjectId.isValid(search)) {
      orConditions.push(
        { _id: new Types.ObjectId(search) },
        { partner: new Types.ObjectId(search) },
        { country: new Types.ObjectId(search) },
      );
    }

    const filter = search ? { $or: orConditions } : {};

    const [data, total] = await Promise.all([
      this.serviceModel.find(filter).skip(skip).limit(limit).sort({ createdAt: -1 }).exec(),
      this.serviceModel.countDocuments(filter).exec(),
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

  private toObjectId(id?: string): Types.ObjectId | null {
    return id && Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : null;
  }

  async create(data: CreateServiceDto): Promise<ServiceDocument> {
    const service = new this.serviceModel({
      ...data,
      partner: this.toObjectId(data.partner),
      country: this.toObjectId(data.country),
    });
    return service.save();
  }

  async update(id: string, data: CreateServiceDto): Promise<ServiceDocument> {
    const service = await this.serviceModel.findById(id).exec();
    if (!service) {
      throw new BadRequestException('Service not found');
    }
    Object.assign(service, {
      ...data,
      partner: this.toObjectId(data.partner),
      country: this.toObjectId(data.country),
      isp: data.isp ?? [],
      protocol: data.protocol ?? [],
    });
    return service.save();
  }

  async duplicate(id: string): Promise<ServiceDocument> {
    const service = await this.serviceModel.findById(id).exec();
    if (!service) {
      throw new BadRequestException('Service not found');
    }

    let copyName = `${service.name} (copy)`;
    let count = 1;
    while (await this.serviceModel.findOne({ name: copyName }).exec()) {
      count++;
      copyName = `${service.name} (copy ${count})`;
    }

    const newService = new this.serviceModel({
      name: copyName,
      type: service.type,
      status: service.status,
      proxy_type: service.proxy_type,
      ip_version: service.ip_version,
      partner: service.partner,
      country: service.country,
      body_api: service.body_api,
      protocol: service.protocol,
      note: service.note,
      isp: service.isp,
      is_show: service.is_show,
      pricing: service.pricing,
    });
    return newService.save();
  }

  async delete(id: string) {
    const service = await this.serviceModel.findByIdAndDelete(id).exec();
    if (!service) {
      throw new BadRequestException('Service not found');
    }
    return { message: 'Service deleted successfully' };
  }

  async deleteMany(ids: string[]) {
    const result = await this.serviceModel.deleteMany({ _id: { $in: ids } }).exec();
    return { message: `${result.deletedCount} services deleted successfully` };
  }
}
