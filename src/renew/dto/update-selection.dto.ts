import {
  IsArray,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class UpdateSelectionDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'Tên bộ không được để trống' })
  @MaxLength(60, { message: 'Tên bộ tối đa 60 ký tự' })
  name?: string;

  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  proxy_ids?: string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  duration_days?: number;
}
