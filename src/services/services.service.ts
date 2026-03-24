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

  async findApiEnabledList() {
    return this.serviceModel
      .find({ status: true, api_enabled: true })
      .populate('country', 'name code')
      .select('_id name type proxy_type ip_version protocol isp pricing usage_type')
      .sort({ createdAt: -1 })
      .lean()
      .exec();
  }

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

    const andConditions: any[] = [];

    if (search) {
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
      andConditions.push({ $or: orConditions });
    }

    if (query.type) andConditions.push({ type: query.type });
    if (query.ip_version) andConditions.push({ ip_version: query.ip_version });
    if (query.proxy_type) andConditions.push({ proxy_type: query.proxy_type });
    if (query.status !== undefined && query.status !== '') {
      andConditions.push({ status: query.status === 'true' });
    }
    if (query.badge) andConditions.push({ badge: query.badge });

    const filter = andConditions.length > 0 ? { $and: andConditions } : {};

    const [data, total] = await Promise.all([
      this.serviceModel.find(filter).populate('partner', 'name domain').populate('country', 'name code').skip(skip).limit(limit).sort({ createdAt: -1 }).lean().exec(),
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
    // Only assign defined fields to prevent overwriting existing data with undefined
    const updateData: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) updateData[key] = value;
    }
    updateData.partner = this.toObjectId(data.partner);
    updateData.country = this.toObjectId(data.country);
    if (data.isp !== undefined) updateData.isp = data.isp;
    if (data.protocol !== undefined) updateData.protocol = data.protocol;
    Object.assign(service, updateData);
    service.markModified('pricing');
    service.markModified('duration_ids');
    service.markModified('note');
    return service.save();
  }

  async toggleStatus(id: string, status: boolean): Promise<ServiceDocument> {
    const service = await this.serviceModel.findByIdAndUpdate(id, { status }, { new: true }).exec();
    if (!service) throw new BadRequestException('Service not found');
    return service;
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
      id_service: service.id_service,
      protocol: service.protocol,
      note: service.note,
      isp: service.isp,
      is_show: service.is_show,
      api_enabled: service.api_enabled,
      show_user_pass: service.show_user_pass,
      pricing: service.pricing,
      badge: service.badge,
      duration_ids: service.duration_ids,
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
