import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Service, ServiceDocument } from '../schemas/services.schema';
import { Partner } from '../schemas/partners.schema';
import { Country } from '../schemas/countries.schema';
import { Model, Types } from 'mongoose';
import { CreateServiceDto } from '../dto/create-service.dto';
import { PaginationQueryDto } from '../dto/pagination-query.dto';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

@Injectable()
export class ServicesService {
  constructor(
    @InjectModel(Service.name)
    private serviceModel: Model<ServiceDocument>,
    @InjectModel(Partner.name)
    private partnerModel: Model<Partner>,
    @InjectModel(Country.name)
    private countryModel: Model<Country>,
  ) {}

  /**
   * Áp discount user-specific lên pricing và xoá field user_discounts trước khi trả về cho user.
   * Tránh leak danh sách user khác qua API public.
   */
  private applyUserDiscount(service: any, userId: string | null) {
    const discounts = userId ? service.user_discounts?.[userId] : null;
    if (discounts && service.pricing) {
      const newPricing: Record<string, any> = {};
      for (const [duration, p] of Object.entries(service.pricing)) {
        const disc = Number(discounts[duration]) || 0;
        const price = (p as any)?.price ?? 0;
        newPricing[duration] = {
          ...(p as any),
          price: Math.max(0, price - disc),
        };
      }
      service.pricing = newPricing;
    }
    if (service.user_discounts) delete service.user_discounts;
    return service;
  }

  async findApiEnabledList(userId: string | null = null) {
    const services = await this.serviceModel
      .find({ status: true, api_enabled: true })
      .populate('country', 'name code image_url')
      .select('_id name type proxy_type ip_version protocol isp pricing usage_type user_discounts')
      .sort({ order: 1, createdAt: -1 })
      .lean()
      .exec();
    return services.map((s) => this.applyUserDiscount(s, userId));
  }

  async findPublicList(
    category?: 'static' | 'rotating',
    usage_type?: string,
    ip_version?: string,
    userId: string | null = null,
  ) {
    const filter: any = { status: true };
    if (category) filter.type = category;
    if (usage_type) filter.usage_type = usage_type;
    if (ip_version) filter.ip_version = ip_version;
    const services = await this.serviceModel
      .find(filter)
      .populate('country', 'name code image_url')
      .select('-partner -body_api')
      .sort({ order: 1, createdAt: -1 })
      .lean()
      .exec();
    return services.map((s) => this.applyUserDiscount(s, userId));
  }

  async findAllPaginated(query: PaginationQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const search = (query.search ?? '').trim();
    const skip = (page - 1) * limit;

    const andConditions: any[] = [];

    if (search) {
      const safe = escapeRegex(search);
      const rx = { $regex: safe, $options: 'i' };
      const orConditions: any[] = [
        { name: rx },
        { type: rx },
        { proxy_type: rx },
        { ip_version: rx },
        { usage_type: rx },
        { badge: rx },
        { id_service: rx },
        { 'isp.name': rx },
        { 'isp.code': rx },
      ];
      if (Types.ObjectId.isValid(search)) {
        orConditions.push(
          { _id: new Types.ObjectId(search) },
          { partner: new Types.ObjectId(search) },
          { country: new Types.ObjectId(search) },
        );
      }
      // Lookup partner/country theo tên để admin search được "homeproxy", "vietnam"...
      const [partners, countries] = await Promise.all([
        this.partnerModel.find({ $or: [{ name: rx }, { code: rx }] }).select('_id').lean().exec(),
        this.countryModel.find({ $or: [{ name: rx }, { code: rx }] }).select('_id').lean().exec(),
      ]);
      if (partners.length > 0) {
        orConditions.push({ partner: { $in: partners.map((p) => p._id) } });
      }
      if (countries.length > 0) {
        orConditions.push({ country: { $in: countries.map((c) => c._id) } });
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
      this.serviceModel.find(filter).populate('partner', 'name domain').populate('country', 'name code image_url').skip(skip).limit(limit).sort({ order: 1, createdAt: -1 }).lean().exec(),
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
    service.markModified('user_discounts');
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
      order: service.order,
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
