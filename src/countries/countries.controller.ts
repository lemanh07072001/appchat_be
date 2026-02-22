import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { CountriesService } from './countries.service';
import { CreateCountryDto } from '../dto/create-country.dto';
import { PaginationQueryDto } from '../dto/pagination-query.dto';
import { AuthGuard } from '../guards/auth.guard';
import { Public } from '../guards/public.decorator';

@Controller()
@UseGuards(AuthGuard)
export class CountriesController {
  constructor(private readonly countriesService: CountriesService) {}

  @Get('api/admin/countries/list')
  findAllList() {
    return this.countriesService.findAllList();
  }

  @Get('api/admin/countries')
  findAll(@Query() query: PaginationQueryDto) {
    return this.countriesService.findAllPaginated(query);
  }

  @Post('api/admin/countries/:id/duplicate')
  duplicate(@Param('id') id: string) {
    return this.countriesService.duplicate(id);
  }

  @Put('api/admin/countries/:id')
  update(@Param('id') id: string, @Body() updateCountryDto: CreateCountryDto) {
    return this.countriesService.update(id, updateCountryDto);
  }

  @Delete('api/admin/countries/:id')
  delete(@Param('id') id: string) {
    return this.countriesService.delete(id);
  }

  @Delete('api/admin/countries')
  deleteMany(@Body('ids') ids: string[]) {
    return this.countriesService.deleteMany(ids);
  }

  @Post('api/admin/countries')
  create(@Body() createCountryDto: CreateCountryDto) {
    return this.countriesService.create(createCountryDto);
  }
}
