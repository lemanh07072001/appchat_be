import { IsBoolean, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';
import { CountryConfigDto } from '../countries/country-policy';

export class CreatePartnerDto extends CountryConfigDto {
  @IsOptional() @IsIn(['manual', 'api', 'none'])
  country_source?: 'manual' | 'api' | 'none';
  @IsNotEmpty()
  @IsString()
  name: string;

  @IsOptional()
  @IsBoolean()
  status?: boolean;

  @IsOptional()
  @IsString()
  token_api?: string;

  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsNumber()
  order?: number;
}
