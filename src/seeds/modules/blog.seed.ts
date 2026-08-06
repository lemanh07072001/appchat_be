import * as mongoose from 'mongoose';
import { BlogPostSchema } from '../../schemas/blog-post.schema';
import { daysAgo, forceTimestamps, insertIfAbsent, SeedResult } from '../lib/db';

const BlogPost =
  mongoose.models.BlogPostSeed ||
  mongoose.model('BlogPostSeed', BlogPostSchema, 'blogposts');

const CTA = {
  cta_text: 'Cần proxy tốc độ cao, IP sạch, kích hoạt tức thì?',
  cta_button_text: 'Xem bảng giá proxy',
  cta_link: '/vi/proxy-ipv4-private',
};

function body(sections: [string, string][]): string {
  return sections
    .map(([h, p]) => `<h2>${h}</h2>\n<p>${p}</p>`)
    .join('\n');
}

interface Seed {
  title: string;
  slug: string;
  excerpt: string;
  sections: [string, string][];
  category: string;
  tags: string[];
  status: 'draft' | 'published';
  is_featured?: boolean;
  views: number;
  daysOld: number;
}

const POSTS: Seed[] = [
  {
    title: 'Proxy là gì? Giải thích dễ hiểu cho người mới bắt đầu',
    slug: 'proxy-la-gi-cho-nguoi-moi-bat-dau',
    excerpt:
      'Proxy đứng giữa bạn và Internet, nhận yêu cầu rồi đi lấy dữ liệu thay bạn. Bài viết giải thích cơ chế, các loại proxy phổ biến và khi nào bạn thực sự cần dùng.',
    category: 'kien-thuc',
    tags: ['proxy', 'cơ bản', 'người mới'],
    status: 'published',
    is_featured: true,
    views: 4180,
    daysOld: 62,
    sections: [
      [
        'Proxy hoạt động như thế nào?',
        'Khi bạn truy cập một website qua proxy, yêu cầu của bạn được gửi tới máy chủ proxy trước. Proxy dùng địa chỉ IP của nó để lấy dữ liệu về rồi trả lại cho bạn. Website phía bên kia chỉ nhìn thấy IP của proxy, không thấy IP thật của bạn.',
      ],
      [
        'Các loại proxy phổ biến',
        'Proxy tĩnh (static) giữ nguyên một IP trong suốt thời gian thuê, phù hợp với tài khoản cần ổn định. Proxy xoay (rotating) tự đổi IP theo chu kỳ hoặc theo mỗi request, hợp với thu thập dữ liệu. Ngoài ra còn phân biệt theo giao thức HTTP và SOCKS5.',
      ],
      [
        'Proxy khác VPN ở điểm nào?',
        'VPN mã hoá toàn bộ lưu lượng ở mức hệ điều hành và định tuyến mọi ứng dụng qua một đường hầm. Proxy chỉ tác động tới ứng dụng nào được cấu hình dùng nó. Đổi lại, proxy nhẹ hơn, nhanh hơn và cho phép chạy hàng chục IP song song trên cùng một máy.',
      ],
      [
        'Khi nào bạn cần proxy?',
        'Quản lý nhiều tài khoản mạng xã hội, kiểm thử quảng cáo theo vùng, thu thập dữ liệu giá, kiểm tra SEO đa vị trí, hoặc đơn giản là truy cập nội dung bị giới hạn theo quốc gia.',
      ],
    ],
  },
  {
    title: 'So sánh proxy IPv4 và IPv6: nên chọn loại nào?',
    slug: 'so-sanh-proxy-ipv4-va-ipv6',
    excerpt:
      'IPv6 rẻ hơn nhiều lần nhưng không phải website nào cũng hỗ trợ. Bảng so sánh chi tiết giúp bạn chọn đúng loại cho từng nhu cầu.',
    category: 'kien-thuc',
    tags: ['ipv4', 'ipv6', 'so sánh'],
    status: 'published',
    is_featured: true,
    views: 3260,
    daysOld: 55,
    sections: [
      [
        'Khác biệt cốt lõi',
        'IPv4 dùng địa chỉ 32 bit và đã cạn kiệt từ lâu, nên giá thuê cao. IPv6 dùng 128 bit, nguồn cung gần như vô hạn, giá chỉ bằng một phần nhỏ so với IPv4.',
      ],
      [
        'Vấn đề tương thích',
        'Đây là điểm quyết định. Nhiều dịch vụ lớn vẫn chưa hỗ trợ IPv6 đầy đủ, hoặc đối xử khắt khe hơn với dải IPv6. Nếu mục tiêu của bạn là các nền tảng đó, IPv4 vẫn là lựa chọn an toàn.',
      ],
      [
        'Chi phí thực tế',
        'Với cùng ngân sách, bạn có thể mua số lượng IPv6 lớn hơn nhiều lần. Điều này rất hợp với các tác vụ cần nhiều IP nhưng không đòi hỏi độ tin cậy tuyệt đối trên từng IP.',
      ],
      [
        'Gợi ý chọn',
        'Cần độ ổn định và tương thích rộng: chọn IPv4 private. Cần số lượng lớn, chi phí thấp, đích đến đã xác nhận hỗ trợ IPv6: chọn IPv6. Không chắc chắn: bắt đầu với gói IPv4 một ngày để thử.',
      ],
    ],
  },
  {
    title: 'Hướng dẫn cấu hình proxy trên Chrome, Firefox và Windows',
    slug: 'huong-dan-cau-hinh-proxy-chrome-firefox-windows',
    excerpt:
      'Ba cách cấu hình proxy phổ biến nhất, kèm mẹo tách riêng proxy cho từng trình duyệt mà không ảnh hưởng toàn hệ thống.',
    category: 'huong-dan',
    tags: ['hướng dẫn', 'chrome', 'firefox', 'windows'],
    status: 'published',
    views: 2870,
    daysOld: 48,
    sections: [
      [
        'Cấu hình ở mức hệ thống trên Windows',
        'Mở Settings, vào Network & Internet rồi chọn Proxy. Bật Use a proxy server, điền địa chỉ IP và cổng được cấp, lưu lại. Mọi ứng dụng tôn trọng cấu hình hệ thống sẽ đi qua proxy này.',
      ],
      [
        'Firefox: proxy riêng cho trình duyệt',
        'Firefox có cấu hình proxy độc lập với hệ thống. Vào Settings, tìm Network Settings, chọn Manual proxy configuration. Đây là cách gọn nhất khi bạn chỉ muốn một trình duyệt đi qua proxy.',
      ],
      [
        'Chrome và các trình duyệt Chromium',
        'Chrome dùng chung cấu hình với hệ thống. Muốn tách riêng, hãy khởi chạy Chrome kèm tham số dòng lệnh chỉ định máy chủ proxy, hoặc dùng một extension quản lý proxy.',
      ],
      [
        'Proxy có xác thực user/password',
        'Với proxy yêu cầu đăng nhập, trình duyệt sẽ hiện hộp thoại nhập tài khoản ở lần kết nối đầu tiên. Nếu công cụ của bạn không hỗ trợ hộp thoại này, hãy dùng định dạng chuỗi kết nối có kèm thông tin xác thực.',
      ],
    ],
  },
  {
    title: 'Proxy xoay là gì và khi nào nên dùng thay cho proxy tĩnh?',
    slug: 'proxy-xoay-la-gi-khi-nao-nen-dung',
    excerpt:
      'Proxy xoay đổi IP tự động theo chu kỳ. Bài viết phân tích đúng trường hợp nên dùng và các sai lầm khiến bạn tốn tiền vô ích.',
    category: 'kien-thuc',
    tags: ['proxy xoay', 'rotating', 'scraping'],
    status: 'published',
    views: 2410,
    daysOld: 41,
    sections: [
      [
        'Cơ chế xoay IP',
        'Bạn kết nối tới một cổng gateway cố định. Phía sau cổng đó, hệ thống luân chuyển qua một tập IP lớn. Có hai kiểu: xoay theo thời gian (ví dụ mỗi 5 hoặc 10 phút) và xoay theo từng request.',
      ],
      [
        'Trường hợp nên dùng proxy xoay',
        'Thu thập dữ liệu số lượng lớn, kiểm tra thứ hạng từ khoá ở nhiều vị trí, giám sát giá đối thủ. Điểm chung là mỗi request độc lập, không cần giữ phiên đăng nhập.',
      ],
      [
        'Trường hợp KHÔNG nên dùng',
        'Quản lý tài khoản đăng nhập là ví dụ điển hình. IP thay đổi liên tục giữa các request khiến hệ thống bảo mật của nền tảng đánh dấu phiên là bất thường. Trường hợp này bắt buộc dùng proxy tĩnh riêng cho mỗi tài khoản.',
      ],
      [
        'Tính chi phí theo băng thông',
        'Proxy xoay thường tính theo GB. Trước khi mua gói lớn, hãy chạy thử một tác vụ nhỏ và đo lượng băng thông thực tế, rồi nhân lên theo quy mô dự định.',
      ],
    ],
  },
  {
    title: '5 lý do proxy của bạn bị chặn và cách khắc phục',
    slug: '5-ly-do-proxy-bi-chan-va-cach-khac-phuc',
    excerpt:
      'Từ IP bẩn tới dấu vết trình duyệt, đây là những nguyên nhân thường gặp nhất khiến proxy vừa mua đã bị chặn.',
    category: 'huong-dan',
    tags: ['troubleshooting', 'bị chặn', 'ip sạch'],
    status: 'published',
    views: 1980,
    daysOld: 34,
    sections: [
      [
        'IP đã có lịch sử xấu',
        'IP tái sử dụng có thể mang theo lịch sử vi phạm từ người dùng trước. Hãy kiểm tra IP qua các công cụ tra cứu danh sách đen trước khi đưa vào việc quan trọng.',
      ],
      [
        'Dấu vết trình duyệt không khớp vị trí IP',
        'IP ở Nhật nhưng múi giờ máy là UTC+7, ngôn ngữ là tiếng Việt — sự bất nhất này bị phát hiện dễ dàng. Dùng trình duyệt chống phát hiện và đồng bộ múi giờ, ngôn ngữ với vị trí IP.',
      ],
      [
        'Rò rỉ WebRTC làm lộ IP thật',
        'WebRTC có thể tiết lộ địa chỉ IP thật ngay cả khi bạn đang dùng proxy. Tắt WebRTC hoặc dùng extension chặn rò rỉ.',
      ],
      [
        'Tần suất request quá cao',
        'Gửi hàng trăm request mỗi giây từ một IP là tín hiệu tự động rõ ràng. Thêm độ trễ ngẫu nhiên và giới hạn tốc độ cho từng IP.',
      ],
      [
        'Dùng sai loại proxy',
        'Proxy datacenter dễ bị nhận diện hơn proxy dân cư. Với các nền tảng khắt khe, hãy chọn proxy dân cư hoặc proxy nhà mạng Việt Nam.',
      ],
    ],
  },
  {
    title: 'Chọn proxy cho MMO: kinh nghiệm nuôi tài khoản không bị khoá',
    slug: 'chon-proxy-cho-mmo-nuoi-tai-khoan',
    excerpt:
      'Nguyên tắc một tài khoản một IP, cách phân bổ proxy theo nhóm tài khoản và lịch trình làm ấm tài khoản mới.',
    category: 'huong-dan',
    tags: ['mmo', 'nuôi tài khoản', 'proxy tĩnh'],
    status: 'published',
    views: 1650,
    daysOld: 27,
    sections: [
      [
        'Nguyên tắc một tài khoản một IP',
        'Đây là quy tắc quan trọng nhất. Hai tài khoản dùng chung IP sẽ bị liên kết với nhau; một tài khoản bị khoá thường kéo theo phần còn lại.',
      ],
      [
        'Chọn proxy tĩnh, không dùng proxy xoay',
        'Tài khoản cần một IP ổn định lâu dài. IP đổi liên tục làm nền tảng yêu cầu xác minh lại và tăng rủi ro khoá.',
      ],
      [
        'Làm ấm tài khoản mới',
        'Tuần đầu chỉ đăng nhập, xem nội dung, tương tác nhẹ. Tăng dần cường độ hoạt động qua các tuần tiếp theo thay vì hoạt động mạnh ngay từ ngày đầu.',
      ],
      [
        'Ưu tiên proxy cùng quốc gia với tài khoản',
        'Tài khoản đăng ký ở Việt Nam nên dùng IP Việt Nam. Đăng nhập từ IP nước ngoài ngay sau khi đăng ký là tín hiệu bất thường rõ rệt.',
      ],
    ],
  },
  {
    title: 'HTTP hay SOCKS5: chọn giao thức proxy nào?',
    slug: 'http-hay-socks5-chon-giao-thuc-nao',
    excerpt:
      'SOCKS5 hoạt động ở tầng thấp hơn và hỗ trợ mọi loại lưu lượng. Nhưng không phải lúc nào cũng là lựa chọn tốt hơn.',
    category: 'kien-thuc',
    tags: ['http', 'socks5', 'giao thức'],
    status: 'published',
    views: 1420,
    daysOld: 22,
    sections: [
      [
        'HTTP proxy',
        'Hiểu được nội dung giao thức HTTP nên có thể lọc, cache và ghi log ở mức đường dẫn. Phù hợp khi bạn chỉ duyệt web hoặc gọi API HTTP.',
      ],
      [
        'SOCKS5 proxy',
        'Hoạt động ở tầng thấp hơn, chỉ chuyển tiếp gói tin mà không quan tâm nội dung. Nhờ vậy chuyển được mọi loại lưu lượng: HTTP, FTP, email, torrent, kết nối game.',
      ],
      [
        'Hiệu năng',
        'Khác biệt về tốc độ trong thực tế là không đáng kể. Yếu tố ảnh hưởng lớn hơn nhiều là vị trí địa lý của proxy và chất lượng đường truyền của nhà cung cấp.',
      ],
      [
        'Chọn thế nào',
        'Chỉ duyệt web và gọi API: HTTP là đủ. Cần chạy ứng dụng ngoài trình duyệt hoặc công cụ tự động hoá đa dạng: chọn SOCKS5. Các gói tại FastProxyVN đều hỗ trợ cả hai.',
      ],
    ],
  },
  {
    title: 'Cách kiểm tra chất lượng proxy trước khi đưa vào sử dụng',
    slug: 'cach-kiem-tra-chat-luong-proxy',
    excerpt:
      'Bốn phép kiểm tra nhanh: IP có đúng như quảng cáo không, độ trễ bao nhiêu, có bị liệt kê danh sách đen, và có rò rỉ thông tin không.',
    category: 'huong-dan',
    tags: ['kiểm tra', 'chất lượng', 'checklist'],
    status: 'published',
    views: 1180,
    daysOld: 16,
    sections: [
      [
        'Kiểm tra IP và vị trí thực tế',
        'Truy cập một trang tra cứu IP qua proxy. Đối chiếu IP hiển thị, quốc gia và nhà mạng với thông tin nhà cung cấp đưa ra. Sai lệch quốc gia là dấu hiệu cần đổi ngay.',
      ],
      [
        'Đo độ trễ',
        'Ping tới đích bạn thường truy cập. Proxy trong nước thường dưới 50ms; proxy quốc tế 150–250ms là chấp nhận được. Vượt quá mức này sẽ ảnh hưởng rõ tới công việc.',
      ],
      [
        'Tra danh sách đen',
        'Dùng công cụ kiểm tra danh sách đen để xem IP có bị đánh dấu spam hay không. IP nằm trong danh sách đen sẽ bị chặn ở nhiều nơi trước cả khi bạn kịp dùng.',
      ],
      [
        'Kiểm tra rò rỉ DNS và WebRTC',
        'Có trang kiểm tra chuyên dụng cho việc này. Nếu kết quả hiện IP thật của bạn, cấu hình đang có lỗ hổng và cần khắc phục trước khi dùng cho việc quan trọng.',
      ],
    ],
  },
  {
    title: 'FastProxyVN ra mắt API mua proxy tự động',
    slug: 'fastproxyvn-ra-mat-api-mua-proxy-tu-dong',
    excerpt:
      'Từ nay bạn có thể tạo đơn, kiểm tra trạng thái và gia hạn proxy hoàn toàn qua API, không cần thao tác trên giao diện web.',
    category: 'tin-tuc',
    tags: ['api', 'tính năng mới', 'tự động hoá'],
    status: 'published',
    views: 940,
    daysOld: 9,
    sections: [
      [
        'Những gì API hỗ trợ',
        'Tạo đơn hàng, tra cứu danh sách proxy đang hoạt động, kiểm tra hạn sử dụng, gia hạn đơn, và xem số dư tài khoản. Toàn bộ đều trả về JSON.',
      ],
      [
        'Lấy API token',
        'Vào trang hồ sơ trong tài khoản của bạn, mục API token, nhấn tạo mới. Token này tương đương mật khẩu — không chia sẻ và không đưa vào mã nguồn công khai.',
      ],
      [
        'Giới hạn tần suất',
        'Mỗi token được giới hạn số request theo phút để bảo vệ hệ thống. Vượt ngưỡng, API trả về mã lỗi tương ứng; hãy thêm cơ chế thử lại có độ trễ tăng dần.',
      ],
      [
        'Tài liệu chi tiết',
        'Xem đầy đủ các endpoint, tham số và ví dụ mã nguồn tại trang tài liệu API trong khu vực đăng nhập.',
      ],
    ],
  },
  {
    title: 'Bảng giá proxy 2026 và cách tối ưu chi phí',
    slug: 'bang-gia-proxy-2026-toi-uu-chi-phi',
    excerpt:
      'Bài viết đang được biên tập — cập nhật bảng giá mới và các mẹo giảm chi phí khi thuê số lượng lớn.',
    category: 'tin-tuc',
    tags: ['bảng giá', 'chi phí'],
    status: 'draft',
    views: 0,
    daysOld: 5,
    sections: [
      [
        'Cấu trúc giá theo thời hạn',
        'Giá theo ngày linh hoạt nhất nhưng đắt nhất tính trên mỗi ngày. Gói 30 ngày thường rẻ hơn đáng kể so với mua lẻ từng ngày.',
      ],
      [
        'Chiết khấu theo số lượng',
        'Nội dung đang hoàn thiện.',
      ],
    ],
  },
  {
    title: 'Proxy dân cư và proxy datacenter khác nhau ra sao?',
    slug: 'proxy-dan-cu-va-proxy-datacenter',
    excerpt:
      'Bản nháp — phân tích nguồn gốc IP, mức độ tin cậy và chênh lệch giá giữa hai loại.',
    category: 'kien-thuc',
    tags: ['residential', 'datacenter'],
    status: 'draft',
    views: 0,
    daysOld: 3,
    sections: [
      [
        'Nguồn gốc địa chỉ IP',
        'Proxy dân cư dùng IP do nhà mạng cấp cho hộ gia đình. Proxy datacenter dùng IP thuộc trung tâm dữ liệu.',
      ],
      [
        'Mức độ bị nhận diện',
        'Nội dung đang hoàn thiện.',
      ],
    ],
  },
  {
    title: 'Checklist bảo mật khi dùng proxy cho doanh nghiệp',
    slug: 'checklist-bao-mat-khi-dung-proxy-doanh-nghiep',
    excerpt:
      'Bản nháp nội bộ — danh sách kiểm tra bảo mật trước khi triển khai proxy ở quy mô đội nhóm.',
    category: 'huong-dan',
    tags: ['bảo mật', 'doanh nghiệp'],
    status: 'draft',
    views: 0,
    daysOld: 1,
    sections: [
      [
        'Quản lý thông tin xác thực',
        'Không dùng chung một tài khoản proxy cho cả đội. Cấp riêng và thu hồi được khi nhân sự rời dự án.',
      ],
      [
        'Ghi log và giám sát',
        'Nội dung đang hoàn thiện.',
      ],
    ],
  },
];

export async function seedBlog(): Promise<SeedResult> {
  const docs = POSTS.map((p) => ({
    title: p.title,
    slug: p.slug,
    excerpt: p.excerpt,
    content: body(p.sections),
    thumbnail: `/images/blog/${p.slug}.jpg`,
    status: p.status,
    tags: p.tags,
    meta_title: `${p.title} | FastProxyVN`,
    meta_description: p.excerpt.slice(0, 155),
    views: p.views,
    author: 'FastProxyVN',
    category: p.category,
    is_featured: p.is_featured ?? false,
    toc_enabled: true,
    ...(p.status === 'published' ? CTA : { cta_text: '', cta_button_text: '', cta_link: '' }),
  }));

  const result = await insertIfAbsent(BlogPost, docs, (d) => ({ slug: d.slug }));

  // Dàn ngày đăng theo daysOld để danh sách blog không dồn cùng một mốc
  for (const p of POSTS) {
    const at = daysAgo(p.daysOld);
    await forceTimestamps(BlogPost, { slug: p.slug }, at);
  }

  return result;
}
