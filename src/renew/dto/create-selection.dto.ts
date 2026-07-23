import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateSelectionDto {
  @IsString()
  @IsNotEmpty({ message: 'Tên bộ không được để trống' })
  @MaxLength(60, { message: 'Tên bộ tối đa 60 ký tự' })
  name: string;

  @IsArray()
  @ArrayNotEmpty({ message: 'Bộ phải có ít nhất 1 proxy' })
  @IsMongoId({ each: true })
  proxy_ids: string[];

  @IsInt()
  @Min(1)
  duration_days: number;
}
