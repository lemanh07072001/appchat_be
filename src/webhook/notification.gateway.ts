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

  private sendTelegram(text: string) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
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

  sendTopupSuccess(userId: string, data: { amount: number; balance: number }) {
    const room = this.server.sockets.adapter.rooms.get(userId);
    const clientCount = room?.size ?? 0;
    this.logger.log(`Emit topup_success → userId: ${userId} | clients: ${clientCount} | amount: ${data.amount} | balance: ${data.balance}`);
    this.server.to(userId).emit('topup_success', data);
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
