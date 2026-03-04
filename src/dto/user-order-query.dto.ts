import { IsEnum, IsOptional, IsPositive, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { OrderStatusEnum } from '../enum/order.enum';

export class UserOrderQueryDto {
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
  @Type(() => Number)
  @IsEnum(OrderStatusEnum)
  status?: OrderStatusEnum;
}
