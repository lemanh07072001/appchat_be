import { IsMongoId, IsNotEmpty, IsNumber, Min } from 'class-validator';

/**
 * Báo giá cho dịch vụ bán theo GB. Không tạo đơn, không trừ tiền — chỉ trả về
 * số tiền server sẽ tính nếu khách bấm mua với đúng `gb` này.
 */
export class QuoteBandwidthDto {
  @IsNotEmpty()
  @IsMongoId()
  service_id: string;

  @IsNotEmpty()
  @IsNumber()
  @Min(1)
  gb: number;
}
