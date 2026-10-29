import { ArrayMaxSize, ArrayUnique, IsArray, IsBoolean, IsIn, IsInt, IsMongoId, IsNotEmpty, IsNumber, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

/** Explicit per-service display name and provider API code. */
export class ServiceIspDto {
  @IsString()
  @MaxLength(128)
  @Matches(/^[^\s\x00-\x1f\x7f](?:[^\x00-\x1f\x7f]*[^\s\x00-\x1f\x7f])?$/)
  name: string;

  @IsString()
  @MaxLength(128)
  @Matches(/^[^\s\x00-\x1f\x7f](?:[^\x00-\x1f\x7f]*[^\s\x00-\x1f\x7f])?$/)
  code: string;
}

/** Một bậc trong bảng giá theo GB. */
export class BandwidthTierDto {
  @IsNumber()
  @Min(1)
  min_gb: number;

  @IsNumber()
  @Min(0)
  price_per_gb: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  cost_per_gb?: number;

  /** Hạn dùng của bậc; 0 = không giới hạn thời gian */
  @IsOptional()
  @IsNumber()
  @Min(0)
  days?: number;
}

export class CreateServiceDto {
  @IsNotEmpty()
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @IsBoolean()
  status?: boolean;

  @IsOptional()
  @IsString()
  proxy_type?: string;

  @IsOptional()
  @IsString()
  ip_version?: string;

  @IsOptional()
  @IsMongoId()
  partner?: string;

  @IsOptional()
  @IsMongoId()
  country?: string;

  @IsOptional()
  @IsString()
  body_api?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  protocol?: string[];

  /**
   * Cổng gateway admin tự khai. 0 = chưa khai (dùng cổng nhà cung cấp trả về).
   *
   * Cho phép 0 chứ không `@Min(1)`: admin phải xoá được giá trị đã khai để
   * quay về cổng nhà cung cấp, mà form gửi 0 chứ không gửi `undefined`.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(65535)
  port_http?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(65535)
  port_socks?: number;

  @IsOptional()
  @IsObject()
  note?: Record<string, string>;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ArrayUnique((item: ServiceIspDto) => item?.code)
  @ValidateNested({ each: true })
  @Type(() => ServiceIspDto)
  isp?: ServiceIspDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ArrayUnique((item: ServiceIspDto) => item?.code)
  @ValidateNested({ each: true })
  @Type(() => ServiceIspDto)
  country_choices?: ServiceIspDto[];

  @IsOptional()
  @IsString()
  usage_type?: string;

  @IsOptional()
  @IsBoolean()
  is_show?: boolean;

  @IsOptional()
  @IsBoolean()
  api_enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  show_user_pass?: boolean;

  @IsOptional()
  @IsBoolean()
  allow_renew?: boolean;

  @IsOptional()
  @IsString()
  id_service?: string;

  /** 'duration' (bán theo thời hạn) | 'bandwidth' (bán theo GB) */
  @IsOptional()
  @IsIn(['duration', 'bandwidth'])
  pricing_mode?: string;

  @IsOptional()
  @IsObject()
  pricing?: Record<string, any>;

  /**
   * Bậc giá theo GB. Chỉ khai `min_gb`; trần của một bậc là `min_gb` của bậc kế
   * tiếp nên bảng không thể hở hay chồng lấn.
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BandwidthTierDto)
  bandwidth_tiers?: BandwidthTierDto[];

  @IsOptional()
  @IsNumber()
  @Min(1)
  bandwidth_max_gb?: number;

  @IsOptional()
  @IsNumber()
  min_quantity?: number;

  @IsOptional()
  @IsNumber()
  max_quantity?: number;

  @IsOptional()
  @IsString()
  badge?: string;

  @IsOptional()
  @IsObject()
  duration_ids?: Record<string, string>;

  @IsOptional()
  @IsObject()
  user_discounts?: Record<string, Record<string, number>>;

  @IsOptional()
  @IsNumber()
  order?: number;
}
