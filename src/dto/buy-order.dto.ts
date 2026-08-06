import { IsEnum, IsMongoId, IsNotEmpty, IsNumber, IsOptional, IsString, Min, Max, ValidateIf } from 'class-validator';
import { ProxyProtocolEnum } from '../enum/order.enum';

export class BuyOrderDto {
  @IsNotEmpty()
  @IsMongoId()
  service_id: string;

  /**
   * Mã gói dung lượng — chỉ dùng với service `pricing_mode: 'bandwidth'`.
   * Là key trong `service.pricing`, ví dụ "50" cho gói 50GB.
   * Có `package_key` thì không cần `duration_days` (số ngày nằm trong gói).
   */
  @IsOptional()
  @IsString()
  package_key?: string;

  /**
   * Số GB khách tự nhập — chỉ dùng với service `pricing_mode: 'bandwidth'` đã
   * cấu hình `bandwidth_tiers`. Backend tự tra bậc giá; client KHÔNG gửi tiền.
   * Gửi `gb` thì không cần `package_key` lẫn `duration_days`.
   */
  @IsOptional()
  @IsNumber()
  @Min(1)
  gb?: number;

  /**
   * Bắt buộc với service bán theo thời hạn; bỏ qua khi đã có `package_key` hoặc `gb`.
   */
  @ValidateIf((o: BuyOrderDto) => !o.package_key && !o.gb)
  @IsNotEmpty()
  @IsNumber()
  @Min(1)
  duration_days: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  quantity?: number;

  // Có thể gửi ObjectId hoặc tên quốc gia ("Vietnam")
  @IsOptional()
  @IsString()
  country?: string;

  // Protocol: "http", "https", "socks5"
  @IsOptional()
  @IsEnum(ProxyProtocolEnum)
  protocol?: ProxyProtocolEnum;

  // ISP: "viettel", "fpt", ...
  @IsOptional()
  @IsString()
  isp?: string;

  // Loại proxy dạng display: "Datacenter", "Residential", ...
  @IsOptional()
  @IsString()
  proxy_type?: string;

  // Thời gian xoay IP (phút) — chỉ dùng cho proxy xoay, 0 = không xoay
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1440)
  rotate_interval?: number;

  // Username/password tự chọn — nếu không gửi thì backend tự random
  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsString()
  password?: string;
}
