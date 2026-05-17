import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateCountryDto {
  @IsNotEmpty()
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  code: string;

  @IsOptional()
  @IsString()
  image_url?: string;
}
