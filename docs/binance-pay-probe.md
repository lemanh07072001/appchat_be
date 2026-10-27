# Kiểm tra khả năng đối soát Binance Pay

Công cụ này chỉ đọc lịch sử, không kết nối MongoDB, không cộng tiền, không
khởi động cron và không thay đổi cấu hình production.

## Cấu hình

Tạo API key riêng với quyền đọc cần thiết và IP allowlist của máy thực hiện.
Không bật quyền giao dịch, chuyển tài sản hoặc rút tiền. Xác nhận việc sử dụng
tài khoản phù hợp điều khoản Binance và quy định áp dụng.

Thêm các biến sau vào `backend/.env` (được Git bỏ qua), giữ nguyên biến khác:

```dotenv
BINANCE_READ_API_KEY=
BINANCE_READ_API_SECRET=
BINANCE_PROBE_HOURS=24
```

Không gửi key/secret qua chat, không commit `.env`.

## Chạy

Từ thư mục `backend`:

```sh
npm run binance:probe -- --self-test
npm run binance:probe
```

Lệnh thứ hai gửi một yêu cầu lịch sử có chữ ký tới Binance, sau khi lấy giờ
server. Không có yêu cầu chuyển tiền. Công cụ chỉ in số bản ghi và tên/kiểu
các trường; không in nội dung, email, số tiền hoặc mã giao dịch thực tế.
Không có bản ghi không có nghĩa API hỗ trợ/không hỗ trợ lời nhắn.

Đối chiếu cục bộ với một giao dịch nhận tiền đã biết để xác minh Order ID,
chiều nhận tiền, loại giao dịch, ý nghĩa trạng thái và trường lời nhắn.
Không giả định `note`/`remark` tồn tại hoặc có ý nghĩa xác minh chỉ dựa vào tên.
Nếu API không trả lời nhắn đủ tin cậy, không bật tự gán người dùng bằng mã nạp.

Lệnh giới hạn 100 giao dịch, không phải công cụ đối soát đầy đủ. Luồng thật
cần chia cửa sổ truy vấn, xử lý giới hạn, chống trùng, đối soát và log bền vững.
Việc không có bản ghi trong truy vấn không phải bằng chứng khách chưa trả tiền.

## Nguồn

- https://developers.binance.com/en/docs/catalog/investment-and-services-pay/api/rest-api/~
- https://github.com/binance/binance-api-swagger/blob/master/spot_api.yaml

API được kiểm tra: `GET /sapi/v1/pay/transactions` (USER_DATA).
Tài liệu mô tả số tiền dương là tiền vào, âm là tiền ra; không thể coi mọi
bản ghi dương là khoản nạp khách hàng (có thể là hoàn tiền hoặc loại khác).
