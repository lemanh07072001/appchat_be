import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

/**
 * Kiểm tra API key của một nhà cung cấp trước khi lưu.
 *
 * Nhận `code` + `token_api` thẳng từ form chứ không nhận id bản ghi — mục đích
 * là xác thực key admin VỪA GÕ, kể cả khi nhà cung cấp chưa tồn tại.
 */
export class CheckProviderConnectionDto {
  /** Code adapter, phải có trong registry */
  @IsNotEmpty()
  @IsString()
  code: string;

  /**
   * Để trống khi sửa nhà cung cấp đã có mà admin không đổi key — backend sẽ
   * dùng key đang lưu của `partner_id`.
   */
  @IsOptional()
  @IsString()
  token_api?: string;

  @IsOptional()
  @IsString()
  partner_id?: string;
}
