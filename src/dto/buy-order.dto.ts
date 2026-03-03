import { IsEnum, IsMongoId, IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { ProxyProtocolEnum } from '../enum/order.enum';

export class BuyOrderDto {
  @IsNotEmpty()
  @IsMongoId()
  service_id: string;

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
}
