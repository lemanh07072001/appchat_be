import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ServicesService } from './services.service';
import { CreateServiceDto } from '../dto/create-service.dto';
import { PaginationQueryDto } from '../dto/pagination-query.dto';
import { AuthGuard } from '../guards/auth.guard';
import { Public } from '../guards/public.decorator';

@Controller()
@UseGuards(AuthGuard)
export class ServicesController {
  constructor(private readonly servicesService: ServicesService) {}

  @Public()
  @Get('api/services')
  findPublicList(@Query('type') type?: string, @Query('ip_version') ip_version?: string) {
    return this.servicesService.findPublicList(type, ip_version);
  }

  @Get('api/admin/services')
  findAll(@Query() query: PaginationQueryDto) {
    return this.servicesService.findAllPaginated(query);
  }

  @Post('api/admin/services')
  create(@Body() createServiceDto: CreateServiceDto) {
    return this.servicesService.create(createServiceDto);
  }

  @Put('api/admin/services/:id')
  update(@Param('id') id: string, @Body() updateServiceDto: CreateServiceDto) {
    return this.servicesService.update(id, updateServiceDto);
  }

  @Post('api/admin/services/:id/duplicate')
  duplicate(@Param('id') id: string) {
    return this.servicesService.duplicate(id);
  }

  @Delete('api/admin/services/:id')
  delete(@Param('id') id: string) {
    return this.servicesService.delete(id);
  }

  @Delete('api/admin/services')
  deleteMany(@Body('ids') ids: string[]) {
    return this.servicesService.deleteMany(ids);
  }
}
