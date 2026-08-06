import { IsNotEmpty, IsNumber, Min } from 'class-validator';

/**
 * Nạp thêm dung lượng vào đơn đang chạy.
 *
 * Chỉ có số GB — giá do server tra từ bảng bậc hiện hành của dịch vụ, và ngày
 * hết hạn của đơn không đổi (muốn kéo dài thời gian thì dùng gia hạn).
 */
export class TopUpBandwidthDto {
  @IsNotEmpty()
  @IsNumber()
  @Min(1)
  gb: number;
}
