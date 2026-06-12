import { Body, Controller, Get, Param, Put, Query, UseGuards } from '@nestjs/common';
import { TranslationsService } from './translations.service';
import { UpsertTranslationDto } from '../dto/upsert-translation.dto';
import { AuthGuard } from '../guards/auth.guard';
import { AdminGuard } from '../guards/admin.guard';

@Controller()
@UseGuards(AuthGuard)
export class TranslationsController {
  constructor(private readonly translationsService: TranslationsService) {}

  @Get('api/admin/translations/:entityType/:entityId')
  @UseGuards(AdminGuard)
  findOne(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @Query('locale') locale?: string,
  ) {
    return this.translationsService.findOne(entityType, entityId, locale || 'en');
  }

  @Put('api/admin/translations/:entityType/:entityId')
  @UseGuards(AdminGuard)
  upsert(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @Body() dto: UpsertTranslationDto,
  ) {
    return this.translationsService.upsert(entityType, entityId, dto.fields, dto.locale || 'en');
  }
}
