# GPNIP: cấu hình trước khi bán thật

## Proxy tĩnh: catalog đọc ngày 2026-10-26

Catalog hiện có các gói static dùng `purchaseFields` và `servicePricing`:

| Gói | ID | Product |
| --- | --- | --- |
| IPv4 riêng | `6ad6f4c2748369db9ee14aad` | `proxy6-v4` |
| IPv4 shared | `6ad6f4c2748369db9ee14aae` | `proxy6-v3` |
| IPv6 riêng | `6ad6f4c2748369db9ee14aaf` | `proxy6-v6` |

Cấu hình dịch vụ hiện tại (không thay đổi mô hình đa quốc gia): mỗi dịch vụ
chọn một quốc gia hợp lệ theo `purchaseFields.country.options`, pricing_mode
`duration`, ID dịch vụ là ID gói. Ví dụ body cho Mỹ:

```json
{"country":"US","period":"30","ips":1}
```

Adapter thay `period` và `ips` bằng thời hạn và số IP thực được tính tiền,
không dùng các giá trị mẫu để đặt hàng. Gói IPv4 hỗ trợ 7/14/30/60/90 ngày;
IPv6 có thêm 3 ngày. Giới hạn catalog hiện tại là 1–100 IP. Kiểm tra lại
catalog trước khi cấu hình; không giả định danh sách này luôn cố định.

Các gói này báo `pricing.mode=time` nhưng số lượng là `ips`; không áp quy
tắc một gateway mỗi đơn của gói time cũ. Preflight kiểm tra field bắt buộc,
quốc gia, thời hạn, giới hạn số IP và gọi check-price với `period`.
Chưa xác minh mua/gia hạn thực tế. Không bật bán trước khi xác nhận giá bán
VND, cấu hình gia hạn và kiểm thử cấp proxy. Không tự quy đổi `coin` thành VND.

Nguồn đối chiếu ngày 2026-10-19:
- prod: https://app.gpnip.com/vi/proxy/api -> https://api.gpnip.com/api/v1/reseller
- dev:  https://dev-app.gpnip.com/en/proxy/api -> https://dev-api.gpnip.com/api/v1/reseller

Hai trang docs liệt kê ĐÚNG CÙNG 16 endpoint, chỉ khác host.

## Chọn môi trường
Env `GPNIP_BASE_URL`. Bỏ trống = prod. Khai báo trong backend/.env, cần restart
backend + worker. Env sai định dạng, hoặc http trỏ ra Internet, thì backend
KHÔNG khởi động — âm thầm rơi về prod là biến một lần test thành đơn tiền thật.

## Kết quả gọi API THẬT (2026-10-19, key omo_px_b20…c06b)
Chạy lại: `GPNIP_API_KEY=... npx ts-node -r tsconfig-paths/register scripts/gpnip-smoke.ts`
Script CHỈ ĐỌC, không có đường tạo đơn. 14/14 endpoint đọc được pass.

- Key dùng được ở PROD, bị `Invalid API key` ở dev-api. Dev cần key riêng.
- Tài khoản lemanh.laravel@gmail.com, số dư 8.72 USD, 34 đơn (20/trang).
- `GET /packages` trả RỖNG (total 0) ở cả 5 mode. Tài khoản chưa có gói nào
  bật API => CHƯA MUA ĐƯỢC qua API, và `/packages/{id}`, `/packages/{id}/stock`,
  `POST /check-price`, `preflightBuy` CHƯA test được lần nào.
- `GET /orders/{id}` trả đúng tài liệu: có cả `proxy` và `proxies`.

Ba chỗ API thật KHÁC tài liệu:
1. `GET /countries` trả `{ product, supported: { country: [...] }, capabilities }`,
   KHÔNG phải `[{ name, iso_code }]`. Adapter chuẩn hoá cả hai dạng về
   `{ product, iso_codes, capabilities, raw }`. Mã ISO được viết hoa: API trả
   chữ thường ("us"), cấu hình dịch vụ nội bộ dùng chữ hoa.
2. ID đơn là ObjectId 24 ký tự ("6ad36c775a0fd3280a199639"), KHÔNG phải int.
   Adapter dùng string nên không ảnh hưởng.
3. NCC đổi tên product trong response: gửi `unlimited_residential` nhận
   `unlimited-residential`; gửi `residential` nhận `pool1`.

Số quốc gia đọc được: pool1 166, residential-lite 202, unlimited-residential
201, mobile 115, isp 1 (US), datacenter 1 (US).

## ĐÃ GỠ: định dạng ID gói là ObjectId, không phải int
Kiểm chứng trên api.gpnip.com 2026-10-19:
  GET /packages/1                        -> 400 "Invalid ID format"
  GET /packages/12345                    -> 400 "Invalid ID format"
  GET /packages/000000000000000000000001 -> 404 "Package not found."
  GET /packages?categoryId=1             -> 400 "Invalid ID format"
Thêm (2026-10-19, kiểm chứng cả ba):
  GET /orders/1                          -> 400 "Invalid ID format"
  GET /orders/000000000000000000000001   -> 404 "Không tìm thấy đơn hàng."
  GET /packages?categoryId=000000000000000000000001 -> success, total 0

Tức là MỌI ID DÙNG LÀM PATH/QUERY PARAM (gói, đơn, category) đều là ObjectId
24 hex; tài liệu ghi `int` là SAI ở cả ba chỗ.

KHÔNG phải mọi trường định danh đều vậy. Chi tiết đơn trả ba trường khác
định dạng nhau:
  id       = "6ad36c775a0fd3280a199639"                 <- ObjectId, path OK
  uuid     = "acct_e4tkz2edvn9a91d6x0zerx9bg0"          <- path trả 400
  order_id = "omo-eddfc447-e645-45fa-95d2-69a730929597" <- path trả 400

## ĐÃ SỬA: buy() lưu sai trường làm provider_order_id
Code cũ: `data?.order_id ?? data?.id ?? data?.order?.id` — ưu tiên `order_id`
theo đúng tài liệu (`POST /orders` trả `{order_id, status}`). Nhưng `order_id`
thật là chuỗi `omo-…`, không dùng được làm path param. Hậu quả nếu mua thật:
đơn đã trừ tiền khách, `provider_order_id` lưu `omo-…`, rồi poll /usage
/proxies /extend /renew /password /allowed-ips đều 400 VĨNH VIỄN — đơn treo,
không lấy được proxy.

Đã sửa bằng `pickProviderOrderId`: ưu tiên ứng viên ĐÚNG DẠNG path theo thứ tự
`id`, `order.id`, `data.id`, `order_id`, `uuid`. Không có cái nào đúng dạng thì
vẫn giữ ứng viên đầu (đơn đã mua, mất ID là mất đường đối soát) và LOG ERROR để
vận hành xử lý tay. `raw` luôn lưu nguyên response.

`buildBuyBody` trước đây ép `Number.isSafeInteger` nên sẽ chặn 100% lần mua
GPNIP ngay tại local. Đã sửa: `GpnipProvider.normalisePackageId` nhận ObjectId
24 hex (viết thường hoá) HOẶC số nguyên >= 1, từ chối rỗng/23 hex/25 hex/
non-hex. Nới như vậy an toàn vì `preflightBuy` đọc GET /packages/{id} và chặn
ID không tồn tại TRƯỚC khi trừ ví.

## ĐÃ SỬA: quốc gia phải lấy theo GÓI, không theo lựa chọn tay
Enum `product` trong tài liệu cho GET /countries (residential, residential-lite,
datacenter, isp, unlimited_residential, mobile) là THIẾU. Catalog thật còn
`ipv6-datacenter` và `ipv6-residential`, và GPNIP NHẬN cả hai:
  product=ipv6-datacenter  -> echo 'ipv6-datacenter',   1 nuoc (us)
  product=ipv6-residential -> echo 'ipv6-residential',  1 nuoc (us)
  product=residential      -> echo 'pool1',           166 nuoc
  product=residential-lite -> 202 nuoc
  product=unlimited_residential -> echo 'unlimited-residential', 201 nuoc
  product=mobile           -> 115 nuoc
  product=isp / datacenter -> 1 nuoc (us)
  product=bogus            -> HTTP 502 (loi phia ho, khong phai 400)

Adapter truoc day chan theo enum tai lieu => tu choi dung product cua goi dang
ban. Da bo allow-list, chi con kiem tra HINH DANG. `DOCUMENTED_PRODUCTS` giu
lai chi de goi y o giao dien.

Vung phu lech nhau rat xa (1 nuoc vs 202 nuoc) nen KHONG duoc de nguoi cau
hinh tu chon loai san pham. Them `listCountriesForPackage(token, packageId)`:
doc `product` tu chinh goi roi moi goi /countries. Noi ra:
  GET /api/admin/services/:id/countries   (backend)
  GET /api/admin/services/[id]/countries  (frontend route)
  panel "Vung phu quoc gia cua goi" trong form dich vu admin
Kiem chung tren goi that: service -> 6aa8efbde22a3725a45d92bc ->
product ipv6-datacenter -> iso_codes ['US'].

Goi khong khai `product` thi NEM LOI, khong doan: doan sai la khai vung phu cua
mot san pham khac len dich vu nay.

## BLOCKER còn lại: tài khoản không có gói nào bật API
GET /packages trả `success: true` kèm `total: 0` ở mọi biến thể tham số
(per_page, mode, không tham số). Đó là câu trả lời "không có gói", không phải
lỗi xác thực. Đã thử 3 key khác nhau (2 key omo_px_, 1 key gpnip_px_) — cùng
kết quả, vì đây là cấu hình THEO TỪNG GÓI trong dashboard GPNIP, không theo
key. /categories và /products không tồn tại.

Cần làm: bật quyền API cho gói trong dashboard reseller GPNIP. Xong thì
GET /packages có ID thật và POST /orders mới mua được.

## Đã nối trong code
- GET /me: kiểm tra key và số dư.
- GET /packages: danh mục có phân trang qua trang quản trị nhà cung cấp.
- Trước trừ ví: kiểm tra partner đang bật, key, adapter, worker heartbeat,
  cấu hình gói; đọc chi tiết gói/tồn kho và POST /check-price chỉ báo giá.
- Mua theo GB/IP/thời gian từ số lượng thực tế được tính tiền. Snapshot gói
  theo đơn để admin sửa dịch vụ không đổi request đơn đã trả tiền.
- POST /orders một lần. Ghi dấu đã thử mua và lưu ID NCC trước khi polling.
- Poll GET /orders/{id} tới active, đọc toàn bộ mảng proxies, không chỉ proxy.
- Đọc usage; extend GB riêng với renew thời gian.
- Renew preview trả price và order:null, không có days. Commit lấy
  order.expired_at. Chỉ gia hạn toàn bộ đơn còn active theo thời gian.
- GET /orders: đọc đơn phía NCC để đối soát, giữ nguyên meta phân trang.
  Chỉ đọc — không tự gán ID NCC cho đơn nội bộ đoán được.
- GET /countries và GET /orders/{id}/geo: danh mục địa lý. /countries chuẩn
  hoá hai dạng response (xem phần API thật ở trên).
- PUT /orders/{id}/password: đổi mật khẩu proxy, rồi ghi mật khẩu NCC XÁC NHẬN
  vào proxies + order.credentials. Gọi NCC trước, ghi DB sau. Không ghi mật
  khẩu vào order_logs.
- PUT /orders/{id}/allowed-ips: whitelist tối đa 10 IP (lọc trùng trước khi
  đếm), mảng rỗng = xoá whitelist. Lưu danh sách NCC xác nhận vào
  provider_metadata.allowed_ips.

## Sau khi có key (chưa thực hiện)
1. Vào /vi/admin/partners, sửa GPNIP code gpnip, nhập key, kiểm tra kết nối,
   lưu. Giữ trạng thái tắt tới khi cấu hình dịch vụ hoàn chỉnh.
2. Mở lại form, tải danh mục gói. Chọn ID thật của gói API-enabled, đọc
   pricing.mode, delivery, duration và thông số giá. Không đoán mã gói.
3. Tạo dịch vụ riêng liên kết GPNIP, không ghi đè dữ liệu demo:
   - GB tiered: ID dịch vụ = ID gói; body_api = {}; pricing_mode=bandwidth;
     cấu hình bảng tiers hoặc gói GB.
   - Time: body_api = {}; pricing_mode=duration; quantity mỗi đơn = 1.
   - ISP per_ip: body_api = {"ips":1,"pool":"POOL_THẬT"}; giá theo IP/ngày.
     ips gửi đi bằng quantity tính tiền. Pool phải lấy đúng từ NCC.
   Có thể thêm country. packageId hoặc id trong body ưu tiên hơn ID dịch vụ.
4. Giá NCC là USD; giá nội bộ là VND. Chủ hệ thống xác nhận tỷ giá, giá vốn
   và giá bán; không tự sao chép USD sang VND. Gói fixed phải khớp ngày.
   per_thread chưa hỗ trợ, bị từ chối trước trừ ví.
5. Chạy từ backend: npm run build, npm run start:prod và npm run worker:prod
   ở process/service riêng; hoặc PM2 ecosystem.config.js.
   Entry points thực tế: dist/src/main.js và dist/src/worker.js.
   Worker heartbeat TTL 30s, làm mới 10s; thiếu worker thì từ chối mua.
6. Chỉ bật partner/service sau khi key, gói và giá đã xác nhận.
   Mua thử tiêu tiền thật cần chủ hệ thống đồng ý riêng.

## Giới hạn và xử lý sự cố
- Không khởi động worker trên dữ liệu demo có đơn chờ khi chưa rà queue.
  Worker có thể xử lý mọi đơn pending trong database/Redis cấu hình.
- Timeout sau POST mua: đối soát bằng GET /orders (trang quản trị NCC ->
  "Đơn ở nhà cung cấp") trước khi xử lý nội bộ.
  Không xóa cờ config.gpnip_purchase_started tùy tiện. Admin retry bị chặn
  với đơn đã thử mua để tránh xóa ID và mua trùng; phục hồi thủ công.
- MongoDB, Redis và NCC không atomic. Heartbeat không loại bỏ được trường
  hợp worker chết ngay sau check. Đơn vẫn có thể pending/PENDING_REFUND
  khi lỗi sau trừ ví; không hứa hoàn tiền tự động.
- Giới hạn NCC 120 request/phút. Hiện giảm gọi bằng cách dùng proxies trong
  detail nếu đủ. Chưa có limiter phân tán nhiều worker; cần giữ tải thấp.
- Catalog chỉ đọc, không tự import/bật bán hay suy đoán giá.
- Geo/countries KHÔNG còn chỉ để đọc: ô quốc gia ở form dịch vụ (admin) và ô
  chọn quốc gia trong modal proxy của khách đều lấy danh sách từ đây. Luồng
  MUA vẫn lấy country từ cấu hình dịch vụ — khách chưa chọn quốc gia lúc đặt
  hàng, chỉ chọn lúc ghép chuỗi proxy (segment `-country-`).
- Đổi mật khẩu/whitelist IP áp cho TOÀN BỘ đơn, không theo từng IP — đó là
  thiết kế của NCC.
- Ghi DB lỗi sau khi NCC đã đổi mật khẩu: API trả lỗi kèm mật khẩu đang có
  hiệu lực để khách không mất quyền truy cập; proxy trong DB lúc đó còn mật
  khẩu cũ, phải sửa tay.
- Đã xác thực thật: tài khoản, số dư, danh mục quốc gia, danh sách đơn, chi
  tiết đơn, proxy, usage, geo.
- CHƯA xác thực thật: chi tiết gói, tồn kho, báo giá, preflight, mua, nạp GB,
  gia hạn, đổi mật khẩu, whitelist IP. Bốn cái đầu bị chặn vì catalog rỗng;
  năm cái sau tiêu tiền hoặc đổi cấu hình đơn thật nên cần chủ hệ thống đồng ý
  riêng.

## ĐÃ SỬA: ô quốc gia trong modal của khách là SELECT, lấy từ API

Trước: modal proxy theo dung lượng cho khách **nhập tay** mã ISO-2
(`us` hoặc `us,gb`). Gõ một mã mà gói không bán thì gateway từ chối kết nối,
và khách không đọc được nguyên nhân.

Giờ: `GET /api/orders/my/:id/geo` trả danh sách chuẩn hoá, modal dựng ô chọn
nhiều nước từ đó (tên nước lấy từ danh mục public, chọn bằng mã nếu thiếu tên).

### Vì sao phải có nguồn DỰ PHÒNG

Kiểm chứng trên đơn THẬT đã mua (`ORD-20261019-A74C8A512F`,
`provider_order_id=6ad5f4595ae4454f3e51b30`) ngày 2026-10-20:

```
GET /orders/{id}/geo        -> {"success":true,"data":[]}       # RỖNG
GET /packages/{id}          -> product = ipv6-datacenter
GET /countries?product=...  -> supported.country = ["us"]        # CÓ 1 NƯỚC
```

Đơn trả geo rỗng trong khi gói của nó khai 1 nước. Dừng ở nguồn chính là ô
chọn quốc gia **rỗng trên một đơn có quốc gia**. Nên `fetchOrderGeo` ở
`orders.service` đi hai bước:

1. `/orders/{id}/geo` — hẹp nhất, đúng nhất → `source: "order"`
2. vùng phủ của chính gói, nếu (1) rỗng → `source: "package"`
3. không có gì → `source: "none"`, `iso_codes: []`

Lỗi ở bước 2 **không** làm sập endpoint (chỉ `logger.warn`): nguồn chính đã
trả lời xong, bước 2 chỉ là bù thêm.

Kết quả thật qua app, sau khi sửa:

```
GET /api/orders/my/6ad5f4721cce846af8f8dad4/geo
200 {"iso_codes":["US"],"source":"package",
     "capabilities":{"country":true,"state":false,"city":false,
                     "state_city":false,"asn":false,"zip":false,"session":false}}
```

(Trước khi sửa, cùng endpoint trả `[]`.)

### Chuẩn hoá nằm ở ADAPTER, không ở service

`GpnipProvider.extractIsoCodes` gom mã từ cả bốn dạng payload đã gặp trên cùng
một nhà cung cấp: `[{name,iso_code}]`, `{supported:{country:[]}}`,
`{countries:[]}`, và mảng chuỗi. Chỉ giữ mã **2 chữ cái** — payload geo còn
trộn state/city/asn, nhận bừa là đẩy `california` vào ô chọn quốc gia rồi ghép
thành `-country-california`.

`fetchOrderGeo` của adapter và `listCountriesForPackage` giờ có kiểu trả về cụ
thể trong `proxy-provider.interface.ts` (không còn `Promise<unknown>`), vì
caller dựng giao diện từ đó.

### KHÔNG trả `raw` cho khách

Response của endpoint này khách đọc trực tiếp. `raw` mang nhãn và tên nhà cung
cấp, nên service chỉ trả `{iso_codes, source, capabilities}`. Có test chặn
regression (`expect(JSON.stringify(res)).not.toMatch(/gpnip/i)`).

### Ô quốc gia ở form DỊCH VỤ (admin) cũng bị khoá theo vùng phủ

`GET /api/admin/services/:id/countries` tự tải khi mở form dịch vụ đã lưu; ô
quốc gia chỉ liệt kê những nước **giao** giữa danh mục nội bộ và vùng phủ gói.
Mã NCC bán mà danh mục chưa có thì cảnh báo riêng. Giá trị đã lưu nằm ngoài
vùng phủ thì **giữ nguyên + cảnh báo đỏ**, không tự xoá.

Không lấy được vùng phủ (dịch vụ chưa lưu / NCC không hỗ trợ / gọi lỗi) thì mở
lại toàn danh mục **và nói rõ lý do** — chặn cứng khi chưa biết vùng phủ là làm
admin không khai nổi quốc gia cho mọi NCC khác.

## Cổng theo sản phẩm (bảng chủ hệ thống cung cấp 2026-10-20)

| Sản phẩm | Hostname trong bảng | HTTP | SOCKS5 | `product` slug | Trong code? |
|---|---|---|---|---|---|
| Residential | geo.proxyserver.bot | 8080 | 1080 | `residential` | ✅ |
| Residential Lite | lite.proxyserver.bot | 6969 | 9696 | `residential-lite` | ✅ |
| Datacenter | v3-dc.proxyserver.bot | 777 | 666 | `datacenter` | ✅ |
| Mobile | geo.proxyserver.bot | 8080 | 1080 | `mobile` | ✅ |
| Shared ISP | v3-isp.proxyserver.bot | 30 | 31 | `isp` | ✅ |
| IPv6 Residential | v3-v6-resi.proxyserver.bot | 30 | 31 | `ipv6-residential` | ✅ |
| IPv6 Datacenter | v3-v6-dc.proxyserver.bot | 50 | 51 | `ipv6-datacenter` | ✅ |
| Unlimited Residential | unlim.proxyserver.bot | 10507 | 10507 | `unlimited_residential` | ✅ |
| Mobile USA | v3-resi-us.proxyserver.bot | 10000 | 11000 | **chưa biết** | ❌ |
| Shared ISP EU | new-eu-isp.proxyserver.bot | 30 | 31 | **chưa biết** | ❌ |
| Premium Unlimited Residential | `connection.hostname` của gói (`premium-unl-<key>…`) | 10000 | 6969 | **chưa biết** | ❌ |
| Residential Pool 1–6 | v3-resi-us.proxyserver.bot | 10000–10009 | 11000–11009 | — | ❌ (dải, không phải cặp) |
| Dedicated ISP | thay đổi theo IP | — | — | — | ❌ |
| Dedicated ISP v2 | thay đổi theo IP | theo IP | — | — | ❌ |

`Unlimited Residential` dùng **cùng một cổng** cho cả HTTP và SOCKS5 (10507) —
không phải lỗi chép bảng, nên đừng "sửa" thành hai số khác nhau.

### Vì sao phải hardcode, và hardcode tới đâu

`GET /packages` CÓ field `ports`, nhưng trả **`null` cho cả 7 gói** của tài
khoản này (kiểm chứng 2026-10-20). Nên không đọc được cổng từ danh mục.

Kết hợp với: `fetchOrderProxies` **ném lỗi** khi cổng không hợp lệ. Vậy một đơn
socks5 của sản phẩm không khai `port_socks` sẽ **cấp thất bại hoàn toàn**, chứ
không phải chỉ mất nút chuyển giao thức.

Nên bảng vào code như `GpnipProvider.PRODUCT_PORTS`, nhưng **chỉ là dự phòng**:
cổng nhà cung cấp trả về trong đơn luôn thắng, kể cả khi nó khác bảng. Bảng chép
tay rồi sẽ cũ; áp bảng lên dữ liệu thật là cấp cho khách proxy chết.

### Ba thứ KHÔNG lấy từ bảng

**Hostname.** Bảng ghi `*.proxyserver.bot`, nhưng đơn thật trả
`v3-v6-dc.gpnip.com` — cùng tiền tố subdomain (`v3-v6-dc`), khác apex. GPNIP là
nhãn trắng của proxyserver.bot; tenant của key này phục vụ trên `gpnip.com`.
Lấy host từ bảng là trỏ khách sang tenant khác. Host đúng **chỉ** có trong
response của đơn.

**Sản phẩm không có `product` slug xác minh được.** Mobile USA, Shared ISP EU,
Premium Unlimited Residential: catalog của tài khoản này chỉ có 7 gói / 6
product (`ipv6-datacenter`, `ipv6-residential`, `mobile`, `datacenter` ×2,
`residential`, `residential-lite`), nên không biết khoá nào để tra. Đoán
`mobile-usa` rồi gắn cổng vào là đặt cược vào một chuỗi chưa ai thấy.
`isp` và `unlimited_residential` thì KHÔNG đoán: `GET /countries?product=` nhận
cả hai, nên slug đó tồn tại thật.

**Dải cổng.** Residential Pool 1–6 dùng 10000–10009 / 11000–11009, và Dedicated
ISP thay đổi theo từng IP. Một cặp số không mô tả nổi, nên bỏ hẳn khỏi bảng
code — những sản phẩm này buộc phải đọc cổng từ đơn.

### Chuẩn hoá khoá

API dùng lẫn gạch dưới và gạch ngang cho cùng một sản phẩm: gửi
`unlimited_residential` thì echo về `unlimited-residential`. `portsFor()` hạ
chữ thường và đổi `_` thành `-` trước khi tra, nên cả hai cách viết đều khớp.

### Ghi chú: omoproxy có thể là cùng một upstream

Hai key đầu tiên của GPNIP có tiền tố `omo_px_`, và `omoproxy.provider.ts` dùng
đúng hình dạng `port_http`/`port_socks`. Rất có thể cả hai là nhãn trắng của
proxyserver.bot. **Chưa áp bảng này cho omoproxy**: chưa có gì xác nhận tài
khoản đó dùng cùng bộ cổng. Lưu ý thêm, omoproxy không ném lỗi khi thiếu cổng —
nó lưu `port: 0`, tức là lỗi sẽ xuất hiện muộn hơn, ở phía khách.

## 2026-10-27 — ĐÃ GO-LIVE proxy tĩnh (30 ngày), kèm 3 phát hiện trên API thật

Key `gpnip_px_…b53e86` (tài khoản lemanh.laravel@gmail.com) đã verify chạy
hết luồng, kể cả một đơn MUA THẬT. Key cũ đang lưu (`…11ccc7`) đã CHẾT
(`401 Invalid API key`) — đã xoay partner `gpnip` sang key mới.

### 1) `/packages/{id}/stock` trả 500 cho cả 3 gói static
`proxy6-v3/v4/v6` → `500 {"code":"ERROR","message":"Cấu hình nhà cung cấp
không hợp lệ."}`, trong khi gói GB/time trả 200 kèm inventory. Đây là LỖI ĐỌC
tồn kho, KHÁC tín hiệu hết hàng (hết hàng là 200 kèm `available:false`). Bản cũ
để `request()` ném lỗi ở bước stock → chặn 100% đơn static. **Đã sửa**
`preflightBuy`: bọc try/catch quanh lệnh đọc `/stock`, đọc được thì soi như cũ,
đọc không được thì log cảnh báo và bỏ qua; chốt thật vẫn là `/check-price` +
khớp giá catalog. (Test: `gpnip.provider.spec.ts` → "tolerates a /stock endpoint
that errors for static packages".)

### 2) `/check-price` BỎ QUA `period` — luôn trả giá 30 ngày
Kiểm chứng mọi biến thể tham số (`period`/`duration`/`days`, string lẫn number):
proxy6-v6 luôn trả 0.39 (= giá 30 ngày), proxy6-v4 luôn 2.25. Tức là KHÔNG tin
được báo giá cho các mốc ≠ 30 ngày, và một đơn 3/7/14 ngày có nguy cơ bị tính
đúng giá 30 ngày. Chốt khớp giá static của adapter (so `list_price` với
`row.price × ips`) vì vậy CHỈ pass cho mốc 30 ngày — đây là hành vi ĐÚNG.
→ Hệ quả: **chỉ bán mốc 30 ngày** qua luồng tự động cho tới khi GPNIP sửa
check-price (hoặc chủ hệ thống chấp nhận rủi ro test xem `POST /orders` thật sự
tính tiền thế nào cho mốc ngắn). Dịch vụ đã bị thu về chỉ còn key `"30"`.

### 3) Gia hạn static chưa có định dạng `duration` hợp lệ
`POST /orders/{id}/renew` (preview) với `duration` = `30_days`/`30`/`1_month`/
`30d`/`3` đều `422 "Kỳ hạn gia hạn không hợp lệ."`; thiếu `duration` thì báo
thiếu field. Chưa dò ra giá trị hợp lệ → **để `allow_renew=false`** cho mọi dịch
vụ static. Đừng bật nút gia hạn khi nó luôn 422 (khách trả tiền rồi lỗi).

### Đơn MUA THẬT để xác minh cấp proxy (được chủ hệ thống đồng ý)
`provider_order_id=6ae013ae8506198e74a5aad4` — IPv6 US, 30 ngày, 1 IP, ~0.39
coin (số dư 8.17 → 7.78 USD). `pending → active (status 1)` trong ~6s. Đơn trả:
host `45.145.57.223`, `port_http=port_socks=10024` (cùng một cổng cho cả hai
giao thức), có user/pass, `expired_at` = +30 ngày. `fetchOrderProxies` dựng được
`ProxyCredential` sạch. **Cổng nằm trong response của đơn** nên proxy6-v6 KHÔNG
cần thêm vào `PRODUCT_PORTS`; `service.port_http/port_socks=0` là đúng. (Không
huỷ được: GPNIP không có API cancel; đơn tự hết hạn.)

### Trạng thái dịch vụ sau go-live
30 dịch vụ (`partner=gpnip`, 3 gói × 10 nước) đã:
- bỏ tiền tố `[DEMO]` trong tên, xoá `badge="DEMO"`;
- `pricing` chỉ còn mốc `"30"` (IPv4 riêng 56.250→85.000; IPv4 shared
  15.500→24.000; IPv6 riêng 9.750→15.000 — cost = coin×25.000, markup đã duyệt);
- `allow_renew=false`; `status=is_show=api_enabled=true` (đang hiển thị bán).
Script: `scripts/gpnip-static-go-live.cjs` (dry-run mặc định, `--apply` để ghi;
chỉ chạy trên Mongo local).

### CÒN LẠI (bắt buộc để bán được trong tiến trình đang chạy)
Backend đang chạy là `node dist/src/main.js` (PID cũ, khởi động 2026-10-26 trước
khi build bản sửa), nên `preflightBuy` trong tiến trình sống VẪN là code cũ và
sẽ chặn đơn static ở bước stock. **Phải restart backend** từ `dist` mới
(`npm run build` đã chạy). Worker không chạy `preflightBuy` nên không bắt buộc,
nhưng nên restart cho đồng bộ. Không có PM2/launcher còn sống — khởi động lại
thủ công.

## 2026-10-27 (bản 2) — GPNIP sửa dashboard: period chuyển sang `serviceOptions`

Chủ hệ thống cập nhật bên dashboard GPNIP. Gọi lại API thật thấy hợp đồng ĐỔI:

1. **`/stock`**: giờ trả `200 {supported:false, inventory:null, message:"Stock
   lookup is not supported for this service package..."}` thay vì 500. Adapter
   đã tolerant sẵn (try/catch + `supported:false`) nên không cần sửa thêm.
2. **`/check-price` KHÔNG nhận `period` top-level nữa** → `422: "Send the period
   in serviceOptions.period ... e.g. '3','7','14'"`. Khi gửi
   `serviceOptions.period`, giá trả về ĐÚNG theo từng mốc (v6: 3=0.06 7=0.11
   14=0.20 30=0.39 60=0.78 90=1.16; v4: 7=0.53 … 90=6.75; nhân theo ips). Tức là
   **bug period-insensitive đã được sửa** — bán được MỌI mốc, không chỉ 30 ngày.
3. **`POST /orders` cũng theo `serviceOptions`**: `serviceOptions.period` quyết
   định kỳ hạn/giá; `period` top-level bị bỏ qua (mặc định 30 ngày). Đơn thiếu
   `ips`/`country` sẽ fail và **tự hoàn tiền** (status 5 = `refunded`).

### Sửa adapter (serviceOptions)
`buildBuyBody`: với gói static (template có `period`), gói `country/period/ips`
vào `body.serviceOptions`, bỏ khỏi top-level; gói GB/per_ip giữ hình dạng phẳng
cũ. `preflightBuy`: đọc field static từ `body.serviceOptions`, và gọi
`/check-price` bằng `{ id, serviceOptions }` cho static. Test mới:
"posts static purchase fields under serviceOptions to /orders" +
"quotes static IP quantity and period..." đã cập nhật. 153/153 test pass.

### Xác minh bằng đơn THẬT
`6ae02033df0e10a13dd1c4b1` — IPv6 US, **3 ngày**, 1 IP, 0.06 coin. preflight OK,
active ~6s, `expired_at` = +3 ngày (ĐÚNG mốc, không còn bị ép về 30), proxy
`45.145.57.208:11191`. → serviceOptions điều khiển period đúng ở cả báo giá lẫn
đặt đơn.

### SỰ CỐ cần biết: 4 đơn tạo nhầm khi dò shape `/orders`
Khi dò hình dạng body của `/orders` bằng các request "thiếu field" (tưởng sẽ bị
422), hoá ra `/orders` KHÔNG validate chặt — nó điền mặc định và **tạo đơn thật**.
Hệ quả: 4 đơn `6ae01eccdf0e10a13dd1c47e` (packageId only → 30 ngày, **active**,
tốn 0.39), `…c481`/`…c484`/`…c487` (thiếu ips → **refunded**, không net trừ tiền).
Số dư 7.78 → 7.39 (−0.39). BÀI HỌC: `/orders` không có chế độ "preview/validate";
đừng gửi request thăm dò — chỉ gọi khi thực sự muốn đặt đơn.

### Trạng thái cuối
- Đã khôi phục ĐỦ mốc giá (giá bán duyệt sẵn, cost = coin×25.000):
  IPv4 riêng 7/14/30 (20k/39k/85k); IPv4 shared 7/14/30 (6k/11k/24k);
  IPv6 riêng 3/7/14/30 (3k/5k/8k/15k). Mốc 60/90 ngày GPNIP có bán nhưng CHƯA
  khai giá — thêm sau nếu muốn. Script: `scripts/gpnip-static-restore-tiers.cjs`.
- `allow_renew=false` (gia hạn vẫn `422` mọi định dạng — chưa dò ra, còn treo).
- Backend + worker đã restart lên bản có serviceOptions; public API trả đủ mốc.
