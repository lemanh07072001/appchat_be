import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { JwtService } from '@nestjs/jwt';
import { ChatMessage, ChatMessageDocument } from '../schemas/chat-message.schema';
import { User, UserDocument } from '../schemas/users.schema';

@WebSocketGateway({ cors: { origin: '*' } })
export class NotificationGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(NotificationGateway.name);

  private sendTelegram(text: string, channel: 'default' | 'order' = 'default') {
    const token = channel === 'order'
      ? (process.env.TELEGRAM_ORDER_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN)
      : process.env.TELEGRAM_BOT_TOKEN;
    const chatId = channel === 'order'
      ? (process.env.TELEGRAM_ORDER_CHAT_ID || process.env.TELEGRAM_CHAT_ID)
      : process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;
    fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    }).catch((err) => this.logger.warn(`Telegram send failed: ${err.message}`));
  }

  @WebSocketServer()
  server: Server;

  constructor(
    @InjectModel(ChatMessage.name) private chatModel: Model<ChatMessageDocument>,
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    private jwtService: JwtService,
  ) {}

  handleConnection(client: Socket) {
    const userId = client.handshake.query.userId as string;
    this.logger.log(`Socket connected — id: ${client.id} | userId: ${userId ?? 'none'}`);
    if (userId) client.join(userId);
    try {
      const token = client.handshake.auth?.token as string;
      if (token) {
        const payload = this.jwtService.decode(token) as any;
        if (payload?.role === 0) { // UserRoleEnum.ADMIN = 0
          client.join('admin_chat');
          this.logger.log(`Admin auto-joined admin_chat — socket: ${client.id}`);
        }
      }
    } catch {}
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Socket disconnected — id: ${client.id}`);
  }

  async sendTopupSuccess(userId: string, data: { amount: number; balance: number }) {
    const room = this.server.sockets.adapter.rooms.get(userId);
    const clientCount = room?.size ?? 0;
    this.logger.log(`Emit topup_success → userId: ${userId} | clients: ${clientCount} | amount: ${data.amount} | balance: ${data.balance}`);
    this.server.to(userId).emit('topup_success', data);

    // Telegram notify
    const user = await this.userModel.findById(userId).select('email name').lean();
    const userLabel = user ? `${user.name || user.email} (${user.email})` : userId;
    this.sendTelegram(
      `💰 <b>Nạp tiền thành công</b>\n\n` +
      `👤 ${userLabel}\n` +
      `💵 Số tiền: <b>${data.amount.toLocaleString('vi-VN')}đ</b>\n` +
      `🏦 Số dư: <b>${data.balance.toLocaleString('vi-VN')}đ</b>`,
    );
  }

  async sendTopupRejected(userId: string, data: { amount: number; min: number; reason: string }) {
    this.logger.warn(`Emit topup_rejected → userId: ${userId} | amount: ${data.amount} | min: ${data.min}`);
    this.server.to(userId).emit('topup_rejected', data);

    // Telegram notify (admin biết để xử lý)
    const user = await this.userModel.findById(userId).select('email name').lean();
    const userLabel = user ? `${user.name || user.email} (${user.email})` : userId;
    this.sendTelegram(
      `⚠️ <b>Nạp tiền bị từ chối</b>\n\n` +
      `👤 ${userLabel}\n` +
      `💵 Số tiền: <b>${data.amount.toLocaleString('vi-VN')}đ</b>\n` +
      `📉 Ngưỡng tối thiểu: <b>${data.min.toLocaleString('vi-VN')}đ</b>\n` +
      `📝 ${data.reason}`,
    );
  }

  /**
   * @deprecated Dùng sendOrderActive sau khi API trả proxy thành công.
   * Giữ alias để không vỡ code cũ.
   */
  async sendOrderSuccess(userId: string, data: {
    order_code: string;
    service_name: string;
    quantity: number;
    duration_days: number;
    total_price: number;
    balance_after: number;
  }) {
    return this.sendOrderActive(userId, data);
  }

  // Helper: format thông tin user cho footer Telegram
  private async resolveUserLabel(userId: string): Promise<string> {
    const user = await this.userModel.findById(userId).select('email name').lean();
    return user ? `${user.name || user.email} (${user.email})` : userId;
  }

  // ─── Order ACTIVE: provider trả đủ proxy ─────────────────────────────
  async sendOrderActive(userId: string, data: {
    order_code:    string;
    service_name:  string;
    quantity:      number;
    duration_days: number;
    total_price:   number;
    balance_after?: number;
  }) {
    const userLabel = await this.resolveUserLabel(userId);
    const balanceLine = data.balance_after != null
      ? `🏦 Số dư còn: <b>${data.balance_after.toLocaleString('vi-VN')}đ</b>\n`
      : '';
    this.sendTelegram(
      `✅ <b>Đơn hàng giao thành công</b>\n\n` +
      `👤 ${userLabel}\n` +
      `📦 ${data.service_name}\n` +
      `🔢 Số lượng: <b>${data.quantity}</b>\n` +
      `📅 Thời hạn: ${data.duration_days} ngày\n` +
      `💵 Tổng: <b>${data.total_price.toLocaleString('vi-VN')}đ</b>\n` +
      balanceLine +
      `🆔 Mã: ${data.order_code}`,
      'order',
    );
  }

  // ─── Order PARTIAL: thiếu số lượng ───────────────────────────────────
  async sendOrderPartial(userId: string, data: {
    order_code:    string;
    service_name:  string;
    ordered:       number;
    received:      number;
    duration_days: number;
    total_price:   number;
  }) {
    const userLabel = await this.resolveUserLabel(userId);
    const shortage = data.ordered - data.received;
    const shortageAmount = data.total_price > 0 && data.ordered > 0
      ? Math.round((data.total_price / data.ordered) * shortage)
      : 0;
    this.sendTelegram(
      `⚠️ <b>Đơn hàng THIẾU số lượng</b>\n\n` +
      `👤 ${userLabel}\n` +
      `📦 ${data.service_name}\n` +
      `🔢 Đã nhận: <b>${data.received}/${data.ordered}</b> (thiếu ${shortage})\n` +
      `📅 Thời hạn: ${data.duration_days} ngày\n` +
      `💵 Tổng đơn: ${data.total_price.toLocaleString('vi-VN')}đ\n` +
      `💸 Cần hoàn: <b>${shortageAmount.toLocaleString('vi-VN')}đ</b>\n` +
      `🆔 Mã: ${data.order_code}\n\n` +
      `👉 Admin cần xử lý ở mục "Hoàn tiền số thiếu"`,
      'order',
    );
  }

  // ─── Order FAILED / PENDING_REFUND: provider lỗi ─────────────────────
  async sendOrderFailed(userId: string, data: {
    order_code:    string;
    service_name:  string;
    quantity:      number;
    duration_days: number;
    total_price:   number;
    error_message: string;
    provider_data?: any;
    stage?:        string;  // 'buy' | 'polling' | ...
  }) {
    const userLabel = await this.resolveUserLabel(userId);
    const stageLabel = data.stage === 'polling'
      ? 'Polling provider'
      : data.stage === 'buy'
      ? 'Gọi API mua'
      : 'Worker';
    // Cắt provider_data nếu quá dài để không bị Telegram cắt cụt message
    let providerSnippet = '';
    if (data.provider_data) {
      const raw = typeof data.provider_data === 'string'
        ? data.provider_data
        : JSON.stringify(data.provider_data);
      providerSnippet = raw.length > 400 ? raw.slice(0, 400) + '…' : raw;
    }
    this.sendTelegram(
      `❌ <b>Đơn hàng THẤT BẠI</b>\n\n` +
      `👤 ${userLabel}\n` +
      `📦 ${data.service_name}\n` +
      `🔢 Số lượng: ${data.quantity}\n` +
      `📅 Thời hạn: ${data.duration_days} ngày\n` +
      `💵 Tổng: ${data.total_price.toLocaleString('vi-VN')}đ\n` +
      `🆔 Mã: ${data.order_code}\n\n` +
      `🚧 Giai đoạn: ${stageLabel}\n` +
      `📝 Lỗi: <code>${(data.error_message || 'Unknown').slice(0, 500)}</code>` +
      (providerSnippet ? `\n📡 Provider trả: <code>${providerSnippet}</code>` : ''),
      'order',
    );
  }

  @SubscribeMessage('admin_join')
  handleAdminJoin(client: Socket) {
    client.join('admin_chat');
    this.logger.log(`admin_join — socket: ${client.id}`);
  }

  @SubscribeMessage('chat_send')
  async handleChatSend(client: Socket, payload: { content: string; type?: string }) {
    const userId = client.handshake.query.userId as string;
    const msgType = payload?.type === 'image' ? 'image' : 'text';
    if (!userId || !payload?.content?.trim()) return;
    const msg = await this.chatModel.create({
      room_id: userId,
      sender_type: 'user',
      content: payload.content.trim(),
      type: msgType,
    });
    const dto = { _id: msg._id, room_id: userId, sender_type: 'user', content: msg.content, type: msgType, recalled: false, createdAt: (msg as any).createdAt };
    this.server.to(userId).emit('chat_message', dto);
    this.server.to('admin_chat').emit('admin_chat_message', dto);

    // Gửi thông báo Telegram cho admin
    const user = await this.userModel.findById(userId).select('email name').lean();
    const userLabel = user ? `${user.email} (${user.name})` : userId;
    this.sendTelegram(
      `💬 <b>Tin nhắn mới từ chat</b>\n\n` +
      `👤 ${userLabel}\n` +
      `📝 ${msgType === 'image' ? '[Hình ảnh]' : msg.content}`,
    );
  }

  @SubscribeMessage('admin_chat_send')
  async handleAdminChatSend(client: Socket, payload: { room_id: string; content: string; type?: string }) {
    if (!payload?.room_id || !payload?.content?.trim()) return;
    const msgType = payload?.type === 'image' ? 'image' : 'text';
    const msg = await this.chatModel.create({
      room_id: payload.room_id,
      sender_type: 'admin',
      content: payload.content.trim(),
      type: msgType,
    });
    await this.chatModel.updateMany({ room_id: payload.room_id, sender_type: 'user', read: false }, { read: true });
    const dto = { _id: msg._id, room_id: payload.room_id, sender_type: 'admin', content: msg.content, type: msgType, recalled: false, createdAt: (msg as any).createdAt };
    this.server.to(payload.room_id).emit('chat_message', dto);
    this.server.to('admin_chat').emit('admin_chat_message', dto);
  }

  @SubscribeMessage('chat_recall')
  async handleChatRecall(client: Socket, payload: { messageId: string }) {
    const userId = client.handshake.query.userId as string;
    if (!userId || !payload?.messageId) return;
    const msg = await this.chatModel.findOneAndUpdate(
      { _id: payload.messageId, room_id: userId, sender_type: 'user' },
      { recalled: true },
      { new: true },
    );
    if (!msg) return;
    this.server.to(userId).emit('chat_recalled', { _id: msg._id, room_id: userId });
    this.server.to('admin_chat').emit('chat_recalled', { _id: msg._id, room_id: userId });
  }

  @SubscribeMessage('admin_chat_recall')
  async handleAdminChatRecall(client: Socket, payload: { messageId: string; room_id: string }) {
    if (!payload?.messageId || !payload?.room_id) return;
    const msg = await this.chatModel.findOneAndUpdate(
      { _id: payload.messageId, sender_type: 'admin' },
      { recalled: true },
      { new: true },
    );
    if (!msg) return;
    this.server.to(payload.room_id).emit('chat_recalled', { _id: msg._id, room_id: payload.room_id });
    this.server.to('admin_chat').emit('chat_recalled', { _id: msg._id, room_id: payload.room_id });
  }
}
