import { IsInt, Max, Min } from 'class-validator';

/** Gia hạn cả đơn Connector: số ngày phải là mốc dịch vụ đang bán, giá do server tính. */
export class RenewConnectorOrderDto {
  @IsInt()
  @Min(1)
  @Max(3650)
  duration_days: number;
}
