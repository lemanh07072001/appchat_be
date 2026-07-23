import {
  IsArray,
  IsBoolean,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class UpdateSelectionDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'Tên bộ không được để trống' })
  @MaxLength(60, { message: 'Tên bộ tối đa 60 ký tự' })
  name?: string;

  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  proxy_ids?: string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  duration_days?: number;

  /** Bật/tắt lịch tự gia hạn (chỉ áp dụng cho bộ đặt tên) */
  @IsOptional()
  @IsBoolean()
  auto_renew_enabled?: boolean;

  /** Tự gia hạn khi còn <= N ngày */
  @IsOptional()
  @IsInt()
  @Min(1, { message: 'threshold_days phải từ 1 đến 30' })
  @Max(30, { message: 'threshold_days phải từ 1 đến 30' })
  threshold_days?: number;
}
