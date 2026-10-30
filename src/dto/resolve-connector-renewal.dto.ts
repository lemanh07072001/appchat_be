import { IsIn, IsString, Length } from 'class-validator';

/**
 * Chốt một lượt gia hạn Connector đang treo. Người vận hành phải khai đã xác minh gì ở nhà cung
 * cấp: không có "đoán", và bằng chứng được lưu cùng đơn.
 */
export class ResolveConnectorRenewalDto {
  @IsIn(['extended', 'not-extended'])
  outcome: 'extended' | 'not-extended';

  @IsString()
  @Length(10, 500)
  evidence: string;
}
