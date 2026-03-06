# Luồng hoạt động Affiliate

---

## Commission Status

```
pending → confirmed → credited → requested → paid
                    ↗ (admin reject) ↙
```

| Status      | Hiển thị             | Ý nghĩa                                                    |
|-------------|----------------------|------------------------------------------------------------|
| `pending`   | Chưa đủ điều kiện   | Order đang ACTIVE — chờ hết hạn                            |
| `confirmed` | Đủ điều kiện         | Order đã EXPIRED — chờ admin duyệt vào ví                  |
| `credited`  | Đã vào ví affiliate  | Admin duyệt, đã cộng vào affiliate_balance                 |
| `requested` | Yêu cầu rút ngân hàng| User yêu cầu rút — chờ admin chuyển khoản                 |
| `paid`      | Đã thanh toán        | Admin đã chuyển khoản, user nhận tiền                      |
| `cancelled` | Đã huỷ               | Đơn bị huỷ                                                 |

---

## Luồng USER

### 1. Lấy link affiliate
```
GET /api/affiliate/get-link
→ Tạo referral_code nếu chưa có
→ Trả về { code, link, commission_rate }

Link chia sẻ: /register?ref=REF_xxxxxxxx
```

### 2. Người mới đăng ký qua link
```
POST /api/auth/register  { referral_code: "REF_xxxxxxxx" }
→ applyReferralCode() gán referred_by = referrer._id cho user mới
```

### 3. Người được giới thiệu mua hàng
```
User mua proxy → Order tạo ra
        ↓
Order → ACTIVE (proxy đã được cấp phát)
        ↓
handleOrderActive() tự động chạy
        ↓
Tạo AffiliateCommission { status: "pending", amount: total × rate% }
        ↓
[Referrer thấy commission ở trạng thái pending — chưa làm gì được]
```

### 4. Order hết hạn (tự động mỗi 5 phút)
```
Scheduler checkExpiredOrders() chạy
        ↓
Order ACTIVE có end_date ≤ now → EXPIRED
        ↓
handleOrderExpired() chạy
        ↓
Commission: pending → confirmed
        ↓
[Referrer có thể yêu cầu rút tiền]
```

### 5. User yêu cầu rút từng commission
```
GET /api/affiliate/commissions           ← xem danh sách, tìm commission confirmed
        ↓
POST /api/affiliate/withdraw/:commissionId
        ↓
Commission: confirmed → requested
        ↓
[Chờ admin duyệt]
```

### 6. Sau khi admin duyệt
```
Commission: requested → paid
affiliate_balance += commission_amount
        ↓
POST /api/affiliate/transfer             ← chuyển affiliate_balance → money
        ↓
money += affiliate_balance
affiliate_balance = 0
        ↓
[Dùng money để mua proxy]
```

### 7. Xem thống kê
```
GET /api/affiliate/stats
→ {
    referral_code,
    affiliate_balance,   ← đã được duyệt, chờ transfer
    total_referred,      ← số người đã đăng ký qua link
    total_orders,        ← tổng số đơn phát sinh hoa hồng
    total_earned,        ← tổng hoa hồng tích lũy (mọi trạng thái)
    pending_balance      ← commission confirmed, chưa rút
  }
```

---

## Luồng ADMIN

### 1. Xem danh sách yêu cầu rút
```
GET /api/admin/affiliate/withdraw-requests?page=1&limit=10
→ Danh sách commission status=requested, sort mới nhất
→ Thấy: referrer info, buyer info, order info, số tiền
```

### 2. Duyệt yêu cầu
```
POST /api/admin/affiliate/approve/:commissionId
        ↓
commission: requested → paid
user.affiliate_balance += commission_amount
        ↓
[User nhận thông báo, vào transfer để dùng tiền]
```

### 3. Từ chối yêu cầu
```
POST /api/admin/affiliate/reject/:commissionId
        ↓
commission: requested → confirmed
        ↓
[User có thể gửi lại yêu cầu rút sau]
```

### 4. Credit hàng loạt (bulk approve)
```
POST /api/admin/affiliate/credit/:userId
→ Tự động duyệt TẤT CẢ commission confirmed của 1 user
→ Không cần user request từng đơn
→ Dùng khi muốn xử lý nhanh cho 1 referrer cụ thể
```

### 5. Xem thống kê & commission của user bất kỳ
```
GET /api/admin/affiliate/stats/:userId
GET /api/admin/affiliate/commissions/:userId?page=1&limit=10
```

### 6. Cấu hình hệ thống
```
GET  /api/admin/affiliate/config
PATCH /api/admin/affiliate/config  { commission_rate: 7, is_active: true }
→ commission_rate thay đổi chỉ ảnh hưởng đơn hàng MỚI
→ Đơn cũ giữ nguyên commission_rate tại thời điểm tạo
```

---

## Sơ đồ tổng thể

```
[User A chia sẻ link REF_xxx]
         ↓
[User B đăng ký qua link → referred_by = A]
         ↓
[User B mua proxy → Order ACTIVE]
         ↓ (handleOrderActive)
[Commission PENDING tạo ra]
         ↓ (scheduler 5 phút, order EXPIRED)
[Commission → CONFIRMED]
         ↓ (User A request withdraw)
[Commission → REQUESTED]
         ↓ (Admin approve)
[Commission → PAID, A.affiliate_balance += amount]
         ↓ (User A transfer)
[A.money += affiliate_balance → mua proxy]
```
