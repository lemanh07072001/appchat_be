export enum OrderStatusEnum {
  PENDING          = 0, // Khởi tạo
  PAID             = 1, // Đã thu tiền
  PROCESSING       = 2, // Đang cấp phát proxy
  ACTIVE           = 3, // Proxy đang chạy
  COMPLETED        = 4, // Hoàn thành
  EXPIRED          = 5, // Hết hạn
  CANCELLED        = 6, // Huỷ
  PARTIAL_REFUNDED = 7, // Hoàn 1 phần
  FAILED           = 8, // Lỗi khi gọi provider
  PENDING_REFUND   = 9, // Chờ hoàn tiền
}

export enum PaymentStatusEnum {
  UNPAID   = 0,
  PAID     = 1,
  REFUNDED = 2,
}

export enum PaymentMethodEnum {
  BALANCE = 'balance', // Số dư tài khoản
  BANK    = 'bank',    // Chuyển khoản ngân hàng
  MOMO    = 'momo',
  VNPAY   = 'vnpay',
}

export enum OrderItemStatusEnum {
  PENDING          = 0, // Chờ cấp phát
  ACTIVE           = 1, // Đang dùng
  EXPIRED          = 2, // Hết hạn
  CANCELLED        = 3, // Đã hủy
  PARTIAL_REFUNDED = 4, // Hoàn 1 phần
}

export enum ProxyTypeEnum {
  STATIC_IPV4   = 'static_ipv4',
  STATIC_IPV6   = 'static_ipv6',
  ROTATING_IPV4 = 'rotating_ipv4',
  ROTATING_IPV6 = 'rotating_ipv6',
  SHARED        = 'shared',
}

export enum ProxyProtocolEnum {
  HTTP   = 'http',
  HTTPS  = 'https',
  SOCKS5 = 'socks5',
}
