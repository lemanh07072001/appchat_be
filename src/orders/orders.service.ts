import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Order, OrderDocument } from '../schemas/orders.schema';
import { User, UserDocument } from '../schemas/users.schema';
import { Service, ServiceDocument } from '../schemas/services.schema';
import { Country, CountryDocument } from '../schemas/countries.schema';
import { CreateOrderDto } from '../dto/create-order.dto';
import { BuyOrderDto } from '../dto/buy-order.dto';
import { PaginationQueryDto } from '../dto/pagination-query.dto';
import { OrderStatusEnum, PaymentMethodEnum, PaymentStatusEnum } from '../enum/order.enum';
import { REDIS_CLIENT } from '../redis/redis.module';
import { PENDING_ORDERS_KEY } from './orders.scheduler';
import type { Redis } from 'ioredis';

@Injectable()
export class OrdersService {
  constructor(
    @InjectModel(Order.name)
    private orderModel: Model<OrderDocument>,
    @InjectModel(User.name)
    private userModel: Model<UserDocument>,
    @InjectModel(Service.name)
    private serviceModel: Model<ServiceDocument>,
    @InjectModel(Country.name)
    private countryModel: Model<CountryDocument>,
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis,
  ) {}

  private toObjectId(id?: string): Types.ObjectId | null {
    return id && Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : null;
  }

  private generateOrderCode(): string {
    const date = new Date();
    const datePart = date.toISOString().slice(0, 10).replace(/-/g, '');
    const rand = Math.random().toString(36).substring(2, 7).toUpperCase();
    return `ORD-${datePart}-${rand}`;
  }

  // Resolve country: nhận ObjectId hoặc tên quốc gia
  private async resolveCountryId(country?: string): Promise<Types.ObjectId | null> {
    if (!country) return null;
    if (Types.ObjectId.isValid(country)) return new Types.ObjectId(country);
    const found = await this.countryModel.findOne({ name: { $regex: `^${country}$`, $options: 'i' } }).exec();
    return found ? (found._id as Types.ObjectId) : null;
  }

  async buy(userId: string, dto: BuyOrderDto): Promise<OrderDocument> {
    // 1. Validate service
    const service = await this.serviceModel.findById(dto.service_id).exec();
    if (!service || !service.status) {
      throw new BadRequestException('Service không tồn tại hoặc đã ngừng hoạt động');
    }

    // 2. Lấy giá theo duration_days — tính server-side, không tin frontend
    const pricing = service.pricing?.[dto.duration_days];
    if (!pricing) {
      throw new BadRequestException(`Service không hỗ trợ gói ${dto.duration_days} ngày`);
    }

    const quantity      = dto.quantity ?? 1;
    const pricePerUnit  = pricing.price as number;
    const costPerUnit   = pricing.cost as number ?? null;
    const totalPrice    = pricePerUnit * quantity;
    const totalCost     = costPerUnit != null ? costPerUnit * quantity : null;

    // 3. Resolve country_id
    const countryId = await this.resolveCountryId(dto.country) ?? service.country ?? null;

    // 4. Trừ tiền atomic — chỉ trừ nếu đủ số dư
    const user = await this.userModel.findOneAndUpdate(
      { _id: new Types.ObjectId(userId), money: { $gte: totalPrice } },
      { $inc: { money: -totalPrice } },
      { new: true },
    ).exec();

    if (!user) {
      throw new BadRequestException('Số dư không đủ để mua dịch vụ này');
    }

    // 5. Tạo order
    const now     = new Date();
    const endDate = new Date(now);
    endDate.setDate(endDate.getDate() + dto.duration_days);

    const dataOrder = {
      order_code:     this.generateOrderCode(),
      user_id:        new Types.ObjectId(userId),
      service_id:     new Types.ObjectId(dto.service_id),
      partner_id:     service.partner ?? null,
      country_id:     countryId,
      proxy_type:     dto.proxy_type ?? service.proxy_type,
      quantity,
      duration_days:  dto.duration_days,
      price_per_unit: pricePerUnit,
      cost_per_unit:  costPerUnit,
      total_price:    totalPrice,
      total_cost:     totalCost,
      profit:         totalCost != null ? totalPrice - totalCost : null,
      payment_status: PaymentStatusEnum.PAID,
      payment_method: PaymentMethodEnum.BALANCE,
      status:         OrderStatusEnum.PENDING,
      start_date:     now,
      end_date:       endDate,
      config: {
        protocol: dto.protocol ?? null,
        isp:      dto.isp ?? null,
      },
    };

    const order = new this.orderModel(dataOrder);
    await order.save();

    // 6. Push order ID vào Redis để worker xử lý ngay
    if (service.partner) {
      const raw  = await this.redis.get(PENDING_ORDERS_KEY);
      const ids: string[] = raw ? JSON.parse(raw) : [];
      const orderId = (order._id as Types.ObjectId).toString();
      if (!ids.includes(orderId)) {
        ids.push(orderId);
        await this.redis.set(PENDING_ORDERS_KEY, JSON.stringify(ids));
      }
    }

    return order;
  }

  async findAllPaginated(query: PaginationQueryDto) {
    const page  = query.page ?? 1;
    const limit = query.limit ?? 10;
    const search = query.search ?? '';
    const skip  = (page - 1) * limit;

    const filter: any = search
      ? { order_code: { $regex: search, $options: 'i' } }
      : {};

    if (search && Types.ObjectId.isValid(search)) {
      filter['$or'] = [
        { order_code: { $regex: search, $options: 'i' } },
        { user_id: new Types.ObjectId(search) },
      ];
      delete filter.order_code;
    }

    const [data, total] = await Promise.all([
      this.orderModel
        .find(filter)
        .populate('user_id', 'email name')
        .populate('service_id', 'name proxy_type')
        .populate('country_id', 'name code')
        .skip(skip)
        .limit(limit)
        .sort({ createdAt: -1 })
        .lean()
        .exec(),
      this.orderModel.countDocuments(filter).exec(),
    ]);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findByUser(userId: string, query: PaginationQueryDto) {
    const page  = query.page ?? 1;
    const limit = query.limit ?? 10;
    const skip  = (page - 1) * limit;
    const filter = { user_id: new Types.ObjectId(userId) };

    const [data, total] = await Promise.all([
      this.orderModel
        .find(filter)
        .populate('service_id', 'name proxy_type ip_version')
        .populate('country_id', 'name code')
        .select('-admin_note -cost_per_unit -total_cost -profit -partner_id')
        .skip(skip)
        .limit(limit)
        .sort({ createdAt: -1 })
        .lean()
        .exec(),
      this.orderModel.countDocuments(filter).exec(),
    ]);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string): Promise<OrderDocument> {
    const order = await this.orderModel
      .findById(id)
      .populate('user_id', 'email name')
      .populate('service_id', 'name proxy_type')
      .populate('country_id', 'name code')
      .populate('partner_id', 'name code')
      .lean()
      .exec();
    if (!order) throw new BadRequestException('Order not found');
    return order as any;
  }

  async create(data: CreateOrderDto): Promise<OrderDocument> {
    const order = new this.orderModel({
      ...data,
      order_code:  this.generateOrderCode(),
      user_id:     this.toObjectId(data.user_id),
      service_id:  this.toObjectId(data.service_id),
      partner_id:  this.toObjectId(data.partner_id),
      country_id:  this.toObjectId(data.country_id),
      profit: data.total_cost != null ? (data.total_price - data.total_cost) : null,
    });
    return order.save();
  }

  async updateStatus(id: string, status: OrderStatusEnum): Promise<OrderDocument> {
    const order = await this.orderModel.findById(id).exec();
    if (!order) throw new BadRequestException('Order not found');
    order.status = status;
    return order.save();
  }

  async updatePaymentStatus(id: string, status: PaymentStatusEnum): Promise<OrderDocument> {
    const order = await this.orderModel.findById(id).exec();
    if (!order) throw new BadRequestException('Order not found');
    order.payment_status = status;
    return order.save();
  }

  async renew(id: string): Promise<OrderDocument> {
    const original = await this.orderModel.findById(id).exec();
    if (!original) throw new BadRequestException('Order not found');

    const newOrder = new this.orderModel({
      order_code:     this.generateOrderCode(),
      user_id:        original.user_id,
      service_id:     original.service_id,
      partner_id:     original.partner_id,
      country_id:     original.country_id,
      proxy_type:     original.proxy_type,
      quantity:       original.quantity,
      duration_days:  original.duration_days,
      bandwidth_gb:   original.bandwidth_gb,
      price_per_unit: original.price_per_unit,
      cost_per_unit:  original.cost_per_unit,
      total_price:    original.total_price,
      total_cost:     original.total_cost,
      profit:         original.profit,
      currency:       original.currency,
      payment_method: original.payment_method,
      config:         original.config,
      auto_renew:     original.auto_renew,
      renewed_from:   original._id,
    });

    const saved = await newOrder.save();
    original.renewed_to = saved._id as Types.ObjectId;
    await original.save();

    return saved;
  }

  async delete(id: string) {
    const order = await this.orderModel.findByIdAndDelete(id).exec();
    if (!order) throw new BadRequestException('Order not found');
    return { message: 'Order deleted successfully' };
  }
}
