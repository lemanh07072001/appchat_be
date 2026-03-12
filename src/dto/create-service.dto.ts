import { IsArray, IsBoolean, IsMongoId, IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';

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

  @IsOptional()
  @IsObject()
  note?: Record<string, string>;

  @IsOptional()
  @IsArray()
  isp?: { name: string; code: string }[];

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
  @IsString()
  id_service?: string;

  @IsOptional()
  @IsObject()
  pricing?: Record<string, any>;

  @IsOptional()
  @IsString()
  badge?: string;

  @IsOptional()
  @IsObject()
  duration_ids?: Record<string, string>;
}
