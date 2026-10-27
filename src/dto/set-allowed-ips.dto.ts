import { ArrayMaxSize, IsArray, IsIP } from 'class-validator';

/**
 * Whitelist IP được phép dùng proxy của đơn.
 *
 * Mảng rỗng là hợp lệ — đó là cách xoá whitelist, quay về xác thực user/pass.
 * `ArrayMaxSize` ở đây chỉ để chặn payload khổng lồ; giới hạn thật (GPNIP: 10)
 * do adapter quyết, vì mỗi nhà cung cấp một mức.
 */
export class SetAllowedIpsDto {
  @IsArray()
  @ArrayMaxSize(50)
  @IsIP(undefined, { each: true })
  allowed_ips: string[];
}
