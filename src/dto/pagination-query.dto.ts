import { IsOptional, IsPositive, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsPositive()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsPositive()
  @Min(1)
  limit?: number = 10;

  @IsOptional()
  @IsString()
  search?: string = '';

  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @IsString()
  ip_version?: string;

  @IsOptional()
  @IsString()
  proxy_type?: string;

  @IsOptional()
  @IsString()
  status?: string; // "true" | "false"

  @IsOptional()
  @IsString()
  badge?: string;

  @IsOptional()
  @IsString()
  partner_id?: string;

  @IsOptional()
  @IsString()
  order_type?: string;

  @IsOptional()
  @IsString()
  date_range?: string;

  @IsOptional()
  @IsString()
  order_status?: string;
}
