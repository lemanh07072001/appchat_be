import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as crypto from 'crypto';
import { Order, OrderDocument } from '../schemas/orders.schema';
import { User, UserDocument } from '../schemas/users.schema';
import { Service, ServiceDocument } from '../schemas/services.schema';
import { Country, CountryDocument } from '../schemas/countries.schema';
import { Proxy, ProxyDocument } from '../schemas/proxies.schema';
import { CreateOrderDto } from '../dto/create-order.dto';
import { BuyOrderDto } from '../dto/buy-order.dto';
import { PaginationQueryDto } from '../dto/pagination-query.dto';
import { UserOrderQueryDto } from '../dto/user-order-query.dto';
import { OrderStatusEnum, PaymentMethodEnum, PaymentStatusEnum } from '../enum/order.enum';
import { REDIS_CLIENT } from '../redis/redis.module';
import { PENDING_ORDERS_KEY } from './orders.scheduler';
import type { Redis } from 'ioredis';
import { OrderLogService } from './order-log.service';
import { OrderLogStep } from '../schemas/order-log.schema';

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
    @InjectModel(Proxy.name)
    private proxyModel: Model<ProxyDocument>,
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis,
    private readonly orderLogService: OrderLogService,
  ) {}

  private toObjectId(id?: string): Types.ObjectId | null {
    return id && Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : null;
  }

  private generateOrderCode(): string {
    const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const rand = crypto.randomBytes(5).toString('hex').toUpperCase(); // 10 hex chars ≈ 1 trillion combinations
    return `ORD-${datePart}-${rand}`;
  }

  // Resolve country: nhận ObjectId hoặc tên quốc gia
  private async resolveCountryId(country?: string): Promise<Types.ObjectId | null> {
    if (!country) return null;
    if (Types.ObjectId.isValid(country)) return new Types.ObjectId(country);
    const found = await this.countryModel.findOne({ name: { $regex: `^${country}$`, $options: 'i' } }).exec();
    return found ? (found._id as Types.ObjectId) : null;
  }

  async buy(userId: string, dto: BuyOrderDto): Promise<{
    success: boolean;
    message: string;
    data: {
      order_id: string;
      order_code: string;
      status: OrderStatusEnum;
      service_name: string;
      proxy_type: string;
      quantity: number;
      duration_days: number;
      start_date: Date;
      end_date: Date;
      price_per_unit: number;
      total_price: number;
      balance_before: number;
      balance_after: number;
      config: Record<string, any>;
    };
  }> {
    const t0 = Date.now();

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

    const orderId = (order._id as Types.ObjectId).toString();

    // Log: order đã tạo xong
    void this.orderLogService.info(
      orderId,
      OrderLogStep.BUY_ORDER_CREATED,
      `Order ${order.order_code} tạo thành công`,
      {
        order_code:     order.order_code,
        service_id:     dto.service_id,
        service_name:   service.name,
        partner_id:     service.partner?.toString() ?? null,
        quantity,
        duration_days:  dto.duration_days,
        price_per_unit: pricePerUnit,
        total_price:    totalPrice,
        payment_method: PaymentMethodEnum.BALANCE,
        balance_after:  user.money,
        start_date:     now,
        end_date:       endDate,
        config:         dataOrder.config,
        duration_ms:    Date.now() - t0,
      },
      userId,
    );

    // 6. Push order ID vào Redis List — worker BRPOP sẽ nhận ngay
    if (service.partner) {
      await this.redis.lpush(PENDING_ORDERS_KEY, orderId);

      void this.orderLogService.info(
        orderId,
        OrderLogStep.BUY_QUEUED,
        `Order đã được đẩy vào hàng đợi Redis (${PENDING_ORDERS_KEY})`,
        { redis_key: PENDING_ORDERS_KEY },
        userId,
      );
    } else {
      void this.orderLogService.warn(
        orderId,
        OrderLogStep.BUY_QUEUED,
        'Order không có partner, không đẩy vào queue',
      );
    }

    const balanceBefore = Number(user.money) + totalPrice;
    const balanceAfter  = Number(user.money);

    return {
      success: true,
      message: 'Đặt hàng thành công, đang xử lý proxy',
      data: {
        order_id:       orderId,
        order_code:     order.order_code,
        status:         order.status,
        service_name:   service.name,
        proxy_type:     order.proxy_type,
        quantity,
        duration_days:  dto.duration_days,
        start_date:     now,
        end_date:       endDate,
        price_per_unit: pricePerUnit,
        total_price:    totalPrice,
        balance_before: balanceBefore,
        balance_after:  balanceAfter,
        config:         dataOrder.config,
      },
    };
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

  async findByUser(userId: string, query: UserOrderQueryDto) {
    const page  = query.page ?? 1;
    const limit = query.limit ?? 10;
    const search = query.search ?? '';
    const skip  = (page - 1) * limit;

    const filter: any = { user_id: new Types.ObjectId(userId) };

    if (query.status !== undefined && query.status !== null) {
      filter.status = query.status;
    }

    if (search) {
      filter.order_code = { $regex: search, $options: 'i' };
    }

    const [orders, total] = await Promise.all([
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

    // Lookup proxies cho tất cả orders trong 1 query
    const orderIds = orders.map((o) => o._id);
    const proxies = await this.proxyModel
      .find({ order_id: { $in: orderIds } })
      .select('order_id ip_address port protocol auth_username auth_password country_code region city isp is_active health_status')
      .lean()
      .exec();

    // Group proxies theo order_id
    const proxyMap = new Map<string, typeof proxies>();
    for (const proxy of proxies) {
      const key = proxy.order_id.toString();
      if (!proxyMap.has(key)) proxyMap.set(key, []);
      proxyMap.get(key)!.push(proxy);
    }

    const data = orders.map((order) => ({
      ...order,
      proxies: proxyMap.get((order._id as Types.ObjectId).toString()) ?? [],
    }));

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOneByUser(userId: string, orderId: string, query: PaginationQueryDto) {
    const order = await this.orderModel
      .findOne({ _id: new Types.ObjectId(orderId), user_id: new Types.ObjectId(userId) })
      .populate('service_id', 'name proxy_type ip_version')
      .populate('country_id', 'name code')
      .select('-admin_note -cost_per_unit -total_cost -profit -partner_id -provider_order_id -error_message -credentials')
      .lean()
      .exec();
    if (!order) throw new BadRequestException('Order not found');

    const page  = query.page ?? 1;
    const limit = query.limit ?? 10;
    const skip  = (page - 1) * limit;

    const proxyFilter = { order_id: order._id };
    const [proxies, totalProxies] = await Promise.all([
      this.proxyModel
        .find(proxyFilter)
        .select('ip_address port protocol auth_username auth_password country_code region city isp is_active health_status')
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      this.proxyModel.countDocuments(proxyFilter).exec(),
    ]);

    return {
      ...order,
      proxies: {
        data: proxies,
        meta: { total: totalProxies, page, limit, totalPages: Math.ceil(totalProxies / limit) },
      },
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

  async updateStatus(id: string, status: OrderStatusEnum, actor = 'admin'): Promise<OrderDocument> {
    const order = await this.orderModel.findById(id).exec();
    if (!order) throw new BadRequestException('Order not found');
    const prevStatus = order.status;
    order.status = status;
    const saved = await order.save();
    void this.orderLogService.info(
      id,
      OrderLogStep.ADMIN_STATUS_UPDATED,
      `Trạng thái order thay đổi: ${prevStatus} → ${status}`,
      { prev_status: prevStatus, new_status: status },
      actor,
    );
    return saved;
  }

  async updatePaymentStatus(id: string, status: PaymentStatusEnum, actor = 'admin'): Promise<OrderDocument> {
    const order = await this.orderModel.findById(id).exec();
    if (!order) throw new BadRequestException('Order not found');
    const prevStatus = order.payment_status;
    order.payment_status = status;
    const saved = await order.save();
    void this.orderLogService.info(
      id,
      OrderLogStep.ADMIN_PAYMENT_UPDATED,
      `Payment status thay đổi: ${prevStatus} → ${status}`,
      { prev_status: prevStatus, new_status: status },
      actor,
    );
    return saved;
  }

  async renew(id: string, actor = 'admin'): Promise<OrderDocument> {
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

    const newOrderId = (saved._id as Types.ObjectId).toString();
    void this.orderLogService.info(
      id,
      OrderLogStep.ADMIN_ORDER_RENEWED,
      `Order được gia hạn → order mới ${newOrder.order_code}`,
      { new_order_id: newOrderId, new_order_code: newOrder.order_code },
      actor,
    );
    void this.orderLogService.info(
      newOrderId,
      OrderLogStep.ADMIN_ORDER_RENEWED,
      `Order gia hạn từ order gốc ${original.order_code}`,
      { source_order_id: id, source_order_code: original.order_code },
      actor,
    );

    return saved;
  }

  async approveRefund(id: string, actor = 'admin'): Promise<OrderDocument> {
    const order = await this.orderModel.findById(id).exec();
    if (!order) throw new BadRequestException('Order not found');

    if (order.status !== OrderStatusEnum.PENDING_REFUND) {
      throw new BadRequestException('Order không ở trạng thái PENDING_REFUND');
    }

    if (order.payment_method !== PaymentMethodEnum.BALANCE) {
      throw new BadRequestException('Chỉ hoàn tiền được với đơn thanh toán bằng số dư');
    }

    const refundAmount = order.total_price ?? 0;
    if (refundAmount <= 0) throw new BadRequestException('Số tiền hoàn không hợp lệ');

    const user = await this.userModel.findByIdAndUpdate(
      order.user_id,
      { $inc: { money: refundAmount } },
      { new: true },
    ).exec();

    order.refunded_amount = refundAmount;
    order.status = OrderStatusEnum.FAILED;
    order.payment_status = PaymentStatusEnum.REFUNDED;
    const saved = await order.save();

    void this.orderLogService.info(
      id,
      OrderLogStep.ADMIN_REFUND_APPROVED,
      `Hoàn tiền ${refundAmount.toLocaleString()} VND cho user ${order.user_id}`,
      {
        refund_amount:   refundAmount,
        user_id:         order.user_id?.toString(),
        balance_after:   user?.money ?? null,
        new_order_status: OrderStatusEnum.FAILED,
        new_payment_status: PaymentStatusEnum.REFUNDED,
      },
      actor,
    );

    return saved;
  }

  async delete(id: string, actor = 'admin') {
    const order = await this.orderModel.findByIdAndDelete(id).exec();
    if (!order) throw new BadRequestException('Order not found');
    void this.orderLogService.info(
      id,
      OrderLogStep.ADMIN_ORDER_DELETED,
      `Order ${order.order_code} bị xóa`,
      { order_code: order.order_code },
      actor,
    );
    return { message: 'Order deleted successfully' };
  }
}
