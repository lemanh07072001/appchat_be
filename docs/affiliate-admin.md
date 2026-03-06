# Affiliate Admin API

Tất cả endpoints yêu cầu:
- `Authorization: Bearer <access_token>` (role = **admin**)

Base path: `/api/admin/affiliate`

---

## Config

### GET `/api/admin/affiliate/config`
Lấy cấu hình hệ thống affiliate.

**Response:**
```json
{
  "_id": "...",
  "commission_rate": 5,
  "is_active": true,
  "createdAt": "...",
  "updatedAt": "..."
}
```

---

### PATCH `/api/admin/affiliate/config`
Cập nhật cấu hình affiliate.

**Request body** _(tất cả optional)_:
```json
{
  "commission_rate": 7,
  "is_active": false
}
```

**Response:** Document config sau khi cập nhật.

---

## Yêu cầu rút tiền

### GET `/api/admin/affiliate/withdraw-requests?page=1&limit=10`
Danh sách commission đang chờ duyệt (`status = requested`), sắp xếp theo `requested_at` mới nhất.

**Response:**
```json
{
  "data": [
    {
      "_id": "...",
      "referrer_id": { "_id": "...", "name": "Nguyen A", "email": "a@example.com" },
      "referred_user_id": { "_id": "...", "name": "Nguyen B", "email": "b@example.com" },
      "order_id": { "_id": "...", "order_code": "ORD-001", "total_price": 200000 },
      "commission_amount": 10000,
      "commission_rate": 5,
      "status": "requested",
      "requested_at": "2026-03-06T07:00:00.000Z"
    }
  ],
  "meta": { "total": 1, "page": 1, "limit": 10, "totalPages": 1 }
}
```

---

### POST `/api/admin/affiliate/approve/:commissionId`
Duyệt yêu cầu rút → cộng `commission_amount` vào `affiliate_balance` của referrer, chuyển status → `paid`.

**Response:**
```json
{
  "credited": 10000
}
```

**Lỗi:**
- `400` — commission không tồn tại hoặc không ở trạng thái `requested`

---

### POST `/api/admin/affiliate/reject/:commissionId`
Từ chối yêu cầu rút → trả commission về trạng thái `confirmed`.

**Response:**
```json
{
  "message": "Đã từ chối yêu cầu rút"
}
```

---

## Credit hàng loạt

### POST `/api/admin/affiliate/credit/:userId`
Credit toàn bộ commission `confirmed` của 1 user vào `affiliate_balance` (không cần user request từng đơn).
Dùng khi admin muốn xử lý nhanh hàng loạt.

**Params:** `userId` — ObjectId của referrer

**Response:**
```json
{
  "credited": 22000,
  "count": 2
}
```

**Lỗi:**
- `400` — không có commission `confirmed` nào cho user này

---

## Xem dữ liệu user

### GET `/api/admin/affiliate/stats/:userId`
Thống kê affiliate của 1 user cụ thể.

**Response:**
```json
{
  "referral_code": "REF_74ftnrn9",
  "affiliate_balance": 0,
  "total_referred": 1,
  "total_orders": 10,
  "total_earned": 127000,
  "pending_balance": 22000
}
```

---

### GET `/api/admin/affiliate/commissions/:userId?page=1&limit=10`
Danh sách toàn bộ commission của 1 user (phân trang).

**Response:**
```json
{
  "data": [
    {
      "_id": "...",
      "referred_user_id": { "name": "...", "email": "..." },
      "order_id": { "order_code": "ORD-001", "total_price": 200000 },
      "commission_amount": 10000,
      "commission_rate": 5,
      "status": "confirmed",
      "confirmed_at": "2026-03-06T05:43:39.580Z"
    }
  ],
  "meta": { "total": 10, "page": 1, "limit": 10, "totalPages": 1 }
}
```

---

## Luồng xử lý yêu cầu rút

```
User: POST /affiliate/withdraw/:commissionId
        ↓ (commission → requested)
Admin: GET /admin/affiliate/withdraw-requests   ← xem danh sách chờ
        ↓
   ┌─── POST /admin/affiliate/approve/:id  → PAID, cộng affiliate_balance
   └─── POST /admin/affiliate/reject/:id   → CONFIRMED, user có thể rút lại
```

## Commission Status

| Status      | Ý nghĩa                                        |
|-------------|------------------------------------------------|
| `pending`   | Order đang ACTIVE — chưa đủ điều kiện          |
| `confirmed` | Order đã EXPIRED — Đã đủ điều kiện             |
| `requested` | User đã yêu cầu rút — chờ admin duyệt         |
| `paid`      | Admin đã duyệt, đã cộng vào affiliate_balance  |
| `cancelled` | Đơn bị huỷ                                     |
