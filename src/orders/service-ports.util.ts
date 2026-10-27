/**
 * Cổng gateway do admin khai ở dịch vụ của đơn.
 *
 * Vì sao cần, thay vì chỉ đọc cổng nhà cung cấp trả về:
 *   - `/packages` CÓ field `ports` nhưng trả `null` (kiểm chứng GPNIP
 *     2026-10-20), nên không đọc được cổng từ danh mục.
 *   - Response của đơn có thể thiếu `port_socks` — lúc đó khách mất hẳn SOCKS5.
 *   - Có sản phẩm dùng cả một DẢI cổng (Residential Pool 10000–10009); nhà cung
 *     cấp trả cổng nào cũng chỉ là một cổng trong dải, chỉ admin biết nên dùng
 *     cổng nào.
 *
 * Đọc SỐNG từ dịch vụ, không snapshot vào `order.config`: cổng là thuộc tính hạ
 * tầng của sản phẩm, nhà cung cấp đổi cổng thì mọi đơn đang chạy phải đổi theo.
 * Snapshot là để lại một loạt đơn trỏ vào cổng đã chết.
 *
 * Dùng `order.$model('Service')` chứ không inject model: hàm này gọi từ cả
 * worker, scheduler recovery và OrdersService, mà scheduler không có
 * `serviceModel` — thêm DI vào đó chỉ để đọc hai con số là mở rộng không cần
 * thiết. Và KHÔNG `order.populate()`: populate ghi đè `order.service_id`, mà
 * có caller đọc `service_id.name` sau đó.
 *
 * Trả `undefined` khi admin chưa khai gì — caller giữ nguyên hành vi cũ.
 */
export async function resolveServicePorts(
  order: {
    service_id?: unknown;
    $model?: (name: string) => any;
  } | null,
): Promise<{ http: number; socks: number } | undefined> {
  const ref: any = order?.service_id;
  if (!ref) return undefined;

  // `service_id` có thể đã là document dịch vụ (caller populate trước), hoặc
  // chỉ là ObjectId.
  let svc: any = ref;

  if (typeof ref.port_http !== 'number' && typeof ref.port_socks !== 'number') {
    if (typeof order?.$model !== 'function') return undefined;
    try {
      svc = await order
        .$model('Service')
        .findById(ref._id ?? ref)
        .select('port_http port_socks')
        .lean()
        .exec();
    } catch {
      // Đọc cổng là phần bù: lỗi ở đây không được làm gãy việc cấp đơn.
      return undefined;
    }
  }

  const http = Number(svc?.port_http) || 0;
  const socks = Number(svc?.port_socks) || 0;
  if (!http && !socks) return undefined;
  return { http, socks };
}
