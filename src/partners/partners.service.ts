import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Partner, PartnerDocument } from '../schemas/partners.schema';
import { Model, Types } from 'mongoose';
import { CreatePartnerDto } from '../dto/create-partner.dto';
import { PaginationQueryDto } from '../dto/pagination-query.dto';
import { CheckProviderConnectionDto } from '../dto/check-provider-connection.dto';
import { ProxyProviderFactory } from '../proxy-providers/proxy-provider.factory';

@Injectable()
export class PartnersService {
  constructor(
    @InjectModel(Partner.name)
    private partnerModel: Model<PartnerDocument>,
  ) {}

  /**
   * Kiểm tra API key của một nhà cung cấp bằng cách gọi thật sang API của họ.
   *
   * Không ném lỗi khi key sai — trả về `{ ok: false, message }` để form hiện
   * kết quả tại chỗ thay vì bắn toast lỗi đỏ như một sự cố hệ thống. Key sai là
   * kết quả kiểm tra hợp lệ, không phải lỗi của ta.
   */
  async checkProviderConnection(
    factory: ProxyProviderFactory,
    dto: CheckProviderConnectionDto,
  ): Promise<{
    ok: boolean;
    message?: string;
    latency_ms?: number;
    account?: string;
    balance?: number;
    currency?: string;
  }> {
    if (!factory.hasProvider(dto.code)) {
      return { ok: false, message: `Chưa có adapter cho code "${dto.code}"` };
    }

    const provider = factory.getProvider(dto.code);
    if (typeof provider.checkConnection !== 'function') {
      return {
        ok: false,
        message: `Adapter "${dto.code}" chưa hỗ trợ kiểm tra kết nối`,
      };
    }

    // Sửa nhà cung cấp mà không đổi key thì form không gửi key lên (nó đang bị
    // che) — lấy key đang lưu.
    let token = dto.token_api?.trim() ?? '';
    if (!token && dto.partner_id && Types.ObjectId.isValid(dto.partner_id)) {
      const saved = await this.partnerModel
        .findById(dto.partner_id)
        .select('token_api')
        .lean()
        .exec();
      token = saved?.token_api ?? '';
    }
    if (!token) {
      return { ok: false, message: 'Chưa có API key để kiểm tra' };
    }

    const startedAt = Date.now();
    try {
      const info = await provider.checkConnection(token);
      return {
        ok: true,
        latency_ms: Date.now() - startedAt,
        account: info.account,
        balance: info.balance,
        currency: info.currency,
      };
    } catch (err: any) {
      return {
        ok: false,
        latency_ms: Date.now() - startedAt,
        message: err?.message ?? 'Không kết nối được tới nhà cung cấp',
      };
    }
  }

  /**
   * Kiểm tra sức khoẻ của nhiều nhà cung cấp cùng lúc.
   *
   * CHỦ Ý chạy theo yêu cầu chứ không tự chạy khi mở trang: mỗi lần là một
   * lượt gọi ra ngoài cho từng nhà cung cấp, không đáng đánh đổi để lấy một
   * con số mà admin chỉ liếc thỉnh thoảng.
   */
  async checkAllConnections(
    factory: ProxyProviderFactory,
    ids?: string[],
  ): Promise<
    {
      partner_id: string;
      code: string;
      ok: boolean;
      message?: string;
      latency_ms?: number;
      account?: string;
      balance?: number;
      currency?: string;
    }[]
  > {
    const filter: Record<string, unknown> = { status: true };
    if (ids?.length) {
      const objectIds = ids.filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
      if (objectIds.length === 0) return [];
      filter._id = { $in: objectIds };
    }

    const partners = await this.partnerModel
      .find(filter)
      .select('_id code token_api')
      .lean()
      .exec();

    // Song song: một nhà cung cấp chậm không được kéo cả bảng chờ theo.
    return Promise.all(
      partners.map(async (p) => {
        const result = await this.checkProviderConnection(factory, {
          code: p.code,
          token_api: p.token_api,
        } as CheckProviderConnectionDto);
        return { partner_id: String(p._id), code: p.code, ...result };
      }),
    );
  }

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
