import { BadRequestException, ConflictException, Inject, Injectable, Logger, OnModuleInit, ServiceUnavailableException, HttpException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Cron } from '@nestjs/schedule';
import { Connection, Model, Types } from 'mongoose';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
import { Order, OrderDocument } from '../schemas/orders.schema';
import { User, UserDocument } from '../schemas/users.schema';
import { Service, ServiceDocument } from '../schemas/services.schema';
import { Proxy, ProxyDocument } from '../schemas/proxies.schema';
import { createHash } from 'crypto';
import { AffiliateService } from '../affiliate/affiliate.service';
import { OrderStatusEnum as OS, PaymentStatusEnum } from '../enum/order.enum';
import { AUDIT_CAP, RECEIPT_CAP, RESERVATION_CAP, discount, fingerprint, integer, missingRefund, normalizeCode, validateVoucher } from './voucher.rules';

// Native collections intentionally preserve full, versioned durable snapshots. Each monetary
// boundary is ONE document update; none of these operations requires Mongo transactions.
@Injectable()
export class VouchersService implements OnModuleInit {
  private readonly logger = new Logger(VouchersService.name);
  private indexes: Promise<any> | undefined;
  private busy = false;
  constructor(@InjectConnection() private readonly db: Connection,
    @InjectModel(Order.name) private readonly orders: Model<OrderDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(Service.name) private readonly services: Model<ServiceDocument>,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectModel(Proxy.name) private readonly proxies: Model<ProxyDocument>,
    private readonly affiliate: AffiliateService) {}
  // Flexible versioned BSON snapshots; monetary/query invariants are exercised against
  // real standalone Mongo below rather than relying on driver index-signature typing.
  get vouchers(): any { return this.db.collection('vouchers'); }
  get intents(): any { return this.db.collection('voucher_purchase_intents'); }
  get limits() { return this.db.collection('voucher_quote_limits'); }
  async onModuleInit() { await this.ready(); }
  private ready() {
    return this.indexes ??= Promise.all([
      this.vouchers.createIndex({ code: 1 }, { unique: true }),
      this.intents.createIndex({ userId: 1, key: 1 }, { unique: true }),
      this.intents.createIndex({ 'order._id': 1 }, { unique: true }),
      this.intents.createIndex({ state: 1, updatedAt: 1 }),
      this.intents.createIndex({ code: 1, userId: 1, serviceId: 1, status: 1, createdAt: -1 }),
      this.limits.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    ]);
  }
  private id(value: string) {
    if (!Types.ObjectId.isValid(value)) throw new BadRequestException('Invalid ID');
    return new Types.ObjectId(value);
  }
  private publicVoucher(v: any) {
    if (!v) return v;
    const { reservations, audit, ...result } = v;
    return result;
  }
  async write(body: any, actor: string, id?: string) {
    await this.ready();
    const fields = validateVoucher(body);
    const found = await this.services.countDocuments({ _id: { $in: fields.serviceIds.map(x => this.id(x)) } });
    if (found !== fields.serviceIds.length) throw new BadRequestException('Unknown service');
    const now = new Date();
    try {
      if (!id) {
        const v = { _id: new Types.ObjectId(), ...fields, revision: 1, reserved: 0, used: 0, reservations: [], createdAt: now, updatedAt: now,
          audit: [{ _id: new Types.ObjectId(), actor, at: now, before: null, after: fields }] };
        await this.vouchers.insertOne(v);
        await this.invalidate(fields.code);
        return this.publicVoucher(v);
      }
      const old: any = await this.vouchers.findOne({ _id: this.id(id) });
      if (!old) throw new BadRequestException('Voucher not found');
      if (old.code !== fields.code) throw new BadRequestException('Code is immutable; archive and create a new code');
      const updated = await this.vouchers.findOneAndUpdate({ _id: old._id, revision: old.revision, [`audit.${AUDIT_CAP - 1}`]: { $exists: false }, $expr: { $lt: [{ $bsonSize: '$$ROOT' }, 8000000] } }, {
        $set: { ...fields, updatedAt: now }, $inc: { revision: 1 },
        $push: { audit: { _id: new Types.ObjectId(), actor, at: now, before: this.publicVoucher(old), after: fields } },
      }, { returnDocument: 'after' });
      if (!updated) throw new ConflictException('Voucher changed or audit capacity reached');
      await this.invalidate(fields.code);
      return this.publicVoucher(updated);
    } catch (e: any) {
      if (e.code === 11000) throw new ConflictException('Code already exists');
      throw e;
    }
  }
  private async invalidate(code: string) { await this.redis.del(`voucher:config:${code}`, 'voucher:stats').catch(() => {}); }
  private async cached(code: string) {
    try { const hit = await this.redis.get(`voucher:config:${code}`); if (hit) return JSON.parse(hit); } catch {}
    const v = await this.vouchers.findOne({ code }, { projection: { reservations: 0, audit: 0 } });
    if (v) await this.redis.set(`voucher:config:${code}`, JSON.stringify(v), 'EX', 120).catch(() => {});
    return v;
  }
  async rateLimit(userId: string) {
    await this.ready();
    const bucket = Math.floor(Date.now() / 60000), key = `voucher:quote:${userId}:${bucket}`;
    let count: number;
    try {
      // One Lua operation: no crash window between INCR and EXPIRE.
      count = Number(await this.redis.eval("local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],120) end; return n", 1, key));
    } catch {
      try {
        const row: any = await this.limits.findOneAndUpdate({ _id: key as any }, { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((bucket + 2) * 60000) } }, { upsert: true, returnDocument: 'after' });
        count = row.count;
      } catch { throw new ServiceUnavailableException('Quote limiter unavailable'); }
      if (count > 5) throw new HttpException('Quote rate limit (database fallback)', 429);
      return;
    }
    if (count > 30) throw new HttpException('Quote rate limit', 429);
  }
  async quote(code: string | undefined, serviceId: string, subtotal: number) {
    integer(subtotal, 'subtotal', 0);
    if (!code) return { subtotal, voucher_discount: 0, total_price: subtotal, voucher: null };
    const v: any = await this.cached(normalizeCode(code));
    const amount = discount(v, subtotal, serviceId);
    return { subtotal, voucher_discount: amount, total_price: subtotal - amount,
      voucher: { _id: v._id, code: v.code, name: v.name, discountType: v.discountType, discountValue: v.discountValue, maxDiscount: v.maxDiscount, revision: v.revision } };
  }
  async existing(userId: string, key: string, dto: any) {
    await this.ready();
    const intent: any = await this.intents.findOne({ userId, key });
    if (!intent) return null;
    if (intent.fingerprint !== fingerprint({ ...dto, voucher_code: normalizeCode(dto.voucher_code) })) throw new ConflictException('Idempotency key payload mismatch');
    return this.recover(intent._id);
  }
  async purchase(userId: string, key: string, dto: any, snapshot: any, serviceName: string) {
    await this.ready();
    integer(snapshot.total_price, 'subtotal', 0); integer(snapshot.quantity, 'quantity');
    if (!key || key.length > 128 || !/^[\x21-\x7e]+$/.test(key)) throw new BadRequestException('A valid Idempotency-Key is required');
    const existing = await this.existing(userId, key, dto);
    if (existing) return existing;
    // Always read authoritative config for purchase; Redis never decides eligibility or capacity.
    const v: any = await this.vouchers.findOne({ code: normalizeCode(dto.voucher_code) }, { projection: { audit: 0 } });
    const amount = discount(v, snapshot.total_price, dto.service_id);
    const now = new Date(), intentId = new Types.ObjectId();
    const order = { ...snapshot, _id: new Types.ObjectId(), subtotal: snapshot.total_price, total_price: snapshot.total_price - amount,
      voucher_snapshot: { voucherId: v._id.toString(), code: v.code, name: v.name, discountType: v.discountType, discountValue: v.discountValue, maxDiscount: v.maxDiscount, discount: amount, revision: v.revision, intentId: intentId.toString() },
      voucher_dispatch_claimed: false, voucher_provider_confirmed_failed: false };
    order.profit = order.total_cost != null ? order.total_price - order.total_cost : null;
    const intent = { _id: intentId, userId, key, fingerprint: fingerprint({ ...dto, voucher_code: normalizeCode(dto.voucher_code) }),
      voucherId: v._id, revision: v.revision, code: v.code, serviceId: dto.service_id, serviceName, order,
      state: 'created', status: 'pending', events: [{ type: 'intent_created', at: now }], createdAt: now, updatedAt: now };
    try { await this.intents.insertOne(intent); }
    catch (e: any) { if (e.code !== 11000) throw e; return this.existing(userId, key, dto); }
    return this.recover(intentId);
  }
  private async event(id: any, state: string, type: string, extra: any = {}) {
    await this.intents.updateOne({ _id: id, state: { $ne: state } }, { $set: { state, updatedAt: new Date(), ...extra }, $push: { events: { type, at: new Date() } } });
  }
  async recover(id: any): Promise<any> {
    let i: any = await this.intents.findOne({ _id: id });
    if (!i) throw new BadRequestException('Intent missing');
    if (i.state === 'rejected') throw new BadRequestException(i.error);
    if (i.state === 'created') {
      const token = i._id.toString(), now = new Date();
      // SINGLE voucher update reserves BOTH quotas. Released tokens are retained forever,
      // so an interrupted/replayed intent cannot accidentally reserve again.
      await this.vouchers.updateOne({ _id: i.voucherId, revision: i.revision, status: 'active', startsAt: { $lte: now }, endsAt: { $gt: now },
        'reservations.token': { $ne: token }, [`reservations.${RESERVATION_CAP - 1}`]: { $exists: false },
        $expr: { $and: [ { $lt: [{ $bsonSize: '$$ROOT' }, 8000000] }, { $lt: [{ $add: ['$reserved', '$used'] }, '$totalLimit'] },
          { $lt: [{ $size: { $filter: { input: '$reservations', as: 'r', cond: { $and: [{ $eq: ['$$r.userId', i.userId] }, { $ne: ['$$r.status', 'released'] }] } } } }, '$perUserLimit'] } ] } },
        { $inc: { reserved: 1 }, $push: { reservations: { token, userId: i.userId, status: 'reserved', events: [{ type: 'reserved', at: now }] } } });
      // On rejection install a tombstone in the SAME authority document. It races
      // safely with reserve: exactly one wins and delayed retries cannot reserve later.
      await this.vouchers.updateOne({ _id: i.voucherId, 'reservations.token': { $ne: token }, [`reservations.${RESERVATION_CAP - 1}`]: { $exists: false }, $expr: { $lt: [{ $bsonSize: '$$ROOT' }, 8000000] } },
        { $push: { reservations: { token, userId: i.userId, status: 'released', events: [{ type: 'rejected', at: now }] } } });
      const reservation: any = await this.vouchers.findOne({ _id: i.voucherId, reservations: { $elemMatch: { token, status: 'reserved' } } }, { projection: { _id: 1 } });
      if (!reservation) {
        const tombstone = await this.vouchers.findOne({ _id: i.voucherId, reservations: { $elemMatch: { token, status: 'released' } } }, { projection: { _id: 1 } });
        if (tombstone) await this.intents.updateOne({ _id: id, state: 'created' }, { $set: { state: 'rejected', status: 'rejected', error: 'Voucher expired, edited, unavailable or capacity reached', updatedAt: now }, $push: { events: { type: 'reservation_rejected', at: now } } });
        throw new BadRequestException('Voucher expired, edited, unavailable or capacity reached');
      }
      await this.intents.updateOne({ _id: id, state: 'created' }, { $set: { state: 'reserved', status: 'reserved', updatedAt: now }, $push: { events: { type: 'reserved', at: now } } });
    }
    i = await this.intents.findOne({ _id: id });
    if (i.state === 'reserved') {
      const token = i._id.toString(), amount = i.order.total_price;
      // Receipt and debit share the money document. On insufficient funds record a zero
      // debit rejection receipt atomically, fencing delayed concurrent debit attempts.
      await this.users.collection.findOneAndUpdate({ _id: this.id(i.userId), 'voucher_receipts.token': { $ne: token },
        [`voucher_receipts.${RECEIPT_CAP - 1}`]: { $exists: false }, money: { $gte: amount, $lte: Number.MAX_SAFE_INTEGER }, $expr: { $and: [{ $eq: ['$money', { $trunc: '$money' }] }, { $lt: [{ $bsonSize: '$$ROOT' }, 8000000] }] } },
        [{ $set: { money: { $subtract: ['$money', amount] }, voucher_receipts: { $concatArrays: [{ $ifNull: ['$voucher_receipts', []] },
          [{ token, type: 'debit', amount, at: new Date(), balance_before: '$money', balance_after: { $subtract: ['$money', amount] } }]] } } }],
        { returnDocument: 'before' });
      let u: any = await this.users.collection.findOne({ _id: this.id(i.userId) }, { projection: { voucher_receipts: 1 } });
      let receipt = u?.voucher_receipts?.find((r: any) => r.token === token);
      if (!receipt) {
        // If admission capacity is exhausted fail closed, retain reservation for recovery.
        if (!u || (u.voucher_receipts?.length ?? 0) >= RECEIPT_CAP) throw new ServiceUnavailableException('Wallet receipt capacity reached; operator action required');
        await this.users.collection.updateOne({ _id: this.id(i.userId), 'voucher_receipts.token': { $ne: token },
          [`voucher_receipts.${RECEIPT_CAP - 1}`]: { $exists: false }, money: { $lt: amount }, $expr: { $lt: [{ $bsonSize: '$$ROOT' }, 8000000] } },
          { $push: { voucher_receipts: { token, type: 'rejected', amount: 0, at: new Date() } } } as any);
        u = await this.users.collection.findOne({ _id: this.id(i.userId) }, { projection: { voucher_receipts: 1 } });
        receipt = u?.voucher_receipts?.find((r: any) => r.token === token);
      }
      if (!receipt) throw new ServiceUnavailableException('Wallet debit pending recovery');
      if (receipt.type === 'rejected') {
        await this.release(i, 'reserved');
        await this.event(id, 'rejected', 'insufficient_funds', { status: 'released', error: 'Insufficient balance' });
        throw new BadRequestException('Insufficient balance');
      }
      await this.intents.updateOne({ _id: id }, { $set: { balance_before: receipt.balance_before, balance_after: receipt.balance_after } });
      await this.intents.updateOne({ _id: id, state: 'reserved' }, { $set: { state: 'debited', updatedAt: new Date() }, $push: { events: { type: 'debited', at: new Date() } } });
    }
    i = await this.intents.findOne({ _id: id });
    if (i.state === 'debited') {
      // Mongoose materializes/casts the frozen order; duplicate _id means successful retry.
      try { await new this.orders(i.order).save(); } catch (e: any) { if (e.code !== 11000 || !await this.orders.exists({ _id: i.order._id })) throw e; }
      await this.intents.updateOne({ _id: id, state: 'debited' }, { $set: { state: 'ordered', updatedAt: new Date() }, $push: { events: { type: 'order_inserted', at: new Date() } } });
    }
    i = await this.intents.findOne({ _id: id });
    if (i.state === 'rejected') throw new BadRequestException(i.error);
    const wallet: any = await this.users.collection.findOne({ _id: this.id(i.userId) }, { projection: { voucher_receipts: 1 } });
    const debit = wallet?.voucher_receipts?.find((r: any) => r.token === i._id.toString() && r.type === 'debit');
    if (debit) await this.ledger(i, debit);
    await this.dispatch(i);
    const o = i.order;
    return { success: true, message: 'Order accepted for processing', data: {
      order_id: o._id.toString(), order_code: o.order_code, status: o.status, service_name: i.serviceName,
      proxy_type: o.proxy_type, pricing_mode: o.pricing_mode, quantity: o.quantity, duration_days: o.duration_days,
      bandwidth_gb: o.bandwidth_gb, start_date: o.start_date, end_date: o.end_date, price_per_unit: o.price_per_unit,
      subtotal: o.subtotal, voucher_snapshot: o.voucher_snapshot, total_price: o.total_price,
      balance_before: i.balance_before ?? null, balance_after: i.balance_after ?? null, config: o.config,
    } };
  }
  private async dispatch(i: any) {
    if (i.state !== 'ordered') return;
    const o: any = await this.orders.findById(i.order._id).lean();
    if (o?.status === OS.PENDING && o.voucher_resolution === 'open' && !o.voucher_dispatch_claimed) {
      try { await this.redis.lpush('orders:pending', o._id.toString()); } catch { return; }
      await this.intents.updateOne({ _id: i._id }, { $set: { lastQueuedAt: new Date() } });
    }
  }
  async materialize(orderId: any, result: any, partnerCode: string) {
    const incoming = result?.proxies;
    if (!incoming?.length) return;
    // Fulfilment and explicit failure compete on this one-way resolution boundary.
    // Freeze the FIRST nonempty result; duplicate poll responses cannot reorder units.
    await this.orders.updateOne({ _id: orderId, voucher_resolution: 'open' }, {
      $set: { voucher_resolution: 'fulfilled', voucher_fulfilment: { result, partnerCode } },
    });
    const o: any = await this.orders.findById(orderId).select('+voucher_fulfilment').lean();
    if (o?.voucher_resolution !== 'fulfilled' || !o.voucher_fulfilment) return;
    if (![OS.PENDING, OS.PROCESSING, OS.PENDING_REFUND].includes(o.status)) { await this.settle(o); await this.recoverAffiliate(o); return; }
    const frozen = o.voucher_fulfilment;
    const docs = frozen.result.proxies.map((p: any, index: number) => {
      const hex = createHash('sha256').update(`${o._id}:voucher-proxy:${index}`).digest('hex');
      return { _id: new Types.ObjectId(hex.slice(0,24)), order_id: o._id, proxy_type_id: o.service_id,
        ip_address: p.host, port: Number(p.port), protocol: p.protocol?.toLowerCase() ?? 'http',
        auth_username: p.username, auth_password: p.password, provider_proxy_id: p.provider_proxy_id,
        provider_metadata: p.provider_metadata ?? {}, domain: p.domain ?? '', prev_ip: p.prev_ip ?? '', location: p.location ?? '',
        isp: p.isp ?? '', provider: frozen.partnerCode, country_code: p.country_code ?? 'VN', is_active: true, is_available: false,
        ...(o.config?.is_cdk ? { cdk_key: hex.slice(24,56) } : {}),
      };
    });
    for (const doc of docs) {
      // Deterministic IDs make both interrupted batches and concurrent pollers safe.
      await this.proxies.updateOne({ _id: doc._id }, { $setOnInsert: doc }, { upsert: true, runValidators: true });
    }
    const received = await this.proxies.countDocuments({ order_id: o._id });
    if (received < docs.length) throw new ServiceUnavailableException('Voucher proxy materialization incomplete');
    const status = received < o.quantity ? OS.PARTIAL : OS.ACTIVE;
    const updated = await this.orders.findOneAndUpdate({ _id: o._id, voucher_resolution: 'fulfilled', voucher_refund_plan: null, status: { $in: [OS.PENDING, OS.PROCESSING, OS.PENDING_REFUND] } }, {
      $set: { status, actual_quantity: received, provider_order_id: frozen.result.provider_order_id ?? o.provider_order_id,
        provider_metadata: frozen.result.provider_metadata ?? o.provider_metadata, error_message: '', voucher_affiliate_pending: status === OS.ACTIVE },
    }, { new: true }).lean();
    if (updated) { await this.settle(updated); await this.recoverAffiliate(updated); }
  }
  private async recoverAffiliate(order: any) {
    if (!order.voucher_affiliate_pending || order.voucher_resolution !== 'fulfilled' || !(order.actual_quantity >= order.quantity)) return;
    // Existing unique commission.order_id is the idempotency boundary. The active
    // hook creates PENDING only (no wallet credit); strict mode propagates outages.
    // Never clear the outbox flag on a swallowed/failed side effect.
    await this.affiliate.handleOrderActive(order, true);
    if (order.status === OS.EXPIRED) await this.affiliate.handleOrderExpired([order._id], true);
    await this.orders.updateOne({ _id: order._id, voucher_affiliate_pending: true }, { $set: { voucher_affiliate_pending: false } });
  }
  private async release(i: any, from: 'reserved' | 'used') {
    await this.vouchers.updateOne({ _id: i.voucherId, reservations: { $elemMatch: { token: i._id.toString(), status: from } } }, {
      $inc: { [from]: -1 }, $set: { 'reservations.$.status': 'released' }, $push: { 'reservations.$.events': { type: 'released', at: new Date() } },
    });
    await this.invalidate(i.code);
  }
  async settle(order: any) {
    const token = order.voucher_snapshot?.intentId;
    if (!token) return;
    const i: any = await this.intents.findOne({ _id: this.id(token) });
    if (!i) throw new ServiceUnavailableException('Missing voucher intent');
    if (order.voucher_resolution === 'fulfilled' && (order.actual_quantity ?? 0) > 0) {
      await this.vouchers.updateOne({ _id: i.voucherId, reservations: { $elemMatch: { token, status: 'reserved' } } }, {
        $inc: { reserved: -1, used: 1 }, $set: { 'reservations.$.status': 'used' }, $push: { 'reservations.$.events': { type: 'used', at: new Date() } },
      });
      await this.intents.updateOne({ _id: i._id, status: { $ne: 'used' } }, { $set: { status: 'used' }, $push: { events: { type: 'used', at: new Date() } } });
    }
    if (order.voucher_provider_confirmed_failed && order.refunded_amount === order.total_price && !(order.actual_quantity > 0)) {
      await this.release(i, 'reserved'); await this.release(i, 'used');
      await this.intents.updateOne({ _id: i._id, status: { $ne: 'released' } }, { $set: { status: 'released' }, $push: { events: { type: 'released', at: new Date() } } });
    }
    await this.invalidate(i.code);
  }
  async refund(order: any, amount: number | undefined, actor: string, missing = false) {
    const id = order._id, total = integer(order.total_price, 'total', 0);
    // One immutable refund plan per voucher order: retries resume the same plan; a
    // different plan is rejected rather than interpreting a retry as a second refund.
    const target = missing ? missingRefund(total, order.quantity, order.actual_quantity) : amount ?? total;
    integer(target, 'refund', 0);
    if (target > total) throw new BadRequestException('Refund exceeds net total');
    if (missing && ![OS.PARTIAL, OS.PARTIAL_REFUNDED].includes(order.status)) throw new BadRequestException('Order is not partial');
    if (!missing && (!order.voucher_provider_confirmed_failed || (order.actual_quantity ?? 0) > 0)) throw new BadRequestException('Confirm full provider failure before refunding; unknown results retain funds');
    const plan = { amount: target, actor, missing, at: new Date() };
    await this.orders.collection.updateOne({ _id: id, voucher_refund_plan: null }, { $set: { voucher_refund_plan: plan } });
    let fresh: any = await this.orders.findById(id).lean();
    const p = fresh.voucher_refund_plan;
    if (!p || p.amount !== target || p.missing !== missing) throw new ConflictException('A different refund plan already exists');
    const token = `refund:${id}`;
    await this.users.collection.updateOne({ _id: order.user_id, 'voucher_receipts.token': { $ne: token },
      [`voucher_receipts.${RECEIPT_CAP - 1}`]: { $exists: false }, money: { $gte: 0, $lte: Number.MAX_SAFE_INTEGER - target }, $expr: { $and: [{ $eq: ['$money', { $trunc: '$money' }] }, { $lt: [{ $bsonSize: '$$ROOT' }, 8000000] }] } },
      [{ $set: { money: { $add: ['$money', target] }, voucher_receipts: { $concatArrays: [{ $ifNull: ['$voucher_receipts', []] },
        [{ token, type: 'refund', amount: target, actor: p.actor, at: new Date(), balance_before: '$money', balance_after: { $add: ['$money', target] } }]] } } }]);
    const user: any = await this.users.collection.findOne({ _id: order.user_id, 'voucher_receipts.token': token });
    if (!user) throw new ServiceUnavailableException('Refund pending: wallet receipt capacity or balance overflow');
    await this.orders.updateOne({ _id: id }, { $set: { refunded_amount: target,
      status: missing ? OS.PARTIAL_REFUNDED : target === total ? OS.REFUNDED : OS.PENDING_REFUND,
      payment_status: target === total ? PaymentStatusEnum.REFUNDED : PaymentStatusEnum.PAID } });
    fresh = await this.orders.findById(id).lean();
    await this.settle(fresh);
    await this.intents.updateOne({ _id: this.id(order.voucher_snapshot.intentId), refund: { $exists: false } }, { $set: { refund: p }, $push: { events: { type: 'refund', ...p } } });
    const intent = await this.intents.findOne({ _id: this.id(order.voucher_snapshot.intentId) });
    await this.ledger(intent, user.voucher_receipts.find((r: any) => r.token === token));
    return { refunded_amount: target, balance_after: user.money, order: fresh };
  }
  private async ledger(i: any, r: any) {
    const id = new Types.ObjectId(createHash('sha256').update(`voucher-ledger:${r.token}`).digest('hex').slice(0,24));
    await this.db.collection('wallettransactions').updateOne({ _id: id }, { $setOnInsert: {
      user_id: this.id(i.userId), type: r.type === 'debit' ? 'purchase' : 'refund', amount: r.amount,
      direction: r.type === 'debit' ? 'out' : 'in', balance_before: r.balance_before, balance_after: r.balance_after,
      description: `Voucher order ${i.order.order_code}`, ref_id: i.order._id.toString(), ref_type: 'order',
      created_by: r.actor ?? 'system', createdAt: r.at, updatedAt: r.at,
    } }, { upsert: true });
  }
  async confirmFailure(id: string, actor: string, evidence: string) {
    if (typeof evidence !== 'string' || evidence.trim().length < 10 || evidence.length > 2000) throw new BadRequestException('Provider-confirmed failure evidence required (10-2000 characters)');
    const confirmation = { actor, evidence, at: new Date() };
    let o = await this.orders.findOneAndUpdate({ _id: this.id(id), voucher_snapshot: { $ne: null }, status: OS.PENDING_REFUND, voucher_resolution: 'open',
      voucher_refund_plan: null, actual_quantity: null, 'voucher_provider_result.proxies.0': { $exists: false } }, { $set: { voucher_provider_confirmed_failed: true, voucher_dispatch_claimed: true,
       voucher_resolution: 'failed', voucher_failure_confirmation: confirmation,
      admin_note: `Confirmed provider full failure by ${actor}: ${evidence}` } }, { new: true }).lean();
    if (!o) {
      o = await this.orders.findOne({ _id: this.id(id), voucher_resolution: 'failed', 'voucher_failure_confirmation.actor': actor,
        'voucher_failure_confirmation.evidence': evidence }).lean();
      if (!o) throw new ConflictException('Only unresolved voucher PENDING_REFUND orders may be confirmed');
    }
    await this.projectFailureConfirmation(o);
    return o;
  }
  private async projectFailureConfirmation(order: any) {
    const confirmation = order.voucher_failure_confirmation;
    if (order.voucher_resolution !== 'failed' || !confirmation || !order.voucher_snapshot) return;
    // The source is atomically retained on the order with the irreversible fence.
    // Projection/event share one intent update, so retries cannot duplicate the audit.
    await this.intents.updateOne({ _id: this.id(order.voucher_snapshot.intentId), failureConfirmation: { $exists: false } }, {
      $set: { failureConfirmation: confirmation }, $push: { events: { type: 'provider_failure_confirmed', ...confirmation } },
    });
  }
  @Cron('*/30 * * * * *')
  async reconcile() {
    if (this.busy) return;
    this.busy = true;
    try {
      const batch = await this.intents.find({ state: { $in: ['created', 'reserved', 'debited', 'ordered'] } }).sort({ updatedAt: 1 }).limit(100).toArray();
      for (const i of batch) {
        try {
          await this.recover(i._id);
          let order: any = await this.orders.findById(i.order._id).select('+voucher_provider_result +voucher_fulfilment +voucher_provider_result_partner').lean();
          if (order) {
            await this.projectFailureConfirmation(order);
            // Repair orders expired by the old scheduler before delivery. Neither
            // expiry nor wall-clock passage proves use or a failed provider purchase.
            if (order.status === OS.EXPIRED && order.voucher_resolution === 'open' && !(order.actual_quantity > 0)) {
              // Older settle() may already have incorrectly consumed this reservation.
              // Move used back to reserved atomically: capacity remains retained.
              await this.vouchers.updateOne({ _id: i.voucherId, reservations: { $elemMatch: { token: i._id.toString(), status: 'used' } } }, {
                $inc: { used: -1, reserved: 1 }, $set: { 'reservations.$.status': 'reserved' },
                $push: { 'reservations.$.events': { type: 'legacy_expiry_usage_reversed', at: new Date() } },
              });
              await this.intents.updateOne({ _id: i._id, status: 'used' }, { $set: { status: 'reserved' },
                $push: { events: { type: 'legacy_expiry_usage_reversed', at: new Date() } } });
              await this.orders.updateOne({ _id: order._id, status: OS.EXPIRED, voucher_resolution: 'open' }, { $set: { status: OS.PENDING_REFUND,
                error_message: 'Unfulfilled voucher order expired by legacy scheduler; provider reconciliation required' } });
              order = await this.orders.findById(order._id).select('+voucher_provider_result +voucher_fulfilment +voucher_provider_result_partner').lean();
            }
            if (order.voucher_fulfilment) await this.materialize(order._id, order.voucher_fulfilment.result, order.voucher_fulfilment.partnerCode);
            else if (order.voucher_provider_result?.proxies?.length) await this.materialize(order._id, order.voucher_provider_result, order.voucher_provider_result_partner);
            else if (order.voucher_provider_result?.provider_order_id && order.voucher_resolution === 'open' && order.status === OS.PENDING) {
              await this.orders.updateOne({ _id: order._id, status: OS.PENDING }, { $set: { status: OS.PROCESSING, provider_order_id: order.voucher_provider_result.provider_order_id } });
            }
            else if (order.voucher_dispatch_claimed && !order.voucher_provider_result && order.voucher_resolution === 'open' && order.status === OS.PENDING && +order.updatedAt < Date.now() - 600000) {
              await this.orders.updateOne({ _id: order._id, status: OS.PENDING, voucher_resolution: 'open' }, { $set: { status: OS.PENDING_REFUND,
                error_message: 'Dispatch interrupted or provider outcome unknown; reconcile with provider before refunding' } });
            }
            if (order.voucher_resolution === 'open' && order.provider_order_id && [OS.PROCESSING, OS.PENDING_REFUND].includes(order.status)) await this.redis.lpush('orders:processing', order._id.toString()).catch(() => {});
            if (order.voucher_refund_plan) await this.refund(order, order.voucher_refund_plan.amount, order.voucher_refund_plan.actor, order.voucher_refund_plan.missing);
            await this.settle(order);
            await this.recoverAffiliate(order);
          }
        } catch (e: any) { this.logger.warn(`Voucher intent ${i._id}: ${e.message}`); }
        finally { await this.intents.updateOne({ _id: i._id }, { $set: { updatedAt: new Date() } }); }
      }
    } finally { this.busy = false; }
  }
  private pagination(q: any) { return { page: Math.max(1, Math.min(100000, Number(q.page) || 1)) | 0, limit: Math.max(1, Math.min(100, Number(q.limit) || 20)) | 0 }; }
  private filters(q: any) {
    const f: any = {};
    for (const key of ['userId', 'serviceId']) if (q[key]) { this.id(q[key]); f[key] = q[key]; }
    if (q.code) f.code = normalizeCode(q.code);
    if (q.status) f.status = q.status;
    if (q.from || q.to) {
      f.createdAt = {};
      for (const [param, op] of [['from', '$gte'], ['to', '$lte']]) if (q[param]) {
        const date = new Date(q[param]); if (!Number.isFinite(+date)) throw new BadRequestException('Invalid date'); f.createdAt[op] = date;
      }
    }
    return f;
  }
  async list(q: any): Promise<any> {
    const { page, limit } = this.pagination(q), f: any = {};
    if (q.status) f.status = q.status;
    if (q.search) f.code = { $regex: String(q.search).slice(0,64).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    const [data, total] = await Promise.all([this.vouchers.find(f, { projection: { audit: 0, reservations: 0 } }).sort({ createdAt: -1 }).skip((page - 1)*limit).limit(limit).toArray(), this.vouchers.countDocuments(f)]);
    return { data, total, page, limit };
  }
  async usages(q: any): Promise<any> {
    const { page, limit } = this.pagination(q), f = this.filters(q);
    const [data, total] = await Promise.all([this.intents.find(f, { projection: { fingerprint: 0, key: 0, 'order.config': 0 } }).sort({ createdAt: -1 }).skip((page-1)*limit).limit(limit).toArray(), this.intents.countDocuments(f)]);
    return { data, total, page, limit };
  }
  async audit(q: any) {
    const { page, limit } = this.pagination(q);
    const match = q.voucherId ? { _id: this.id(q.voucherId) } : {};
    const [data, counts] = await Promise.all([
      this.vouchers.aggregate([{ $match: match }, { $unwind: '$audit' }, { $sort: { 'audit.at': -1 } }, { $skip: (page-1)*limit }, { $limit: limit }, { $project: { _id: 0, voucherId: '$_id', audit: 1 } }]).toArray(),
      this.vouchers.aggregate([{ $match: match }, { $project: { n: { $size: '$audit' } } }, { $group: { _id: null, total: { $sum: '$n' } } }]).toArray(),
    ]);
    return { data: data.map(x => ({ voucherId: x.voucherId, ...x.audit })), total: counts[0]?.total ?? 0, page, limit };
  }
  async products(search = '') {
    const escaped = String(search).slice(0,100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return this.services.find({ name: { $regex: escaped, $options: 'i' } }).select('_id name').limit(100).lean();
  }
  async stats() {
    try { const c = await this.redis.get('voucher:stats'); if (c) return JSON.parse(c); } catch {}
    const data = await this.intents.aggregate([{ $group: { _id: '$status', count: { $sum: 1 }, subtotal: { $sum: '$order.subtotal' }, discount: { $sum: '$order.voucher_snapshot.discount' }, net: { $sum: '$order.total_price' }, refunded: { $sum: '$refund.amount' } } }]).toArray();
    const result = { data, generatedAt: new Date() };
    await this.redis.set('voucher:stats', JSON.stringify(result), 'EX', 60).catch(() => {});
    return result;
  }
  async export(q: any) {
    const rows = await this.intents.find(this.filters(q)).sort({ createdAt: -1 }).limit(10001).toArray();
    if (rows.length > 10000) throw new BadRequestException('Narrow export filters to <= 10000 rows');
    const cell = (v: any) => `"${String(v ?? '').replace(/^[=+@\-\t\r]/, "'$&").replace(/"/g, '""')}"`;
    return ['id,code,userId,serviceId,status,subtotal,discount,total,refunded,createdAt', ...rows.map((i: any) => [i._id, i.code, i.userId, i.serviceId, i.status, i.order.subtotal, i.order.voucher_snapshot.discount, i.order.total_price, i.refund?.amount ?? 0, i.createdAt.toISOString()].map(cell).join(','))].join('\r\n');
  }
}
