// ─── Input params ────────────────────────────────────────────────────────────

export interface ProviderBuyParams {
  token_api: string;         // lấy từ partner.token_api
  quantity: number;
  duration_days: number;
  country_code?: string;
  proxy_type?: string;       // static | rotating | ...
  protocol?: string;         // http | socks5 | ...
  isp?: string;
  body_api?: string;         // template body từ service config (nếu có)
  id_service?: string;       // id dịch vụ nhà cung cấp (không phải provider nào cũng cần)
  rotate_interval?: number;  // phút xoay IP (0 = không xoay / proxy tĩnh)
  is_cdk?: boolean;          // true = key xoay (gửi lên HomeProxy để phân biệt), false = proxy xoay thường
  username?: string;         // username tự chọn — nếu không có thì provider tự random
  password?: string;         // password tự chọn — nếu không có thì provider tự random
  user_id?: string;          // user của hệ thống (vd dùng để gắn customTargetName cho ProxySeller)
}

export interface ProviderRenewParams {
  token_api: string;
  provider_order_id: string; // ID order từ nhà cung cấp, lưu trong order.provider_order_id
  duration_days: number;
  provider_proxy_ids?: string[]; // ID từng proxy (dùng cho provider gia hạn theo proxy, vd: ProxyVN)
  id_service?: string;           // loaiproxy (dùng cho ProxyVN)
  provider_metadata?: Record<string, any>; // metadata lưu sẵn từ buy() (ProxySeller: lấy type ra)
}

export interface ProviderRotateParams {
  token_api: string;
  provider_order_id: string;
}

export interface ProviderCancelParams {
  token_api: string;
  provider_order_id: string;
}

// ─── Output results ───────────────────────────────────────────────────────────

export interface ProxyCredential {
  host:              string;
  port:              number;
  username:          string;
  password:          string;
  protocol:          string;
  // optional — provider-specific fields
  provider_proxy_id?: string;   // id từ provider (HomeProxy: item.id)
  domain?:            string;   // domain của proxy
  prev_ip?:           string;   // IP trước khi rotate
  location?:          string;   // location code (VD: HNI)
  isp?:               string;   // nhà mạng (VD: VIETTEL)
  country_code?:      string;
  provider_metadata?: Record<string, any>; // raw item từ provider (lưu nguyên cho debug/rotate/...)
}

export interface BuyResult {
  provider_order_id: string;   // ID để dùng cho renew / rotate / cancel sau này
  proxies: ProxyCredential[];  // danh sách proxy trả về (static: nhiều IP, rotating: 1 gateway)
  provider_metadata?: Record<string, any>; // metadata tự do persist vào order (vd: listBaseOrderNumbers)
  raw?: any;                   // raw response của provider (để debug / lưu log)
}

export interface RenewResult {
  success: boolean;
  new_end_date?: Date;
  raw?: any;
}

export interface RotateResult {
  new_host: string;
  raw?: any;
}

// ─── Năng lực của provider ───────────────────────────────────────────────────

/**
 * Những gì một provider thực sự làm được.
 *
 * `buy/renew/rotate/cancel` phải KHAI BÁO, không dò được: cả bốn đều bắt buộc
 * theo interface nên method luôn tồn tại — nhiều provider chỉ ném lỗi
 * "chưa hỗ trợ". `usage/topup` là method tuỳ chọn nên factory tự dò.
 */
export interface ProviderCapabilities {
  buy: boolean;
  renew: boolean;
  rotate: boolean;
  cancel: boolean;
  /** Đọc được lưu lượng đã dùng → dùng được cho dịch vụ bán theo GB */
  usage: boolean;
  /** Nạp thêm dung lượng vào đơn đang chạy */
  topup: boolean;
  /** Kiểm tra được API key và số dư trước khi lưu */
  check: boolean;
}

/** Kết quả kiểm tra kết nối tới nhà cung cấp. */
export interface ProviderConnectionInfo {
  /** Tài khoản nhận diện được ở phía nhà cung cấp (email / username) */
  account?: string;
  /** Số dư còn lại — ví cạn là mọi đơn mua mới fail hàng loạt */
  balance?: number;
  currency?: string;
}

// ─── Interface contract mà mọi provider phải implement ───────────────────────

export interface IProxyProvider {
  /**
   * Provider tự khai bốn năng lực bắt buộc. Thiếu thì factory coi như đủ cả
   * bốn — giữ nguyên hành vi cho provider viết trước khi có trường này.
   */
  readonly capabilities?: Pick<
    ProviderCapabilities,
    'buy' | 'renew' | 'rotate' | 'cancel'
  >;

  buy(params: ProviderBuyParams): Promise<BuyResult>;
  renew(params: ProviderRenewParams): Promise<RenewResult>;
  rotate(params: ProviderRotateParams): Promise<RotateResult>;
  cancel(params: ProviderCancelParams): Promise<void>;
  /**
   * Lấy danh sách proxy theo order ID (dành cho provider trả về proxy async).
   * `context.metadata` = `order.provider_metadata` lưu sẵn từ lúc buy() — provider có thể đọc
   * các field cần thiết để gọi API (vd ProxySeller cần country trong query string).
   */
  fetchOrderProxies?(
    token_api: string,
    provider_order_id: string,
    context?: { metadata?: Record<string, any>; protocol?: string },
  ): Promise<ProxyCredential[]>;

  /**
   * Đọc lưu lượng đã tiêu thụ của một order (dùng cho dịch vụ bán theo GB).
   *
   * TÙY CHỌN: provider nào không bán theo dung lượng thì không cần implement,
   * scheduler sẽ bỏ qua đơn của provider đó. Đây là điểm cắm duy nhất để
   * `order.bandwidth_used_gb` được cập nhật.
   */
  fetchUsage?(
    token_api: string,
    provider_order_id: string,
    context?: { metadata?: Record<string, any> },
  ): Promise<{ used_gb: number }>;

  /**
   * Nạp thêm dung lượng vào một order đang chạy (dịch vụ bán theo GB).
   *
   * TÙY CHỌN, cùng lý do với `fetchUsage`. Provider nào không implement thì
   * `OrdersService.topUpBandwidth()` từ chối ngay từ đầu — KHÔNG được cộng GB
   * vào đơn nội bộ rồi mới phát hiện bên nhà cung cấp không có, vì như vậy là
   * bán dung lượng mình chưa mua.
   *
   * KHÔNG đụng tới hạn ngày của đơn — đó là việc của `renew()`.
   */
  extendBandwidth?(
    token_api: string,
    provider_order_id: string,
    gb: number,
    context?: { metadata?: Record<string, any>; id_service?: string },
  ): Promise<{ raw?: any }>;

  /**
   * Xác thực API key và đọc số dư — gọi trước khi admin lưu nhà cung cấp.
   *
   * TÙY CHỌN: provider nào không có endpoint tương ứng thì nút "Kiểm tra kết
   * nối" tự tắt, thay vì hiện ra rồi báo lỗi khó hiểu.
   *
   * Ném lỗi khi key sai — đó chính là câu trả lời admin cần nghe ngay tại chỗ
   * thay vì đợi đơn đầu tiên của khách fail.
   */
  checkConnection?(token_api: string): Promise<ProviderConnectionInfo>;

  /**
   * Lấy lại proxy theo danh sách provider_proxy_id (idproxy) — dùng để admin
   * refresh dữ liệu (ip/user/pass) của đúng các proxy đã chọn.
   * `context.id_service` = loaiproxy (ProxyVN cần để gọi listproxy.php).
   */
  fetchProxiesByIds?(
    token_api: string,
    provider_proxy_ids: string[],
    context?: { id_service?: string; metadata?: Record<string, any> },
  ): Promise<ProxyCredential[]>;
}
