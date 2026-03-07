import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Ip, IpDocument } from '../schemas/ips.schema';
import { Model, Types } from 'mongoose';
import { CreateIpDto } from '../dto/create-ip.dto';
import { PaginationQueryDto } from '../dto/pagination-query.dto';

@Injectable()
export class IpsService {
  constructor(
    @InjectModel(Ip.name)
    private ipModel: Model<IpDocument>,
  ) {}

  async findAllPaginated(query: PaginationQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const search = query.search ?? '';
    const skip = (page - 1) * limit;

    const orConditions: any[] = [
      { name: { $regex: search, $options: 'i' } },
      { code: { $regex: search, $options: 'i' } },
      { note: { $regex: search, $options: 'i' } },
    ];

    if (Types.ObjectId.isValid(search)) {
      orConditions.push({ _id: new Types.ObjectId(search) });
    }

    const filter = search ? { $or: orConditions } : {};

    const [data, total] = await Promise.all([
      this.ipModel.find(filter).skip(skip).limit(limit).sort({ order: 1, createdAt: -1 }).exec(),
      this.ipModel.countDocuments(filter).exec(),
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
    const ips = await this.ipModel.find(filter).select('_id name code note').sort({ order: 1 }).lean().exec();
    return ips.map((ip) => ({
      id: ip._id,
      name: ip.name,
      value: ip.code,
      note: ip.note,
    }));
  }

  async findOne(id: string): Promise<IpDocument> {
    const ip = await this.ipModel.findById(id).exec();
    if (!ip) {
      throw new BadRequestException('IP not found');
    }
    return ip;
  }

  async create(data: CreateIpDto): Promise<IpDocument> {
    const ip = new this.ipModel(data);
    return ip.save();
  }

  async update(id: string, data: CreateIpDto): Promise<IpDocument> {
    const ip = await this.ipModel.findById(id).exec();
    if (!ip) {
      throw new BadRequestException('IP not found');
    }
    Object.assign(ip, data);
    return ip.save();
  }

  async duplicate(id: string): Promise<IpDocument> {
    const ip = await this.ipModel.findById(id).exec();
    if (!ip) {
      throw new BadRequestException('IP not found');
    }

    let copyName = `${ip.name} (copy)`;
    let count = 1;
    while (await this.ipModel.findOne({ name: copyName }).exec()) {
      count++;
      copyName = `${ip.name} (copy ${count})`;
    }

    const newIp = new this.ipModel({
      name: copyName,
      code: ip.code,
      note: ip.note,
      status: ip.status,
      order: ip.order,
    });
    return newIp.save();
  }

  async delete(id: string) {
    const ip = await this.ipModel.findByIdAndDelete(id).exec();
    if (!ip) {
      throw new BadRequestException('IP not found');
    }
    return { message: 'IP deleted successfully' };
  }

  async deleteMany(ids: string[]) {
    const result = await this.ipModel.deleteMany({ _id: { $in: ids } }).exec();
    return { message: `${result.deletedCount} IPs deleted successfully` };
  }
}
