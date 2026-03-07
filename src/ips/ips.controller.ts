import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { IpsService } from './ips.service';
import { CreateIpDto } from '../dto/create-ip.dto';
import { PaginationQueryDto } from '../dto/pagination-query.dto';
import { AuthGuard } from '../guards/auth.guard';

@Controller('api/admin/ips')
@UseGuards(AuthGuard)
export class IpsController {
  constructor(private readonly ipsService: IpsService) {}

  @Get('list')
  findAllList(@Query('status') status?: string) {
    return this.ipsService.findAllList(status);
  }

  @Get()
  findAll(@Query() query: PaginationQueryDto) {
    return this.ipsService.findAllPaginated(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.ipsService.findOne(id);
  }

  @Post()
  create(@Body() createIpDto: CreateIpDto) {
    return this.ipsService.create(createIpDto);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() updateIpDto: CreateIpDto) {
    return this.ipsService.update(id, updateIpDto);
  }

  @Post(':id/duplicate')
  duplicate(@Param('id') id: string) {
    return this.ipsService.duplicate(id);
  }

  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.ipsService.delete(id);
  }

  @Delete()
  deleteMany(@Body('ids') ids: string[]) {
    return this.ipsService.deleteMany(ids);
  }
}
