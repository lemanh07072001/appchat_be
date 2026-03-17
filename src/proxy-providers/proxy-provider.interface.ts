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
}

export interface ProviderRenewParams {
  token_api: string;
  provider_order_id: string; // ID order từ nhà cung cấp, lưu trong order.provider_order_id
  duration_days: number;
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
}

export interface BuyResult {
  provider_order_id: string;   // ID để dùng cho renew / rotate / cancel sau này
  proxies: ProxyCredential[];  // danh sách proxy trả về (static: nhiều IP, rotating: 1 gateway)
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

// ─── Interface contract mà mọi provider phải implement ───────────────────────

export interface IProxyProvider {
  buy(params: ProviderBuyParams): Promise<BuyResult>;
  renew(params: ProviderRenewParams): Promise<RenewResult>;
  rotate(params: ProviderRotateParams): Promise<RotateResult>;
  cancel(params: ProviderCancelParams): Promise<void>;
  /** Lấy danh sách proxy theo order ID (dành cho provider trả về proxy async) */
  fetchOrderProxies?(token_api: string, provider_order_id: string): Promise<ProxyCredential[]>;
}
