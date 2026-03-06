# Hệ thống Affiliate

## Tổng quan

Hệ thống affiliate 1 cấp — người dùng chia sẻ link, khi người được giới thiệu mua proxy thành công (order → ACTIVE), người giới thiệu nhận hoa hồng vào `affiliate_balance`.

---

## Cấu trúc Database

### Thêm vào collection `users`

| Field               | Type      | Mô tả                                          |
|---------------------|-----------|------------------------------------------------|
| `referral_code`     | string    | Code duy nhất để chia sẻ link (sparse unique)  |
| `referred_by`       | ObjectId  | `_id` của người đã giới thiệu user này         |
| `affiliate_balance` | number    | Số dư hoa hồng (tách biệt với `money`)         |

### Collection `affiliatecommissions`

| Field               | Type      | Mô tả                                          |
|---------------------|-----------|------------------------------------------------|
| `referrer_id`       | ObjectId  | Người nhận hoa hồng                            |
| `referred_user_id`  | ObjectId  | Người mua hàng                                 |
| `order_id`          | ObjectId  | Đơn hàng phát sinh — **unique index**          |
| `order_total`       | number    | `total_price` của đơn tại thời điểm tạo        |
| `commission_rate`   | number    | % hoa hồng tại thời điểm tạo                  |
| `commission_amount` | number    | `order_total × commission_rate / 100`          |
| `status`            | string    | `confirmed` → `paid` hoặc `cancelled`          |
| `confirmed_at`      | Date      | Thời điểm order ACTIVE                         |
| `paid_at`           | Date      | Thời điểm cộng vào `affiliate_balance`         |

**Index:**
- `order_id`: unique → đảm bảo mỗi đơn chỉ tạo 1 commission (idempotent)
- `{ referrer_id, status }`: compound → query danh sách hoa hồng nhanh
- `referred_user_id`: → tra cứu lịch sử theo người mua

### Collection `affiliateconfigs`

| Field             | Type    | Default | Mô tả                       |
|-------------------|---------|---------|-----------------------------|
| `commission_rate` | number  | 5       | % hoa hồng trên total_price |
| `is_active`       | boolean | true    | Bật/tắt toàn hệ thống       |

> Chỉ có **1 document** duy nhất trong collection này. Tự tạo với giá trị mặc định nếu chưa có.

---

## Luồng hoạt động

### 1. Đăng ký qua link affiliate

```
GET /register?ref=REF_abc123xy
         │
         ▼
auth.service → sau khi tạo user thành công
         │
         ▼
affiliateService.applyReferralCode(newUserId, "REF_abc123xy")
         │
         ├─ Tìm user có referral_code = "REF_abc123xy"
         ├─ Kiểm tra không tự giới thiệu chính mình
         └─ Set user.referred_by = referrer._id
```

### 2. Mua proxy — con đường ProxyVN (proxy trả ngay)

```
orders.worker.service
         │
         ├─ buy() từ provider → nhận proxy list
         ├─ insertMany proxies
         ├─ order.status = ACTIVE → order.save()
         │
         └─▶ affiliateService.handleOrderActive(order)   ← trigger
```

### 3. Mua proxy — con đường HomeProxy (proxy trả bất đồng bộ)

```
orders.worker.service
         ├─ buy() → order.status = PROCESSING → chờ
         │
orders-processing.scheduler  (cron mỗi 60 giây)
         ├─ poll HomeProxy API → nhận proxy
         ├─ insertMany proxies
         ├─ findByIdAndUpdate → status = ACTIVE
         │
         └─▶ affiliateService.handleOrderActive(order)   ← trigger
```

### 4. Bên trong `handleOrderActive`

```
Kiểm tra config.is_active
    └─ false → return (hệ thống tắt)

Tìm buyer = users.findById(order.user_id).select("referred_by")
    └─ buyer.referred_by = null → return (không được giới thiệu)

Tính commission_amount = order.total_price × commission_rate / 100

commissionModel.save({ status: "pending" })   ← chỉ ghi nhận, CHƯA cộng tiền
    └─ E11000 duplicate key → return (idempotent)
```

**Lưu ý:** `handleOrderActive` được gọi với `void` → không block luồng chính.

### 5. Khi order hết hạn (EXPIRED)

```
orders-expiration.scheduler  (cron mỗi 5 phút)
         │
         ├─ orderModel.updateMany → status = EXPIRED
         ├─ proxyModel.updateMany → is_active = false
         │
         └─▶ affiliateService.handleOrderExpired(orderIds)
                   │
                   └─ commissionModel.updateMany
                        { order_id: $in orderIds, status: "pending" }
                        → status: "confirmed", confirmed_at: now
```

### 6. Admin credit thủ công → affiliate_balance

```
POST /admin/affiliate/credit/:userId
         │
         ▼
Tìm tất cả commission { referrer_id, status: "confirmed" }
         │
         ├─ Tính tổng commission_amount
         ├─ userModel.$inc { affiliate_balance: +total }
         └─ commissionModel.updateMany → status: "paid", paid_at: now
```

### 7. Transfer hoa hồng → balance chính

```
POST /api/affiliate/transfer
         │
         ▼
findOneAndUpdate — MongoDB aggregation pipeline (atomic):
    { affiliate_balance > 0 }
    [{ $set: {
        money:             money + affiliate_balance,
        affiliate_balance: 0
    }}]
```

---

## Commission Status Flow

```
  order → ACTIVE
       │
       ▼
   PENDING  ──── order đang chạy, chỉ hiển thị số tiền
       │
       │  order → EXPIRED (tự động qua scheduler 5 phút)
       ▼
  CONFIRMED ──── đủ điều kiện, user có thể yêu cầu rút
       │
       │  user bấm "Yêu cầu rút"  POST /api/affiliate/withdraw/:commissionId
       ▼
  REQUESTED ──── chờ admin duyệt
       │
       ├──── admin từ chối  POST /admin/affiliate/reject/:commissionId
       │              └──▶ CONFIRMED  (quay lại, user rút lại sau)
       │
       │  admin duyệt  POST /admin/affiliate/approve/:commissionId
       ▼
    PAID    ──── đã cộng vào affiliate_balance ✅

  (PENDING hoặc CONFIRMED) ──── order bị cancel ────▶ CANCELLED
```

| Status      | Ý nghĩa                                                        |
|-------------|----------------------------------------------------------------|
| `pending`   | Order đang ACTIVE, ghi nhận hoa hồng, chưa thể rút            |
| `confirmed` | Order đã EXPIRED, user có thể gửi yêu cầu rút                 |
| `requested` | User đã gửi yêu cầu, đang chờ admin duyệt                     |
| `paid`      | Admin đã duyệt, đã cộng vào `affiliate_balance`                |
| `cancelled` | Đơn hàng bị huỷ                                               |

---

## API

---

### GET `/api/affiliate/get-link` `[User]`

Lấy link affiliate. Nếu chưa có `referral_code` thì tự động tạo mới.

**Request:** không có body, lấy userId từ JWT token.

**Response `200`:**
```json
{
  "id": "6650a1b2c3d4e5f6a7b8c9d0",
  "code": "REF_abc123xy",
  "link": "/register?ref=REF_abc123xy",
  "commission_rate": 5
}
```

| Field             | Type   | Mô tả                              |
|-------------------|--------|------------------------------------|
| `id`              | string | ObjectId của user hiện tại         |
| `code`            | string | Referral code để chia sẻ           |
| `link`            | string | Link đầy đủ để gửi cho người khác  |
| `commission_rate` | number | % hoa hồng hiện tại (từ config)    |

---

### GET `/api/affiliate/stats` `[User]`

Thống kê tổng quan hoa hồng của user.

**Request:** không có body.

**Response `200`:**
```json
{
  "referral_code": "REF_abc123xy",
  "affiliate_balance": 150000,
  "total_referred": 12,
  "total_orders": 8,
  "total_earned": 350000,
  "pending_balance": 50000
}
```

| Field               | Type   | Mô tả                                                  |
|---------------------|--------|--------------------------------------------------------|
| `referral_code`     | string | Code của user (rỗng nếu chưa tạo link)                 |
| `affiliate_balance` | number | Số dư hoa hồng đã được admin credit, chưa transfer     |
| `total_referred`    | number | Tổng số người đã đăng ký qua link này                  |
| `total_orders`      | number | Tổng số đơn hàng phát sinh hoa hồng                    |
| `total_earned`      | number | Tổng hoa hồng tất cả trạng thái (PENDING+CONFIRMED+PAID) |
| `pending_balance`   | number | Hoa hồng đang ở trạng thái `confirmed`, chờ admin credit |

---

### GET `/api/affiliate/commissions` `[User]`

Danh sách hoa hồng theo từng đơn hàng, phân trang.

**Query params:**
| Param   | Type   | Default | Mô tả         |
|---------|--------|---------|---------------|
| `page`  | number | 1       | Trang hiện tại |
| `limit` | number | 10      | Số bản ghi/trang |

**Response `200`:**
```json
{
  "data": [
    {
      "_id": "664abc...",
      "referrer_id": "6650a1...",
      "referred_user_id": {
        "_id": "6651b2...",
        "name": "Nguyễn Văn B",
        "email": "b@example.com"
      },
      "order_id": {
        "_id": "6652c3...",
        "order_code": "ORD-20250306-XYZ12",
        "total_price": 500000,
        "createdAt": "2025-03-01T08:00:00.000Z"
      },
      "order_total": 500000,
      "commission_rate": 5,
      "commission_amount": 25000,
      "status": "confirmed",
      "confirmed_at": "2025-03-06T00:05:00.000Z",
      "paid_at": null,
      "createdAt": "2025-03-01T08:05:00.000Z"
    }
  ],
  "meta": {
    "total": 8,
    "page": 1,
    "limit": 10,
    "totalPages": 1
  }
}
```

| Field               | Type   | Mô tả                                              |
|---------------------|--------|----------------------------------------------------|
| `referred_user_id`  | object | Người mua hàng (populate: `name`, `email`)         |
| `order_id`          | object | Đơn hàng (populate: `order_code`, `total_price`, `createdAt`) |
| `commission_amount` | number | Số tiền hoa hồng của đơn này                       |
| `status`            | string | `pending` / `confirmed` / `paid` / `cancelled`     |
| `confirmed_at`      | Date   | Thời điểm order EXPIRED (đủ điều kiện rút)         |
| `paid_at`           | Date   | Thời điểm admin credit vào balance (null nếu chưa) |

---

### POST `/api/affiliate/withdraw/:commissionId` `[User]` — Bước 1

Gửi yêu cầu rút hoa hồng của 1 đơn. Commission phải ở trạng thái `confirmed`.

**Params:**
| Param          | Type   | Mô tả                   |
|----------------|--------|-------------------------|
| `commissionId` | string | ObjectId của commission |

**Request:** không có body.

**Response `200`:**
```json
{ "message": "Yêu cầu rút đã được gửi, chờ admin duyệt" }
```

**Response `400`:**
```json
{ "message": "Đơn hàng chưa hoàn thành, chưa thể yêu cầu rút" }
{ "message": "Yêu cầu rút đã được gửi, đang chờ admin duyệt" }
{ "message": "Commission không đủ điều kiện để yêu cầu rút" }
{ "message": "Commission không tồn tại" }
```

> Commission chuyển sang `requested`. User không thể gửi lại cho đến khi admin từ chối.

---

### POST `/admin/affiliate/approve/:commissionId` `[Admin]` — Bước 2

Duyệt yêu cầu rút → cộng `commission_amount` vào `affiliate_balance` của user.

**Params:**
| Param          | Type   | Mô tả                   |
|----------------|--------|-------------------------|
| `commissionId` | string | ObjectId của commission |

**Request:** không có body.

**Response `200`:**
```json
{ "credited": 25000 }
```

**Response `400`:**
```json
{ "message": "Không tìm thấy yêu cầu rút hợp lệ" }
```

| Field     | Type   | Mô tả                                    |
|-----------|--------|------------------------------------------|
| `credited`| number | Số tiền đã cộng vào `affiliate_balance`  |

---

### POST `/admin/affiliate/reject/:commissionId` `[Admin]`

Từ chối yêu cầu rút → commission trả về `confirmed`, user có thể yêu cầu lại sau.

**Response `200`:**
```json
{ "message": "Đã từ chối yêu cầu rút" }
```

---

### POST `/api/affiliate/transfer` `[User]`

Chuyển toàn bộ `affiliate_balance` → `money` (balance chính dùng để mua proxy).

**Request:** không có body.

**Response `200`:**
```json
{
  "transferred": 150000
}
```

**Response `400`:**
```json
{
  "statusCode": 400,
  "message": "Không có số dư hoa hồng để chuyển"
}
```

| Field        | Type   | Mô tả                             |
|--------------|--------|-----------------------------------|
| `transferred`| number | Số tiền vừa chuyển sang `money`   |

> **Atomic:** Dùng MongoDB aggregation pipeline update — đọc và ghi trong 1 operation, không thể race condition.

---

### POST `/admin/affiliate/credit/:userId` `[Admin]`

Credit toàn bộ commission `confirmed` của 1 user vào `affiliate_balance`.

**Params:**
| Param    | Type   | Mô tả              |
|----------|--------|--------------------|
| `userId` | string | ObjectId của user  |

**Request:** không có body.

**Response `200`:**
```json
{
  "credited": 75000,
  "count": 3
}
```

**Response `400`:**
```json
{
  "statusCode": 400,
  "message": "Không có hoa hồng nào đủ điều kiện để credit"
}
```

| Field     | Type   | Mô tả                                          |
|-----------|--------|------------------------------------------------|
| `credited`| number | Tổng tiền đã cộng vào `affiliate_balance`       |
| `count`   | number | Số commission đã được xử lý (status → `paid`)  |

---

### GET `/admin/affiliate/config` `[Admin]`

Xem cấu hình hệ thống affiliate.

**Response `200`:**
```json
{
  "commission_rate": 5,
  "is_active": true
}
```

---

### PUT `/admin/affiliate/config` `[Admin]`

Cập nhật cấu hình. Chỉ gửi field cần thay đổi.

**Request body:**
```json
{
  "commission_rate": 8,
  "is_active": true
}
```

| Field             | Type    | Required | Mô tả                        |
|-------------------|---------|----------|------------------------------|
| `commission_rate` | number  | Không    | % hoa hồng mới               |
| `is_active`       | boolean | Không    | `false` để tắt toàn hệ thống |

**Response `200`:**
```json
{
  "commission_rate": 8,
  "is_active": true
}
```

> Thay đổi `commission_rate` **không** ảnh hưởng các commission đã tạo trước đó (mỗi record lưu rate tại thời điểm tạo).

---

## Quy tắc nghiệp vụ

1. **Trigger:** Hoa hồng chỉ phát sinh khi `order.status = ACTIVE` (proxy đã được cấp phát thành công)
2. **Idempotent:** `order_id` unique index → dù trigger gọi 2 lần vẫn chỉ tạo 1 commission
3. **Không tự giới thiệu:** `applyReferralCode` kiểm tra `referrer._id !== userId`
4. **`referred_by` bất biến:** Chỉ gán lúc đăng ký, không thay đổi sau
5. **Hoa hồng tính trên `total_price`** (giá sau discount), không tính cost
6. **`affiliate_balance` ≠ `money`:** Tách biệt hoàn toàn, phải transfer thủ công
7. **Rate lưu tại thời điểm tạo:** `commission_rate` lưu vào record → thay đổi config sau không ảnh hưởng hoa hồng cũ

---

## Files liên quan

| File | Mô tả |
|------|-------|
| `src/affiliate/affiliate.service.ts` | Logic chính |
| `src/affiliate/affiliate.controller.ts` | HTTP endpoints |
| `src/affiliate/affiliate.module.ts` | NestJS module |
| `src/schemas/affiliate-commission.schema.ts` | Schema hoa hồng |
| `src/schemas/affiliate-config.schema.ts` | Schema cấu hình |
| `src/schemas/users.schema.ts` | Thêm 3 fields affiliate |
| `src/orders/orders.worker.service.ts` | Trigger ProxyVN |
| `src/orders/orders-processing.scheduler.ts` | Trigger HomeProxy |
