import { IsNotEmpty, IsString, Matches } from 'class-validator';

/**
 * Đổi mật khẩu proxy ở phía nhà cung cấp.
 *
 * Chỉ chặn những gì đúng với MỌI nhà cung cấp: là chuỗi, không rỗng, không
 * khoảng trắng hay ký tự điều khiển. Độ dài và bộ ký tự cụ thể là luật riêng
 * của từng adapter (GPNIP: 6–32, chữ và số) — nhét luật đó vào DTO dùng chung
 * là áp quy định của một nhà cung cấp lên tất cả những nhà cung cấp khác.
 */
export class ChangeProxyPasswordDto {
  @IsNotEmpty()
  @IsString()
  @Matches(/^\S{4,64}$/, {
    message: 'Mật khẩu phải 4–64 ký tự và không chứa khoảng trắng',
  })
  new_password: string;
}
