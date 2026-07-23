import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsString } from 'class-validator';

export class LookupProxiesDto {
  @IsArray()
  @ArrayNotEmpty({ message: 'Chưa nhập proxy nào' })
  @ArrayMaxSize(1000, { message: 'Tối đa 1000 dòng mỗi lần tra cứu' })
  @IsString({ each: true })
  lines: string[];
}
