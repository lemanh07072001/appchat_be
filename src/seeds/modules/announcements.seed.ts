import * as mongoose from 'mongoose';
import { AnnouncementSchema } from '../../schemas/announcements.schema';
import { daysAgo, forceTimestamps, insertIfAbsent, SeedResult } from '../lib/db';

const Announcement =
  mongoose.models.AnnouncementSeed ||
  mongoose.model('AnnouncementSeed', AnnouncementSchema, 'announcements');

interface Seed {
  title: string;
  description: string;
  tag: 'update' | 'promotion' | 'system';
  display_type: 'default' | 'modal' | 'banner';
  is_active: boolean;
  order: number;
  daysOld: number;
}

const ITEMS: Seed[] = [
  {
    title: 'Khuyến mãi tháng 8: tặng 15% giá trị nạp từ 500.000đ',
    description:
      '<p>Từ <strong>01/08</strong> đến <strong>31/08</strong>, mọi lượt nạp từ 500.000đ được cộng thêm <strong>15%</strong> vào số dư.</p>' +
      '<ul><li>Áp dụng tự động, không cần nhập mã</li><li>Không giới hạn số lần nạp</li><li>Tiền thưởng dùng được cho mọi gói proxy</li></ul>',
    tag: 'promotion',
    display_type: 'modal',
    is_active: true,
    order: 0,
    daysOld: 4,
  },
  {
    title: 'Đã có API mua proxy tự động',
    description:
      '<p>Bạn có thể tạo đơn, kiểm tra trạng thái và gia hạn proxy hoàn toàn qua API. Lấy token trong trang hồ sơ, xem tài liệu tại mục <em>Tài liệu API</em>.</p>',
    tag: 'update',
    display_type: 'banner',
    is_active: true,
    order: 1,
    daysOld: 9,
  },
  {
    title: 'Bổ sung kho proxy IPv4 nhà mạng Viettel và FPT',
    description:
      '<p>Kho proxy tĩnh IPv4 vừa được bổ sung thêm dải mới của <strong>Viettel</strong> và <strong>FPT</strong>. Tình trạng còn hàng cập nhật trực tiếp trên trang sản phẩm.</p>',
    tag: 'update',
    display_type: 'default',
    is_active: true,
    order: 2,
    daysOld: 15,
  },
  {
    title: 'Bảo trì hệ thống định kỳ 02:00 – 04:00 ngày 12/08',
    description:
      '<p>Hệ thống bảo trì nâng cấp hạ tầng trong khung <strong>02:00 – 04:00</strong>.</p>' +
      '<p>Proxy đang hoạt động <strong>không bị gián đoạn</strong>. Trong thời gian này, thao tác mua mới và gia hạn có thể tạm ngưng.</p>',
    tag: 'system',
    display_type: 'banner',
    is_active: true,
    order: 3,
    daysOld: 2,
  },
  {
    title: 'Cập nhật chính sách hoàn tiền đơn hàng lỗi',
    description:
      '<p>Đơn không được cấp đủ số lượng sẽ được <strong>hoàn tự động</strong> phần thiếu vào số dư trong vòng 24 giờ, thay vì phải liên hệ hỗ trợ như trước.</p>',
    tag: 'system',
    display_type: 'default',
    is_active: true,
    order: 4,
    daysOld: 21,
  },
  {
    title: 'Khuyến mãi Tết 2026 (đã kết thúc)',
    description:
      '<p>Chương trình khuyến mãi Tết đã kết thúc ngày 28/02/2026. Cảm ơn quý khách đã đồng hành.</p>',
    tag: 'promotion',
    display_type: 'modal',
    is_active: false,
    order: 5,
    daysOld: 160,
  },
];

export async function seedAnnouncements(): Promise<SeedResult> {
  const docs = ITEMS.map((a) => ({
    title: a.title,
    description: a.description,
    image: '',
    tag: a.tag,
    display_type: a.display_type,
    is_active: a.is_active,
    order: a.order,
  }));

  const result = await insertIfAbsent(Announcement, docs, (d) => ({ title: d.title }));

  for (const a of ITEMS) {
    await forceTimestamps(Announcement, { title: a.title }, daysAgo(a.daysOld));
  }

  return result;
}
