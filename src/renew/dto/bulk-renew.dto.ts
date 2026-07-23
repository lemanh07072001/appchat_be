import { ArrayNotEmpty, IsArray, IsInt, IsMongoId, Min } from 'class-validator';

export class BulkRenewDto {
  @IsArray()
  @ArrayNotEmpty({ message: 'Chưa chọn proxy nào để gia hạn' })
  @IsMongoId({ each: true, message: 'proxy_ids chứa id không hợp lệ' })
  proxy_ids: string[];

  @IsInt({ message: 'duration_days phải là số nguyên' })
  @Min(1, { message: 'duration_days phải >= 1' })
  duration_days: number;
}
