import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as crypto from 'crypto';
import { Order, OrderDocument } from '../schemas/orders.schema';
import { User, UserDocument } from '../schemas/users.schema';
import { Service, ServiceDocument } from '../schemas/services.schema';
import { Country, CountryDocument } from '../schemas/countries.schema';
import { Proxy, ProxyDocument } from '../schemas/proxies.schema';
import { Partner, PartnerDocument } from '../schemas/partners.schema';
import { ProxyProviderFactory } from '../proxy-providers/proxy-provider.factory';
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
import { WalletTransactionService } from '../wallet/wallet-transaction.service';
import { WalletTxType } from '../schemas/wallet-transaction.schema';
import { NotificationGateway } from '../webhook/notification.gateway';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

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
    @InjectModel(Partner.name)
    private partnerModel: Model<PartnerDocument>,
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis,
    private readonly orderLogService: OrderLogService,
    private readonly walletTxService: WalletTransactionService,
    private readonly notification: NotificationGateway,
    private readonly providerFactory: ProxyProviderFactory,
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

  async buy(userId: string, dto: BuyOrderDto, idempotencyKey?: string): Promise<{
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
    let orderId: string | null = null;

    // Idempotency: nếu client gửi kèm key thì trả về kết quả cũ khi retry,
    // và lock để chặn 2 request song song cùng key.
    const idemCacheKey = idempotencyKey ? `idem:buy:${userId}:${idempotencyKey}` : null;
    const idemLockKey  = idemCacheKey ? `${idemCacheKey}:lock` : null;

    if (idemCacheKey) {
      const cached = await this.redis.get(idemCacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed?.__error) {
          throw new BadRequestException(parsed.message ?? 'Đặt hàng thất bại');
        }
        return parsed;
      }
      const lockOk = await this.redis.set(idemLockKey!, '1', 'EX', 60, 'NX');
      if (!lockOk) {
        throw new BadRequestException('Yêu cầu đang được xử lý, vui lòng chờ');
      }
    }

    try {
    // 1. Validate service
    const service = await this.serviceModel.findById(dto.service_id).exec();
    if (!service || !service.status) {
      throw new BadRequestException('Service không tồn tại hoặc đã ngừng hoạt động');
    }
    if (!service.api_enabled) {
      throw new BadRequestException('Dịch vụ này đang tạm dừng mua');
    }

    // 2. Lấy giá theo duration_days — tính server-side, không tin frontend
    const pricing = service.pricing?.[dto.duration_days];
    if (!pricing) {
      throw new BadRequestException(`Service không hỗ trợ gói ${dto.duration_days} ngày`);
    }

    const quantity      = dto.quantity ?? 1;

    // Validate quantity nằm trong giới hạn admin set cho service
    const minQty = (service as any).min_quantity && (service as any).min_quantity > 0 ? (service as any).min_quantity : 1;
    const maxQty = (service as any).max_quantity && (service as any).max_quantity > 0 ? (service as any).max_quantity : 100;
    if (quantity < minQty || quantity > maxQty) {
      throw new BadRequestException(`Số lượng phải nằm trong khoảng ${minQty} - ${maxQty}`);
    }

    // Áp discount user-specific (per duration). Floor pricePerUnit ở 0.
    const basePrice = pricing.price as number;
    const rawDiscount = (service as any).user_discounts?.[userId]?.[String(dto.duration_days)] ?? 0;
    const discountPerUnit = Math.min(basePrice, Number(rawDiscount) || 0);
    const pricePerUnit  = basePrice - discountPerUnit;
    const costPerUnit   = pricing.cost as number ?? null;
    const totalPrice    = pricePerUnit * quantity;
    const totalCost     = costPerUnit != null ? costPerUnit * quantity : null;
    const discountAmount = discountPerUnit * quantity;

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
      order_type:     service.type ?? '',
      quantity,
      duration_days:  dto.duration_days,
      price_per_unit: pricePerUnit,
      base_price_per_unit: discountPerUnit > 0 ? basePrice : null,
      discount_per_unit:   discountPerUnit,
      discount_amount:     discountAmount,
      cost_per_unit:  costPerUnit,
      total_price:    totalPrice,
      total_cost:     totalCost,
      profit:         totalCost != null ? totalPrice - totalCost : null,
      payment_status: PaymentStatusEnum.PAID,
      payment_method: PaymentMethodEnum.BALANCE,
      status:         OrderStatusEnum.PENDING,
      start_date:     now,
      end_date:       endDate,
      config: (() => {
        let bodyApi: any = {};
        try { bodyApi = JSON.parse(service.body_api ?? '{}'); } catch {}
        return {
          protocol:        dto.protocol ?? null,
          isp:             (() => {
            if (!dto.isp) return null;
            const found = (service.isp ?? []).find(
              (i: any) => i.code === dto.isp || i.name === dto.isp,
            );
            return found?.code ?? dto.isp;
          })(),
          rotate_interval: dto.rotate_interval ?? bodyApi?.rotate_interval ?? null,
          is_cdk:          bodyApi?.isCdk === true,
          ...(dto.username ? { username: dto.username } : {}),
          ...(dto.password ? { password: dto.password } : {}),
        };
      })(),
    };

    const order = new this.orderModel(dataOrder);
    await order.save();

    orderId = (order._id as Types.ObjectId).toString();

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
        base_price_per_unit: discountPerUnit > 0 ? basePrice : null,
        discount_per_unit:   discountPerUnit,
        discount_amount:     discountAmount,
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

    // (Telegram notify đã chuyển sang worker — chỉ gửi sau khi provider trả proxy)

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

    void this.walletTxService.log({
      user_id:        userId,
      type:           WalletTxType.PURCHASE,
      amount:         totalPrice,
      direction:      'out',
      balance_before: balanceBefore,
      balance_after:  balanceAfter,
      description:    `Mua proxy: ${service.name} x${quantity} (${dto.duration_days} ngày)`,
      ref_id:         orderId,
      ref_type:       'order',
      created_by:     'system',
    });

    const response = {
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

    if (idemCacheKey) {
      // Lưu 24h để mọi retry sau đó nhận lại cùng response, không trừ tiền nữa
      await this.redis.set(idemCacheKey, JSON.stringify(response), 'EX', 86400);
    }

    return response;
    } catch (err: any) {
      // Nếu order đã được tạo thì ghi lỗi vào order_logs trước khi throw
      if (orderId) {
        await this.orderLogService.error(
          orderId,
          OrderLogStep.BUY_FAILED,
          `Đặt hàng thất bại tại bước sau khi tạo order: ${err?.message ?? 'Unknown error'}`,
          { error: err?.message, duration_ms: Date.now() - t0 },
          userId,
        );
        // Đã tạo order ⇒ tiền đã trừ. Cache lỗi để retry không trừ thêm.
        if (idemCacheKey) {
          await this.redis.set(
            idemCacheKey,
            JSON.stringify({ __error: true, status: 400, message: err?.message ?? 'Đặt hàng thất bại' }),
            'EX', 86400,
          );
        }
      }
      throw err;
    } finally {
      if (idemLockKey) {
        await this.redis.del(idemLockKey).catch(() => {});
      }
    }
  }

  async findAllPaginated(query: PaginationQueryDto) {
    const page  = query.page ?? 1;
    const limit = query.limit ?? 10;
    const search = query.search ?? '';
    const skip  = (page - 1) * limit;

    const filter: any = {};

    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const orConditions: any[] = [
        { order_code: { $regex: escaped, $options: 'i' } },
        { provider_order_id: { $regex: escaped, $options: 'i' } },
      ];

      if (Types.ObjectId.isValid(search)) {
        orConditions.push({ user_id: new Types.ObjectId(search) });
      }

      const matchedUsers = await this.userModel
        .find({
          $or: [
            { email: { $regex: escaped, $options: 'i' } },
            { full_name: { $regex: escaped, $options: 'i' } },
          ],
        })
        .select('_id')
        .limit(50)
        .lean()
        .exec();

      if (matchedUsers.length > 0) {
        orConditions.push({ user_id: { $in: matchedUsers.map(u => u._id) } });
      }

      filter['$or'] = orConditions;
    }

    if (query.partner_id) {
      filter.partner_id = new Types.ObjectId(query.partner_id);
    }
    if (query.order_type) {
      filter.proxy_type = query.order_type;
    }
    if (query.order_status) {
      filter.status = Number(query.order_status);
    }
    if (query.date_range) {
      const days = Number(query.date_range);
      if (days > 0) {
        filter.createdAt = { $gte: new Date(Date.now() - days * 86400000) };
      }
    }

    const [raw, total] = await Promise.all([
      this.orderModel
        .find(filter)
        .populate('user_id', 'email full_name')
        .populate('service_id', 'name proxy_type ip_version allow_renew')
        .populate('country_id', 'name code')
        .populate('partner_id', 'name domain')
        .skip(skip)
        .limit(limit)
        .sort({ createdAt: -1 })
        .lean()
        .exec(),
      this.orderModel.countDocuments(filter).exec(),
    ]);

    const data = raw.map(({ user_id, ...rest }) => ({
      ...rest,
      user_id: user_id?._id ?? user_id,
      user: user_id,
    }));

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
        .populate('service_id', 'name proxy_type ip_version allow_renew')
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
      .populate('service_id', 'name proxy_type ip_version allow_renew')
      .populate('country_id', 'name code')
      .populate('partner_id', '_id code name')
      .select('-admin_note -cost_per_unit -total_cost -profit -provider_order_id -error_message -credentials')
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
        .select('ip_address port protocol auth_username auth_password cdk_key country_code region city isp is_active health_status domain provider provider_proxy_id location')
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

  async findOneAdmin(id: string, query: PaginationQueryDto) {
    const order = await this.orderModel
      .findById(id)
      .populate('user_id', 'email full_name')
      .populate('service_id', 'name proxy_type ip_version allow_renew')
      .populate('country_id', 'name code')
      .populate('partner_id', 'name code')
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
        .select('ip_address port protocol auth_username auth_password cdk_key country_code region city isp is_active health_status domain provider provider_proxy_id location')
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      this.proxyModel.countDocuments(proxyFilter).exec(),
    ]);

    const { user_id, ...rest } = order as any;
    return {
      ...rest,
      user: user_id,
      proxies: {
        data: proxies,
        meta: { total: totalProxies, page, limit, totalPages: Math.ceil(totalProxies / limit) },
      },
    };
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

    if (user && order.user_id) {
      const balanceAfter  = Number(user.money ?? 0);
      const balanceBefore = balanceAfter - refundAmount;
      void this.walletTxService.log({
        user_id:        order.user_id.toString(),
        type:           WalletTxType.REFUND,
        amount:         refundAmount,
        direction:      'in',
        balance_before: balanceBefore,
        balance_after:  balanceAfter,
        description:    `Hoàn tiền đơn hàng ${order.order_code ?? id}`,
        ref_id:         id,
        ref_type:       'order',
        created_by:     actor,
      });
    }

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

  async buySync(userId: string, dto: BuyOrderDto, idempotencyKey?: string): Promise<{
    status: string;
    statusCode: number;
    message: string;
    order_code?: string;
    proxiesip?: string[];
    timestamp?: number;
  }> {
    const POLL_INTERVAL_MS = 500;
    const MAX_WAIT_MS      = 60_000;

    // 1. Tạo order và trừ tiền
    const buyResult = await this.buy(userId, dto, idempotencyKey);
    const orderId   = buyResult.data.order_id;

    // 2. Poll DB cho đến khi ACTIVE / FAILED / timeout
    const deadline = Date.now() + MAX_WAIT_MS;

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

      const order = await this.orderModel
        .findById(orderId)
        .select('status error_message')
        .lean()
        .exec();

      if (!order) throw new BadRequestException('Order not found');

      if (order.status === OrderStatusEnum.ACTIVE || order.status === OrderStatusEnum.PARTIAL) {
        const proxies = await this.proxyModel
          .find({ order_id: new Types.ObjectId(orderId) })
          .select('ip_address port auth_username auth_password cdk_key')
          .lean()
          .exec();

        // CDK proxy → trả cdk_key; proxy thường → trả ip:port:user:pass
        const proxiesip = proxies.map(p =>
          (p as any).cdk_key
            ? (p as any).cdk_key
            : `${p.ip_address}:${p.port}:${p.auth_username}:${p.auth_password}`,
        );

        return {
          status:     'SUCCESS',
          statusCode: 200,
          message:    'Giao dịch thành công!',
          order_code: buyResult.data.order_code,
          proxiesip,
          timestamp:  Math.floor(new Date(buyResult.data.end_date).getTime() / 1000),
        };
      }

      if (
        order.status === OrderStatusEnum.PENDING_REFUND ||
        order.status === OrderStatusEnum.FAILED
      ) {
        return {
          status:     'FAILED',
          statusCode: 400,
          message:    (order as any).error_message ?? 'Đặt hàng thất bại, tiền sẽ được hoàn vào số dư',
          order_code: buyResult.data.order_code,
        };
      }
    }

    return {
      status:     'TIMEOUT',
      statusCode: 408,
      message:    'Timeout: không nhận được proxy sau 60 giây, vui lòng liên hệ hỗ trợ',
      order_code: buyResult.data.order_code,
    };
  }

  /**
   * Admin hoàn tiền thủ công cho bất kỳ đơn nào.
   * - amount: số tiền hoàn (mặc định = total_price - refunded_amount đã hoàn trước đó)
   * - cancelOrder: nếu true → đổi status sang CANCELLED sau khi hoàn
   */
  async adminRefund(
    id: string,
    amount?: number,
    note?: string,
    cancelOrder = true,
    actor = 'admin',
  ): Promise<{ refunded_amount: number; balance_after: number; order: OrderDocument }> {
    const order = await this.orderModel.findById(id).exec();
    if (!order) throw new BadRequestException('Order not found');

    const BLOCKED_STATUSES = [OrderStatusEnum.ACTIVE, OrderStatusEnum.COMPLETED];
    if (BLOCKED_STATUSES.includes(order.status)) {
      throw new BadRequestException(
        `Không thể hoàn tiền đơn đang ở trạng thái "${order.status === OrderStatusEnum.ACTIVE ? 'Đang chạy' : 'Hoàn thành'}"`,
      );
    }

    const alreadyRefunded = order.refunded_amount ?? 0;
    const maxRefund       = (order.total_price ?? 0) - alreadyRefunded;

    const refundAmount = amount != null ? amount : maxRefund;

    if (refundAmount <= 0) {
      throw new BadRequestException('Số tiền hoàn không hợp lệ hoặc đơn đã được hoàn toàn bộ');
    }
    if (refundAmount > maxRefund) {
      throw new BadRequestException(
        `Số tiền hoàn vượt quá giới hạn. Tối đa còn có thể hoàn: ${maxRefund.toLocaleString()} VND`,
      );
    }

    // Cộng tiền vào ví user
    const user = await this.userModel.findByIdAndUpdate(
      order.user_id,
      { $inc: { money: refundAmount } },
      { new: true },
    ).exec();

    if (!user) throw new BadRequestException('Không tìm thấy user của đơn hàng');

    // Cập nhật order
    order.refunded_amount = alreadyRefunded + refundAmount;
    if (cancelOrder) {
      order.status = OrderStatusEnum.CANCELLED;
      order.payment_status = PaymentStatusEnum.REFUNDED;
    }
    if (note) order.admin_note = note;
    const saved = await order.save();

    // Ghi wallet transaction
    const balanceAfter  = Number(user.money ?? 0);
    const balanceBefore = balanceAfter - refundAmount;
    void this.walletTxService.log({
      user_id:        order.user_id.toString(),
      type:           WalletTxType.REFUND,
      amount:         refundAmount,
      direction:      'in',
      balance_before: balanceBefore,
      balance_after:  balanceAfter,
      description:    `Admin hoàn tiền đơn ${order.order_code ?? id}${note ? ': ' + note : ''}`,
      ref_id:         id,
      ref_type:       'order',
      created_by:     actor,
    });

    void this.orderLogService.info(
      id,
      OrderLogStep.ADMIN_REFUND_APPROVED,
      `Admin hoàn ${refundAmount.toLocaleString()} VND cho user ${order.user_id}`,
      {
        refund_amount:       refundAmount,
        already_refunded:    alreadyRefunded,
        total_refunded:      order.refunded_amount,
        user_id:             order.user_id?.toString(),
        balance_after:       balanceAfter,
        cancel_order:        cancelOrder,
        note:                note ?? null,
      },
      actor,
    );

    return { refunded_amount: refundAmount, balance_after: balanceAfter, order: saved };
  }

  /**
   * Hoàn tiền số proxy còn thiếu cho đơn PARTIAL.
   *
   * - missing_qty    = quantity - actual_quantity
   * - missing_amount = missing_qty × price_per_unit
   *
   * Sau khi hoàn:
   * - Giữ nguyên quantity/total_price (số đã đặt mua ban đầu) → audit rõ ràng
   * - refunded_amount += missing_amount (cộng dồn vào field hiện có)
   * - status = PARTIAL_REFUNDED → để thống kê đơn "hoàn 1 phần do thiếu"
   * - Ghi audit log riêng với step ADMIN_REFUND_MISSING (data chứa đầy đủ
   *   missing_qty, missing_amount, original_qty, actual_qty, balance_after,
   *   để sau này query thống kê: tổng số proxy thiếu, tổng tiền hoàn, ...)
   */
  async refundMissingQuantity(id: string, actor = 'admin') {
    const order = await this.orderModel.findById(id).exec();
    if (!order) throw new BadRequestException('Order not found');

    if (order.status !== OrderStatusEnum.PARTIAL) {
      throw new BadRequestException('Đơn không ở trạng thái PARTIAL (thiếu số lượng)');
    }
    const actualQty = order.actual_quantity;
    if (actualQty == null) {
      throw new BadRequestException('Đơn chưa có actual_quantity');
    }
    const originalQty = order.quantity ?? 0;
    const missingQty  = originalQty - actualQty;
    if (missingQty <= 0) {
      throw new BadRequestException('Đơn không thiếu số lượng');
    }
    const missingAmount = missingQty * (order.price_per_unit ?? 0);
    if (missingAmount <= 0) {
      throw new BadRequestException('Số tiền thiếu không hợp lệ');
    }

    const note = `Hoàn tiền ${missingQty}/${originalQty} proxy thiếu (${missingAmount.toLocaleString()} VND)`;

    // adminRefund() đã: cộng tiền vào ví user, cộng dồn refunded_amount,
    // ghi wallet transaction (type=REFUND), ghi order log (ADMIN_REFUND_APPROVED).
    // Truyền cancelOrder=false để KHÔNG đổi sang CANCELLED.
    const result = await this.adminRefund(id, missingAmount, note, false, actor);

    // Đổi status sang PARTIAL_REFUNDED để filter/thống kê
    const fresh = await this.orderModel.findById(id).exec();
    if (fresh) {
      fresh.status = OrderStatusEnum.PARTIAL_REFUNDED;
      await fresh.save();
    }

    // Audit log dành riêng cho "hoàn tiền thiếu số lượng"
    void this.orderLogService.info(
      id,
      OrderLogStep.ADMIN_REFUND_MISSING,
      `Admin hoàn ${missingAmount.toLocaleString()} VND cho ${missingQty}/${originalQty} proxy thiếu`,
      {
        original_quantity: originalQty,
        actual_quantity:   actualQty,
        missing_quantity:  missingQty,
        price_per_unit:    order.price_per_unit ?? 0,
        missing_amount:    missingAmount,
        total_refunded:    result.refunded_amount + (order.refunded_amount ?? 0) - missingAmount,
        balance_after:     result.balance_after,
      },
      actor,
    );

    return {
      ...result,
      original_quantity: originalQty,
      actual_quantity:   actualQty,
      missing_quantity:  missingQty,
      missing_amount:    missingAmount,
    };
  }

  async retryOrder(id: string, actor = 'admin') {
    const order = await this.orderModel.findById(id).exec();
    if (!order) throw new BadRequestException('Order not found');

    const retryableStatuses = [
      OrderStatusEnum.FAILED,
      OrderStatusEnum.PENDING_REFUND,
    ];
    if (!retryableStatuses.includes(order.status)) {
      throw new BadRequestException(
        `Chỉ có thể mua lại đơn ở trạng thái FAILED hoặc PENDING_REFUND (hiện tại: ${order.status})`,
      );
    }

    // Delete old proxies of this order
    await this.proxyModel.deleteMany({ order_id: order._id }).exec();

    // Reset order status
    order.status = OrderStatusEnum.PENDING;
    order.error_message = '';
    order.provider_order_id = '';
    await order.save();

    // Push back to Redis queue
    await this.redis.lpush(PENDING_ORDERS_KEY, id);

    void this.orderLogService.info(
      id,
      OrderLogStep.ADMIN_ORDER_RETRY,
      `Admin đã yêu cầu mua lại đơn hàng`,
      { actor, previous_status: order.status },
      actor,
    );

    return { message: 'Đơn hàng đã được đẩy lại vào hàng đợi xử lý', order };
  }

  /**
   * Lấy `id_service` (loaiproxy với ProxyVN) dựa trên partner code + order config.
   * Copy logic từ orders.worker.service.ts để đảm bảo renew dùng đúng giá trị như buy.
   */
  private deriveIdService(partnerCode: string, order: OrderDocument, service: any): string {
    const isp = (order.config?.isp as string) ?? '';

    if (partnerCode === 'homeproxy') {
      const isRotating = (order as any).order_type === 'rotating';
      if (isRotating) {
        switch (order.duration_days) {
          case 1:  return '7d57163a-9e09-4ee1-b52f-8c99dff60aa9';
          case 7:  return '6bde5588-8ad8-4d3a-adc7-fefc790745e1';
          case 30: return 'f792c198-380a-4851-89f7-408b432e46fa';
          default: return '';
        }
      }
      switch (isp.toLowerCase()) {
        case 'vnpt':    return '528d39a9-f826-4c65-989c-4591d9f0dce3';
        case 'viettel': return 'f3ea6303-8b3e-4f8f-a0f7-43765929d3dd';
        case 'fpt':     return 'f0be21c6-2deb-499c-9d5d-7bba3f765a26';
        default: return '';
      }
    }

    if (partnerCode === 'proxyvn') {
      return isp; // VD: "Viettel", "DatacenterA"
    }

    if (partnerCode === 'twoproxy') {
      return isp; // VD: "Viettel_thuong_2"
    }

    return service?.id_service || '';
  }

  /**
   * Lấy id_service dùng cho RENEW (khác BUY ở chỗ HomeProxy trả categoryTypeId thay vì product.id):
   * - HomeProxy: "1" (tĩnh) | "2" (rotating)
   * - Các provider khác: dùng chung logic với buy.
   */
  private deriveIdServiceForRenew(partnerCode: string, order: OrderDocument, service: any): string {
    if (partnerCode === 'homeproxy') {
      const isRotating = (order as any).order_type === 'rotating';
      return isRotating ? '2' : '1';
    }
    return this.deriveIdService(partnerCode, order, service);
  }

  /**
   * User tự gia hạn order của chính mình:
   * - Trừ tiền từ balance (price_per_unit × quantity × duration_days)
   * - Gọi provider.renew() gia hạn proxy
   * - Nếu fail toàn bộ → rollback tiền
   * - Nếu thành công → update end_date, log wallet tx
   */
  async renewByUser(userId: string, orderId: string, duration_days: number) {
    if (!duration_days || duration_days < 1) {
      throw new BadRequestException('duration_days phải >= 1');
    }

    if (!Types.ObjectId.isValid(orderId)) {
      throw new BadRequestException('Order id không hợp lệ');
    }

    const order = await this.orderModel
      .findById(orderId)
      .populate('service_id')
      .populate('partner_id')
      .exec();
    if (!order) throw new BadRequestException('Order không tồn tại');

    // Check order thuộc về user đang login
    if (order.user_id?.toString() !== userId) {
      throw new BadRequestException('Bạn không có quyền gia hạn đơn hàng này');
    }

    if (order.status !== OrderStatusEnum.ACTIVE) {
      throw new BadRequestException('Chỉ có thể gia hạn đơn ở trạng thái ACTIVE');
    }

    const partner = order.partner_id as any;
    if (!partner?.token_api || !partner?.code) {
      throw new BadRequestException('Order không có thông tin NCC');
    }

    const service = order.service_id as any;

    if (service?.allow_renew === false) {
      throw new BadRequestException('Dịch vụ này không hỗ trợ gia hạn');
    }

    const proxies = await this.proxyModel
      .find({ order_id: order._id, provider_proxy_id: { $exists: true, $ne: '' } })
      .select('provider_proxy_id')
      .lean()
      .exec();

    if (proxies.length === 0) {
      throw new BadRequestException('Không có proxy nào để gia hạn');
    }

    // 1. Tính phí gia hạn
    const pricePerUnit = Number(order.price_per_unit ?? 0);
    const quantity     = Number(order.quantity ?? 0);
    const totalPrice   = pricePerUnit * quantity * duration_days;
    if (totalPrice <= 0) {
      throw new BadRequestException('Không thể xác định giá gia hạn');
    }

    // 2. Trừ tiền atomic (chỉ trừ khi đủ)
    const deducted = await this.userModel.findOneAndUpdate(
      { _id: new Types.ObjectId(userId), money: { $gte: totalPrice } },
      { $inc: { money: -totalPrice } },
      { new: true },
    ).exec();

    if (!deducted) {
      throw new BadRequestException('Số dư không đủ để gia hạn');
    }

    // 3. Gọi provider.renew() — nếu fail toàn bộ thì rollback tiền
    const provider = this.providerFactory.getProvider(partner.code);
    const idService = this.deriveIdServiceForRenew(partner.code, order, service);
    let result;
    try {
      result = await provider.renew({
        token_api:          partner.token_api,
        provider_order_id:  order.provider_order_id ?? '',
        duration_days,
        provider_proxy_ids: proxies.map(p => p.provider_proxy_id),
        id_service:         idService,
        provider_metadata:  order.provider_metadata,
      });
    } catch (err: any) {
      // Rollback tiền nếu provider fail
      await this.userModel.findByIdAndUpdate(userId, { $inc: { money: totalPrice } }).exec();
      this.logger.error(`Order ${orderId}: user renew fail — rollback ${totalPrice} VND: ${err?.message}`);
      void this.orderLogService.error(
        orderId,
        OrderLogStep.USER_ORDER_RENEWED,
        `Gia hạn thất bại, đã hoàn tiền ${totalPrice.toLocaleString('vi-VN')} VND`,
        { duration_days, totalPrice, error: err?.message },
        userId,
      );
      throw new BadRequestException(`Gia hạn thất bại: ${err?.message ?? 'Unknown'}`);
    }

    const raw = result.raw ?? {};
    const successCount = raw.successCount ?? proxies.length;
    const failCount    = raw.failCount ?? 0;

    // 4. Update order.end_date
    const oldEndDate = new Date(order.end_date);
    const newEndDate = result.new_end_date
      ? new Date(result.new_end_date)
      : new Date(oldEndDate.getTime() + duration_days * 86400000);
    order.end_date = newEndDate;
    order.duration_days = (order.duration_days ?? 0) + duration_days;
    await order.save();

    // 5. Log wallet transaction
    const balanceAfter  = Number(deducted.money ?? 0);
    const balanceBefore = balanceAfter + totalPrice;
    void this.walletTxService.log({
      user_id:        userId,
      type:           WalletTxType.RENEW,
      amount:         totalPrice,
      direction:      'out',
      balance_before: balanceBefore,
      balance_after:  balanceAfter,
      description:    `Gia hạn proxy: ${service.name ?? ''} x${quantity} (${duration_days} ngày)`,
      ref_id:         orderId,
      ref_type:       'order',
      created_by:     userId,
    });

    // 6. Log order
    this.logger.log(`Order ${orderId}: user gia hạn ${successCount}/${proxies.length} proxy thêm ${duration_days} ngày, trừ ${totalPrice} VND`);
    void this.orderLogService.info(
      orderId,
      OrderLogStep.USER_ORDER_RENEWED,
      `User gia hạn ${successCount} proxy thêm ${duration_days} ngày (đến ${newEndDate.toLocaleDateString('vi-VN')})${failCount > 0 ? `, ${failCount} proxy thất bại` : ''} — trừ ${totalPrice.toLocaleString('vi-VN')} VND`,
      { duration_days, successCount, failCount, totalPrice, old_end_date: oldEndDate, new_end_date: newEndDate, balance_after: balanceAfter },
      userId,
    );

    return {
      success: true,
      message: `Gia hạn thành công ${successCount}/${proxies.length} proxy thêm ${duration_days} ngày`,
      data: {
        successCount,
        failCount,
        totalPrice,
        new_end_date:  newEndDate,
        balance_after: balanceAfter,
      },
    };
  }

  async updateProxy(proxyId: string, data: { ip_address?: string; port?: number; auth_username?: string; auth_password?: string; provider_proxy_id?: string }) {
    if (!Types.ObjectId.isValid(proxyId)) throw new BadRequestException('Invalid proxy ID');
    const proxy = await this.proxyModel.findById(proxyId).exec();
    if (!proxy) throw new BadRequestException('Proxy not found');

    if (data.ip_address !== undefined) proxy.ip_address = data.ip_address;
    if (data.port !== undefined) proxy.port = data.port;
    if (data.auth_username !== undefined) proxy.auth_username = data.auth_username;
    if (data.auth_password !== undefined) proxy.auth_password = data.auth_password;
    if (data.provider_proxy_id !== undefined) proxy.provider_proxy_id = data.provider_proxy_id;

    await proxy.save();
    return { message: 'Cập nhật proxy thành công', proxy };
  }

  async importProxies(id: string, lines: string[], actor = 'admin') {
    const order = await this.orderModel.findById(id).populate('service_id').populate('country_id').exec();
    if (!order) throw new BadRequestException('Order not found');

    const parsed = lines
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(':');
        if (parts.length < 2) return null;
        return {
          ip: parts[0],
          port: Number(parts[1]),
          username: parts[2] || '',
          password: parts[3] || '',
          provider_proxy_id: parts[4] || '',
        };
      })
      .filter((x): x is NonNullable<typeof x> => Boolean(x));

    if (parsed.length === 0) {
      throw new BadRequestException('Không có proxy hợp lệ để import');
    }

    const service = order.service_id as any;
    const country = await this.countryModel.findById(order.country_id).exec();
    if (!country?.code) {
      throw new BadRequestException('Order chưa có thông tin quốc gia hoặc quốc gia chưa có mã code');
    }
    const countryCode = country.code;

    // Check duplicate proxies in this order
    const existingProxies = await this.proxyModel.find({ order_id: order._id }).select('ip_address port').lean().exec();
    const existingSet = new Set(existingProxies.map((p) => `${p.ip_address}:${p.port}`));

    const duplicates: string[] = [];
    const newParsed = parsed.filter((p) => {
      const key = `${p.ip}:${p.port}`;
      if (existingSet.has(key)) {
        duplicates.push(key);
        return false;
      }
      return true;
    });

    if (newParsed.length === 0 && duplicates.length > 0) {
      throw new BadRequestException(`Tất cả proxy đều đã tồn tại trong order: ${duplicates.join(', ')}`);
    }

    const docs = newParsed.map((p) => ({
      order_id: order._id,
      proxy_type_id: service?._id ?? null,
      ip_address: p.ip,
      port: p.port,
      protocol: (order.config as any)?.protocol || 'http',
      auth_username: p.username,
      auth_password: p.password,
      provider_proxy_id: p.provider_proxy_id || undefined,
      country_code: countryCode,
      provider: 'manual',
      is_active: true,
      is_available: true,
    }));

    await this.proxyModel.insertMany(docs);

    // Check if order now has enough proxies
    const totalProxies = await this.proxyModel.countDocuments({ order_id: order._id }).exec();
    if (totalProxies >= order.quantity && order.status !== OrderStatusEnum.ACTIVE) {
      order.status = OrderStatusEnum.ACTIVE;
      order.error_message = '';
      await order.save();
    }

    void this.orderLogService.info(
      id,
      OrderLogStep.ADMIN_PROXY_IMPORTED,
      `Admin đã import ${newParsed.length} proxy thủ công (tổng: ${totalProxies}/${order.quantity})${duplicates.length ? `, ${duplicates.length} proxy trùng` : ''}`,
      { imported: newParsed.length, duplicates: duplicates.length, total: totalProxies, quantity: order.quantity },
      actor,
    );

    return {
      message: duplicates.length
        ? `Import thành công ${newParsed.length} proxy, ${duplicates.length} proxy đã tồn tại: ${duplicates.join(', ')}`
        : `Import thành công ${newParsed.length} proxy`,
      imported: newParsed.length,
      duplicates,
      total: totalProxies,
      quantity: order.quantity,
    };
  }

  /**
   * Admin nhập provider_order_id cho 1 đơn rồi gọi lại API provider để fetch proxy.
   * Dùng khi BUY trả về rỗng/lỗi nhưng đơn đã được tạo bên provider.
   */
  async syncProviderOrder(id: string, providerOrderId: string, actor = 'admin') {
    id = (id || '').trim();
    providerOrderId = (providerOrderId || '').trim();

    // Cho phép :id là Mongo _id, order_code hoặc provider_order_id.
    let order: OrderDocument | null = null;
    if (Types.ObjectId.isValid(id) && id.length === 24) {
      order = await this.orderModel.findById(id).exec();
    }
    if (!order) {
      order = await this.orderModel.findOne({ order_code: id }).exec();
    }
    if (!order) {
      order = await this.orderModel.findOne({ provider_order_id: id }).exec();
      // Nếu tìm thấy theo provider_order_id và body không truyền, dùng luôn :id làm provider_order_id
      if (order && !providerOrderId) providerOrderId = id;
    }
    if (!order) throw new BadRequestException('Order not found');

    if (!providerOrderId) {
      providerOrderId = order.provider_order_id || '';
    }
    if (!providerOrderId) {
      throw new BadRequestException('Thiếu provider_order_id (truyền trong body hoặc nằm sẵn trong order)');
    }

    const partner = order.partner_id
      ? await this.partnerModel.findById(order.partner_id).select('code token_api').exec()
      : null;

    if (!partner?.code || !partner?.token_api) {
      throw new BadRequestException('Order không có partner hợp lệ');
    }

    const provider = this.providerFactory.getProvider(partner.code);
    if (!provider.fetchOrderProxies) {
      throw new BadRequestException(`Provider "${partner.code}" không hỗ trợ fetchOrderProxies`);
    }

    // Cập nhật provider_order_id cho order (nếu khác)
    if (order.provider_order_id !== providerOrderId) {
      order.provider_order_id = providerOrderId;
      await order.save();
    }

    const proxies = await provider.fetchOrderProxies(
      partner.token_api,
      providerOrderId,
      {
        metadata: order.provider_metadata,
        protocol: (order.config as any)?.protocol ?? (order as any).protocol,
      },
    );

    if (!proxies || proxies.length === 0) {
      void this.orderLogService.warn(
        id,
        OrderLogStep.POLLING_NO_PROXIES,
        `Admin sync: provider chưa trả proxy cho provider_order_id=${providerOrderId}`,
        { actor, provider_order_id: providerOrderId },
      );
      return { message: 'Provider chưa trả proxy, hãy thử lại sau', imported: 0, total: 0, quantity: order.quantity };
    }

    this.logger.log(
      `syncProviderOrder: provider trả ${proxies.length} proxy. Sample: host=${proxies[0]?.host} port=${proxies[0]?.port} user=${proxies[0]?.username}`,
    );

    // Tránh insert trùng theo (ip,port) trong cùng order
    const existing = await this.proxyModel
      .find({ order_id: order._id })
      .select('ip_address port')
      .lean()
      .exec();
    const existingSet = new Set(existing.map((p) => `${p.ip_address}:${p.port}`));

    const orderObjectId = new Types.ObjectId(order._id as any);
    const isCdk = (order.config as any)?.is_cdk === true;
    const docs = proxies
      .filter((p: any) => !existingSet.has(`${p.host}:${Number(p.port)}`))
      .map((p: any) => {
        const doc: Record<string, any> = {
          order_id:          orderObjectId,
          proxy_type_id:     order.service_id ?? null,
          ip_address:        p.host,
          port:              Number(p.port),
          protocol:          (p.protocol?.toLowerCase() ?? 'http'),
          auth_username:     p.username,
          auth_password:     p.password,
          domain:            p.domain   ?? '',
          prev_ip:           p.prev_ip  ?? '',
          location:          p.location ?? '',
          isp:               p.isp      ?? '',
          provider:          partner.code,
          country_code:      p.country_code ?? 'VN',
          is_active:         true,
          is_available:      false,
        };
        if (p.provider_proxy_id) doc.provider_proxy_id = p.provider_proxy_id;
        if (p.provider_metadata) doc.provider_metadata = p.provider_metadata;
        if (isCdk) doc.cdk_key = crypto.randomBytes(16).toString('hex');
        return doc;
      });

    let insertErrorMsg = '';
    if (docs.length) {
      try {
        await this.proxyModel.insertMany(docs, { ordered: false });
      } catch (err: any) {
        if (err?.code !== 11000) throw err;
        const writeErrors = err?.writeErrors ?? err?.result?.result?.writeErrors ?? [];
        insertErrorMsg = writeErrors
          .slice(0, 3)
          .map((e: any) => e?.errmsg ?? e?.err?.errmsg ?? JSON.stringify(e))
          .join(' | ');
        this.logger.warn(
          `syncProviderOrder insertMany E11000: ${writeErrors.length}/${docs.length} duplicates. Sample: ${insertErrorMsg}`,
        );
      }
    }

    const total = await this.proxyModel.countDocuments({ order_id: order._id }).exec();

    if (total >= order.quantity) {
      order.status = OrderStatusEnum.ACTIVE;
      order.error_message = '';
      await order.save();
    } else if (total > 0) {
      order.status = OrderStatusEnum.PARTIAL;
      (order as any).actual_quantity = total;
      await order.save();
    }

    void this.orderLogService.info(
      id,
      OrderLogStep.ADMIN_PROXY_IMPORTED,
      `Admin sync provider_order_id=${providerOrderId}: nhận ${docs.length} proxy mới (tổng ${total}/${order.quantity})`,
      { actor, provider_order_id: providerOrderId, imported: docs.length, total, quantity: order.quantity },
      actor,
    );

    return {
      message: `Đồng bộ thành công: thêm ${docs.length} proxy (tổng ${total}/${order.quantity})`,
      imported: docs.length,
      total,
      quantity: order.quantity,
      status: order.status,
    };
  }

  /**
   * Admin chọn 1 số proxy (theo _id) rồi "Lấy từ NCC" → gọi provider lấy lại
   * dữ liệu mới nhất theo provider_proxy_id (idproxy) và GHI ĐÈ ip/port/user/pass.
   * Áp dụng mọi NCC: ưu tiên fetchProxiesByIds, fallback fetchOrderProxies + lọc theo id.
   */
  async refetchProxies(id: string, proxyIds: string[], actor = 'admin') {
    id = (id || '').trim();
    proxyIds = (proxyIds ?? []).map((x) => String(x).trim()).filter(Boolean);
    if (!proxyIds.length) {
      throw new BadRequestException('Chưa chọn proxy nào để lấy lại');
    }

    const order = await this.orderModel.findById(id).populate('service_id').exec();
    if (!order) throw new BadRequestException('Order not found');

    const partner = order.partner_id
      ? await this.partnerModel.findById(order.partner_id).select('code token_api').exec()
      : null;
    if (!partner?.code || !partner?.token_api) {
      throw new BadRequestException('Order không có partner hợp lệ');
    }

    const provider = this.providerFactory.getProvider(partner.code);

    // Proxy đã chọn (bắt buộc thuộc đúng order này)
    const validIds = proxyIds.filter((x) => Types.ObjectId.isValid(x) && x.length === 24);
    const selected = await this.proxyModel
      .find({ _id: { $in: validIds.map((x) => new Types.ObjectId(x)) }, order_id: order._id })
      .exec();
    if (!selected.length) {
      throw new BadRequestException('Không tìm thấy proxy đã chọn trong đơn này');
    }

    const providerProxyIds = selected
      .map((p) => (p as any).provider_proxy_id)
      .filter((x: any): x is string => !!x)
      .map((x: any) => String(x));
    if (!providerProxyIds.length) {
      throw new BadRequestException('Proxy đã chọn không có ID nhà cung cấp (provider_proxy_id)');
    }

    const service = order.service_id as any;
    const idService = this.deriveIdService(partner.code, order, service);

    // Lấy dữ liệu mới từ NCC
    let fresh: any[] = [];
    if (provider.fetchProxiesByIds) {
      fresh = await provider.fetchProxiesByIds(partner.token_api, providerProxyIds, {
        id_service: idService,
        metadata: order.provider_metadata,
      });
    } else if (provider.fetchOrderProxies) {
      const all = await provider.fetchOrderProxies(
        partner.token_api,
        order.provider_order_id || '',
        {
          metadata: order.provider_metadata,
          protocol: (order.config as any)?.protocol ?? (order as any).protocol,
        },
      );
      const wanted = new Set(providerProxyIds);
      fresh = (all ?? []).filter(
        (p) => p.provider_proxy_id && wanted.has(String(p.provider_proxy_id)),
      );
    } else {
      throw new BadRequestException(`Provider "${partner.code}" không hỗ trợ lấy lại proxy`);
    }

    const freshById = new Map<string, any>(
      fresh
        .filter((p) => p?.provider_proxy_id)
        .map((p) => [String(p.provider_proxy_id), p]),
    );

    let updated = 0;
    for (const proxy of selected) {
      const pid = (proxy as any).provider_proxy_id
        ? String((proxy as any).provider_proxy_id)
        : '';
      const f = pid ? freshById.get(pid) : undefined;
      if (!f) continue;
      proxy.ip_address    = f.host;
      proxy.port          = Number(f.port);
      proxy.auth_username = f.username;
      proxy.auth_password = f.password;
      if (f.protocol) (proxy as any).protocol = f.protocol;
      if (f.domain)   proxy.domain = f.domain;
      if (f.isp)      (proxy as any).isp = f.isp;
      proxy.is_active = true;
      await proxy.save();
      updated++;
    }

    void this.orderLogService.info(
      id,
      OrderLogStep.ADMIN_PROXY_IMPORTED,
      `Admin lấy lại ${updated}/${selected.length} proxy từ NCC ${partner.code}`,
      { actor, updated, total: selected.length, provider_proxy_ids: providerProxyIds },
      actor,
    );

    return {
      message:
        updated > 0
          ? `Đã cập nhật ${updated}/${selected.length} proxy từ NCC`
          : 'NCC chưa trả dữ liệu cho các proxy đã chọn — thử lại sau',
      updated,
      total: selected.length,
    };
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
