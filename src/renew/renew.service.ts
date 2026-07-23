import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  RenewalSelection,
  RenewalSelectionDocument,
} from './schemas/renewal-selection.schema';
import { Proxy, ProxyDocument } from '../schemas/proxies.schema';
import { Order, OrderDocument } from '../schemas/orders.schema';
import { OrderStatusEnum } from '../enum/order.enum';
import { OrdersService } from '../orders/orders.service';
import { CreateSelectionDto } from './dto/create-selection.dto';
import { UpdateSelectionDto } from './dto/update-selection.dto';

@Injectable()
export class RenewService {
  constructor(
    @InjectModel(RenewalSelection.name)
    private readonly selectionModel: Model<RenewalSelectionDocument>,
    @InjectModel(Proxy.name)
    private readonly proxyModel: Model<ProxyDocument>,
    @InjectModel(Order.name)
    private readonly orderModel: Model<OrderDocument>,
    private readonly ordersService: OrdersService,
  ) {}

  /** Danh sách đơn + proxy có thể gia hạn */
  getRenewableOrders(userId: string) {
    return this.ordersService.getRenewableOrders(userId);
  }

  /** Tra cứu proxy theo danh sách ip:port:user:pass user dán vào */
  lookupProxies(userId: string, lines: string[]) {
    return this.ordersService.lookupProxiesByLines(userId, lines);
  }

  /**
   * Gia hạn hàng loạt + tự lưu lại lựa chọn (bản "lần trước")
   * nếu có ít nhất một đơn gia hạn thành công.
   */
  async bulkRenew(userId: string, proxyIds: string[], duration_days: number) {
    const result = await this.ordersService.bulkRenewByUser(
      userId,
      proxyIds,
      duration_days,
    );

    let selectionSaved = false;
    if (result.renewed_orders > 0) {
      try {
        await this.selectionModel.findOneAndUpdate(
          { user_id: new Types.ObjectId(userId), name: null },
          {
            $set: {
              proxy_ids: proxyIds.map((id) => new Types.ObjectId(id)),
              duration_days,
            },
          },
          { upsert: true, new: true },
        ).exec();
        selectionSaved = true;
      } catch {
        // Lưu lựa chọn là tiện ích — không được làm hỏng kết quả gia hạn
      }
    }

    return { ...result, selection_saved: selectionSaved };
  }

  /**
   * Danh sách bộ đã lưu. Mỗi bộ được "prune": bỏ proxy không còn gia hạn được
   * (đơn hết hạn/hủy, proxy đã bị xóa) và trả về số lượng đã loại.
   */
  async getSelections(userId: string) {
    const [selections, validIds] = await Promise.all([
      this.selectionModel
        .find({ user_id: new Types.ObjectId(userId) })
        .sort({ name: 1, updatedAt: -1 })
        .lean()
        .exec(),
      this.getRenewableProxyIds(userId),
    ]);

    const prune = (s: (typeof selections)[number]) => {
      const ids = (s.proxy_ids ?? []).map((id) => id.toString());
      const kept = ids.filter((id) => validIds.has(id));
      return {
        _id: s._id.toString(),
        name: s.name ?? null,
        proxy_ids: kept,
        duration_days: s.duration_days,
        pruned: ids.length - kept.length,
        auto_renew_enabled: s.auto_renew_enabled ?? false,
        threshold_days: s.threshold_days ?? 3,
        last_run_at: s.last_run_at ?? null,
        last_run_status: s.last_run_status ?? null,
        last_run_message: s.last_run_message ?? '',
        createdAt: (s as any).createdAt,
        updatedAt: (s as any).updatedAt,
      };
    };

    return {
      last: selections.filter((s) => s.name == null).map(prune)[0] ?? null,
      presets: selections.filter((s) => s.name != null).map(prune),
    };
  }

  async createSelection(userId: string, dto: CreateSelectionDto) {
    const name = dto.name.trim();
    const existing = await this.selectionModel
      .findOne({ user_id: new Types.ObjectId(userId), name })
      .lean()
      .exec();
    if (existing) {
      throw new BadRequestException(`Bộ "${name}" đã tồn tại`);
    }

    const created = await this.selectionModel.create({
      user_id: new Types.ObjectId(userId),
      name,
      proxy_ids: dto.proxy_ids.map((id) => new Types.ObjectId(id)),
      duration_days: dto.duration_days,
    });

    return this.toDto(created.toObject());
  }

  async updateSelection(userId: string, id: string, dto: UpdateSelectionDto) {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException('Id bộ lựa chọn không hợp lệ');
    }

    const update: Record<string, unknown> = {};
    if (dto.name !== undefined) update.name = dto.name.trim();
    if (dto.proxy_ids !== undefined) {
      update.proxy_ids = dto.proxy_ids.map((pid) => new Types.ObjectId(pid));
    }
    if (dto.duration_days !== undefined) update.duration_days = dto.duration_days;
    if (dto.threshold_days !== undefined) update.threshold_days = dto.threshold_days;

    if (dto.auto_renew_enabled !== undefined) {
      if (dto.auto_renew_enabled) {
        // Chỉ bộ đặt tên mới đặt lịch được — bộ "lần trước" (name = null) bị ghi đè
        // sau mỗi lần gia hạn nên không phù hợp để tự chạy.
        const current = await this.selectionModel
          .findOne({ _id: new Types.ObjectId(id), user_id: new Types.ObjectId(userId) })
          .select('name proxy_ids')
          .lean()
          .exec();
        if (!current) throw new NotFoundException('Không tìm thấy bộ lựa chọn');
        if (current.name == null) {
          throw new BadRequestException(
            'Chỉ bộ đã đặt tên mới đặt lịch tự gia hạn được — hãy lưu thành bộ trước',
          );
        }
        const willHaveProxies = dto.proxy_ids ?? current.proxy_ids ?? [];
        if (willHaveProxies.length === 0) {
          throw new BadRequestException('Bộ rỗng không thể bật lịch tự gia hạn');
        }
      }
      update.auto_renew_enabled = dto.auto_renew_enabled;
      // Bật/tắt lại thì xoá trạng thái lần chạy cũ cho khỏi gây hiểu nhầm
      update.last_run_status = null;
      update.last_run_message = '';
    }

    if (Object.keys(update).length === 0) {
      throw new BadRequestException('Không có thay đổi nào');
    }

    const updated = await this.selectionModel
      .findOneAndUpdate(
        { _id: new Types.ObjectId(id), user_id: new Types.ObjectId(userId) },
        { $set: update },
        { new: true },
      )
      .lean()
      .exec();

    if (!updated) throw new NotFoundException('Không tìm thấy bộ lựa chọn');
    return this.toDto(updated);
  }

  async deleteSelection(userId: string, id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException('Id bộ lựa chọn không hợp lệ');
    }
    const deleted = await this.selectionModel
      .findOneAndDelete({
        _id: new Types.ObjectId(id),
        user_id: new Types.ObjectId(userId),
      })
      .lean()
      .exec();
    if (!deleted) throw new NotFoundException('Không tìm thấy bộ lựa chọn');
    return { success: true };
  }

  /** Tập proxy id user hiện còn gia hạn được — dùng để prune bộ đã lưu */
  private async getRenewableProxyIds(userId: string): Promise<Set<string>> {
    const orderIds = await this.orderModel
      .find({ user_id: new Types.ObjectId(userId), status: OrderStatusEnum.ACTIVE })
      .select('_id')
      .lean()
      .exec();

    if (orderIds.length === 0) return new Set();

    const proxies = await this.proxyModel
      .find({
        order_id: { $in: orderIds.map((o) => o._id) },
        provider_proxy_id: { $exists: true, $ne: '' },
      })
      .select('_id')
      .lean()
      .exec();

    return new Set(proxies.map((p) => p._id.toString()));
  }

  private toDto(s: any) {
    return {
      _id: s._id.toString(),
      name: s.name ?? null,
      proxy_ids: (s.proxy_ids ?? []).map((id: Types.ObjectId) => id.toString()),
      duration_days: s.duration_days,
      pruned: 0,
      auto_renew_enabled: s.auto_renew_enabled ?? false,
      threshold_days: s.threshold_days ?? 3,
      last_run_at: s.last_run_at ?? null,
      last_run_status: s.last_run_status ?? null,
      last_run_message: s.last_run_message ?? '',
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    };
  }
}
