import * as mongoose from 'mongoose';
import { ChatMessageSchema } from '../../schemas/chat-message.schema';
import { UserSchema } from '../../schemas/users.schema';
import { UserRoleEnum } from '../../enum/user.enum';
import { daysAgo, emptyResult, forceTimestamps, SeedResult } from '../lib/db';

const ChatMessage =
  mongoose.models.ChatMessageSeed ||
  mongoose.model('ChatMessageSeed', ChatMessageSchema, 'chatmessages');

const User = mongoose.models.UserSeedChat || mongoose.model('UserSeedChat', UserSchema, 'users');

type Turn = {
  from: 'user' | 'admin';
  text: string;
  type?: 'text' | 'image';
  recalled?: boolean;
};

/** 5 hội thoại — phòng cuối để lại tin user chưa đọc cho badge unread */
const CONVERSATIONS: { hoursAgo: number; unreadTail: number; turns: Turn[] }[] = [
  {
    hoursAgo: 74,
    unreadTail: 0,
    turns: [
      { from: 'user', text: 'Chào shop, proxy IPv4 private còn hàng Viettel không ạ?' },
      { from: 'admin', text: 'Chào bạn, hiện còn khoảng 40 IP Viettel nhé.' },
      { from: 'user', text: 'Mình lấy 5 cái gói 30 ngày thì bao nhiêu?' },
      { from: 'admin', text: '28.000đ/IP cho 30 ngày, 5 IP là 140.000đ bạn nhé.' },
      { from: 'user', text: 'Ok mình vừa nạp tiền rồi, đặt luôn nhé.' },
      { from: 'admin', text: 'Đơn đã kích hoạt, bạn xem trong mục Đơn hàng nha. Cảm ơn bạn!' },
    ],
  },
  {
    hoursAgo: 50,
    unreadTail: 0,
    turns: [
      { from: 'user', text: 'Anh ơi proxy em mua sáng nay không kết nối được' },
      { from: 'admin', text: 'Bạn gửi giúp mình mã đơn và ảnh chụp lỗi nhé.' },
      { from: 'user', text: 'Đây ạ', type: 'image' },
      { from: 'user', text: 'Nhầm ảnh rồi để em gửi lại', recalled: true },
      { from: 'admin', text: 'Mình thấy rồi, bạn đang điền sai cổng. Cổng đúng là 3128 nhé.' },
      { from: 'user', text: 'Đổi cổng là chạy được rồi, cảm ơn anh!' },
      { from: 'admin', text: 'Không có gì, cần gì bạn cứ nhắn nha.' },
    ],
  },
  {
    hoursAgo: 27,
    unreadTail: 0,
    turns: [
      { from: 'user', text: 'Cho mình hỏi proxy xoay tính băng thông thế nào?' },
      { from: 'admin', text: 'Gói xoay tính theo GB bạn nhé, dùng hết GB thì nạp thêm.' },
      { from: 'user', text: 'Vậy IP xoay bao lâu một lần?' },
      { from: 'admin', text: 'Mặc định 10 phút, bạn có thể chỉnh xuống 5 phút trong cấu hình đơn.' },
      { from: 'user', text: 'Hiểu rồi, mình thử gói nhỏ trước xem sao.' },
      { from: 'admin', text: 'Vâng, bạn cứ thử gói 1 ngày rồi cân đối sau nhé.' },
    ],
  },
  {
    hoursAgo: 8,
    unreadTail: 2,
    turns: [
      { from: 'user', text: 'Shop ơi mình nạp 500k mà chưa thấy vào số dư' },
      { from: 'admin', text: 'Bạn cho mình xin mã giao dịch với nội dung chuyển khoản nhé.' },
      { from: 'user', text: 'Nội dung mình ghi NAPF08CD567, chuyển lúc 14:20' },
      { from: 'user', text: 'Anh check giúp em với ạ, em đang cần mua gấp' },
    ],
  },
  {
    hoursAgo: 2,
    unreadTail: 3,
    turns: [
      { from: 'user', text: 'Cho mình hỏi có xuất hoá đơn VAT không?' },
      { from: 'user', text: 'Công ty mình cần hoá đơn để quyết toán ạ' },
      { from: 'user', text: 'Alo shop ơi' },
    ],
  },
];

export async function seedChat(): Promise<SeedResult> {
  const result = emptyResult();

  // room_id phải là _id user có thật, nếu không admin/chat/rooms trả về user: null
  const users = await User.find({ role: UserRoleEnum.USER })
    .sort({ _id: 1 })
    .limit(CONVERSATIONS.length)
    .select('_id')
    .lean()
    .exec();

  if (users.length < CONVERSATIONS.length) {
    throw new Error(
      `Cần ít nhất ${CONVERSATIONS.length} user role USER để tạo phòng chat, chỉ tìm thấy ${users.length}.`,
    );
  }

  for (let i = 0; i < CONVERSATIONS.length; i++) {
    const convo = CONVERSATIONS[i];
    const roomId = String((users[i] as any)._id);
    const start = daysAgo(convo.hoursAgo / 24);
    const unreadFrom = convo.turns.length - convo.unreadTail;

    for (let t = 0; t < convo.turns.length; t++) {
      const turn = convo.turns[t];
      // Mỗi lượt cách nhau 3 phút
      const at = new Date(start.getTime() + t * 3 * 60 * 1000);
      const content =
        turn.type === 'image' ? '/api/chat/uploads/sample-loi-ket-noi.png' : turn.text;

      // Khoá theo nội dung, KHÔNG theo createdAt: mốc thời gian tính từ
      // "bây giờ" nên mỗi lần chạy sẽ khác, dùng nó làm khoá sẽ nhân bản dữ liệu.
      const existing = await ChatMessage.findOne({
        room_id: roomId,
        sender_type: turn.from,
        content,
      })
        .select('_id')
        .lean()
        .exec();
      if (existing) {
        result.skipped++;
        continue;
      }

      const created = await ChatMessage.create({
        room_id: roomId,
        sender_type: turn.from,
        content,
        type: turn.type ?? 'text',
        recalled: turn.recalled ?? false,
        // Tin của admin luôn coi như đã đọc; tin user ở cuối hội thoại để chưa đọc
        read: turn.from === 'admin' ? true : t < unreadFrom,
      });
      await forceTimestamps(ChatMessage, { _id: created._id }, at);
      result.created++;
    }
  }

  return result;
}
