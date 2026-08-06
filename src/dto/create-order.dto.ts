import {
  IsBoolean,
  IsEnum,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Min,
  ValidateIf,
} from 'class-validator';
import { ProxyTypeEnum, PaymentMethodEnum } from '../enum/order.enum';

export class CreateOrderDto {
  @IsNotEmpty()
  @IsMongoId()
  user_id: string;

  @IsNotEmpty()
  @IsMongoId()
  service_id: string;

  @IsOptional()
  @IsMongoId()
  partner_id?: string;

  @IsOptional()
  @IsMongoId()
  country_id?: string;

  @IsNotEmpty()
  @IsEnum(ProxyTypeEnum)
  proxy_type: ProxyTypeEnum;

  @IsOptional()
  @IsNumber()
  @Min(1)
  quantity?: number;

  /** Bắt buộc với đơn bán theo thời hạn; đơn bán theo GB có thể không giới hạn ngày. */
  @ValidateIf((o: CreateOrderDto) => !o.bandwidth_gb)
  @IsNotEmpty()
  @IsNumber()
  @Min(1)
  duration_days: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  bandwidth_gb?: number;

  @IsNotEmpty()
  @IsNumber()
  price_per_unit: number;

  @IsOptional()
  @IsNumber()
  cost_per_unit?: number;

  @IsOptional()
  @IsNumber()
  discount_amount?: number;

  @IsNotEmpty()
  @IsNumber()
  total_price: number;

  @IsOptional()
  @IsNumber()
  total_cost?: number;

  @IsOptional()
  @IsEnum(PaymentMethodEnum)
  payment_method?: PaymentMethodEnum;

  @IsOptional()
  @IsObject()
  credentials?: {
    host?: string;
    port?: number;
    username?: string;
    password?: string;
  };

  @IsOptional()
  @IsObject()
  config?: Record<string, any>;

  @IsOptional()
  @IsString()
  provider_order_id?: string;

  @IsOptional()
  @IsBoolean()
  auto_renew?: boolean;

  @IsOptional()
  @IsString()
  admin_note?: string;
}
