import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { PartnersService } from './partners.service';
import { CreatePartnerDto } from '../dto/create-partner.dto';
import { PaginationQueryDto } from '../dto/pagination-query.dto';
import { AuthGuard } from '../guards/auth.guard';

@Controller('api/admin/partners')
@UseGuards(AuthGuard)
export class PartnersController {
  constructor(private readonly partnersService: PartnersService) {}

  @Get('list')
  findAllList(@Query('status') status?: string) {
    return this.partnersService.findAllList(status);
  }

  @Get()
  findAll(@Query() query: PaginationQueryDto) {
    return this.partnersService.findAllPaginated(query);
  }

  @Post()
  create(@Body() createPartnerDto: CreatePartnerDto) {
    return this.partnersService.create(createPartnerDto);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() updatePartnerDto: CreatePartnerDto) {
    return this.partnersService.update(id, updatePartnerDto);
  }

  @Post(':id/duplicate')
  duplicate(@Param('id') id: string) {
    return this.partnersService.duplicate(id);
  }

  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.partnersService.delete(id);
  }

  @Delete()
  deleteMany(@Body('ids') ids: string[]) {
    return this.partnersService.deleteMany(ids);
  }
}
