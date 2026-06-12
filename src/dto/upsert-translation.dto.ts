import { IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';

export class UpsertTranslationDto {
  @IsOptional()
  @IsString()
  locale?: string;

  @IsNotEmpty()
  @IsObject()
  fields: Record<string, any>;
}
