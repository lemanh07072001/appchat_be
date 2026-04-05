# FastProxy Server — API Documentation

## Authentication

### JWT (đăng nhập thường)
Dùng cho các API của user qua web/app.

```
Authorization: Bearer <jwt_token>
```

### API Token (tích hợp bên ngoài)
Dùng cho các API tích hợp third-party / programmatic.

```
Authorization: Bearer apt_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

---

## Auth Endpoints

### Đăng ký
```
POST /api/auth/register
```
Body:
```json
{
  "name": "string",
  "email": "string",
  "password": "string",
  "ref": "string (optional, referral code)"
}
```

### Đăng nhập
```
POST /api/auth/login
```
Body:
```json
{
  "email": "string",
  "password": "string"
}
```
Response:
```json
{
  "access_token": "string",
  "refresh_token": "string"
}
```

### Refresh token
```
POST /api/auth/refresh
```
Body:
```json
{
  "refresh_token": "string"
}
```

### Lấy thông tin profile
```
GET /api/auth/profile
Authorization: Bearer <jwt_token>
```

---

## API Token

### Lấy API token hiện tại
```
GET /api/auth/api-token
Authorization: Bearer <jwt_token>
```
Response:
```json
{
  "api_token": "apt_xxx"  // null nếu chưa tạo
}
```

### Tạo mới hoặc reset API token
```
POST /api/auth/api-token/generate
Authorization: Bearer <jwt_token>
```
Response:
```json
{
  "api_token": "apt_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "message": "API token đã được tạo thành công"
}
```

> Nếu đã có token → reset sang token mới. Nếu chưa có → tạo mới.

---

## Orders

### Mua proxy (JWT)
```
POST /api/orders/buy
Authorization: Bearer <jwt_token>
```

### Mua proxy (API Token — tích hợp bên ngoài)
```
POST /api/orders/buy-external
Authorization: Bearer apt_xxx
```

Body (giống nhau cho cả 2):
```json
{
  "service_id": "ObjectId",
  "duration_days": 30,
  "quantity": 1,
  "country": "Vietnam (tên hoặc ObjectId)",
  "protocol": "http | https | socks5",
  "isp": "viettel | fpt | ... (optional)",
  "proxy_type": "Datacenter | Residential | ... (optional)"
}
```

Response:
```json
{
  "success": true,
  "message": "Mua proxy thành công",
  "data": {
    "order_id": "string",
    "order_code": "string",
    "status": "pending | active | ...",
    "service_name": "string",
    "proxy_type": "string",
    "quantity": 1,
    "duration_days": 30,
    "start_date": "2026-03-11T00:00:00.000Z",
    "end_date": "2026-04-10T00:00:00.000Z",
    "price_per_unit": 50000,
    "total_price": 50000,
    "balance_before": 200000,
    "balance_after": 150000,
    "config": {}
  }
}
```

### Xem danh sách order của tôi
```
GET /api/orders/my
Authorization: Bearer <jwt_token>
```

### Xem chi tiết 1 order
```
GET /api/orders/my/:id
Authorization: Bearer <jwt_token>
```

---

## Luồng xử lý Order

### Provider sync (ProxyVN, Proxyv6...)
```
Client → POST /api/orders/buy (hoặc buy-external)
  → Trừ tiền user
  → Tạo order (PENDING)
  → Push order_id → Redis [orders:pending]
  → OrdersWorkerService BRPOP nhận ngay
  → Gọi provider.buy() → trả proxies[] luôn
  → Batch insert proxies (500/batch)
  → Order → ACTIVE
Thời gian: ~2-3s
```

### Provider async (HomeProxy)
```
Client → POST /api/orders/buy (hoặc buy-external)
  → Trừ tiền user
  → Tạo order (PENDING)
  → Push order_id → Redis [orders:pending]
  → OrdersWorkerService BRPOP nhận ngay
  → Gọi provider.buy() → trả provider_order_id (KHÔNG có proxies)
  → Order → PROCESSING
  → Push order_id → Redis [orders:processing]
  → OrdersProcessingWorkerService BRPOP nhận ngay
  → Poll provider mỗi 3s, tối đa 5 lần (15s)
    ├── Có proxy → Batch insert (500/batch) → Order → ACTIVE
    └── Hết 5 lần → Order → PENDING_REFUND + ghi admin_note
Thời gian: ~3-15s (tuỳ HomeProxy xử lý)
```

### Backup scheduler
```
OrdersScheduler         — mỗi 30 phút re-push PENDING orders bị miss vào [orders:pending]
OrdersProcessingScheduler — mỗi 5 phút re-push PROCESSING orders bị miss vào [orders:processing]
(Phòng trường hợp Redis restart hoặc server crash)
```

### Trạng thái order
| Status | Ý nghĩa |
|---|---|
| `pending` | Mới tạo, đang chờ worker xử lý |
| `processing` | Worker đã gọi provider, đang chờ proxy |
| `active` | Có proxy, đang hoạt động |
| `partial` | Nhận thiếu proxy so với số lượng đặt |
| `pending_refund` | Thất bại, chờ admin hoàn tiền |
| `failed` | Đã hoàn tiền xong |
| `expired` | Hết hạn sử dụng |
