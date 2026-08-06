import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { PartnersService } from './partners.service';
import { ProxyProviderFactory } from '../proxy-providers/proxy-provider.factory';
import { CreatePartnerDto } from '../dto/create-partner.dto';
import { CheckProviderConnectionDto } from '../dto/check-provider-connection.dto';
import { PaginationQueryDto } from '../dto/pagination-query.dto';
import { AuthGuard } from '../guards/auth.guard';
import { AdminGuard } from '../guards/admin.guard';

@Controller('api/admin/partners')
@UseGuards(AuthGuard, AdminGuard)
export class PartnersController {
  constructor(
    private readonly partnersService: PartnersService,
    private readonly providerFactory: ProxyProviderFactory,
  ) {}

  /**
   * Danh sách adapter có thật trong code, kèm năng lực từng cái.
   *
   * Màn hình nhà cung cấp dùng danh sách này cho ô chọn adapter, thay vì để
   * admin gõ tự do một `code` mà backend không có.
   */
  @Get('providers')
  listProviders() {
    return this.providerFactory.listProviders();
  }

  /**
   * Gọi thật sang API nhà cung cấp để xác thực key trước khi lưu.
   * Trả `{ ok: false }` khi key sai — đó là kết quả, không phải sự cố.
   */
  @Post('check-connection')
  checkConnection(@Body() dto: CheckProviderConnectionDto) {
    return this.partnersService.checkProviderConnection(this.providerFactory, dto);
  }

  /**
   * Kiểm tra hàng loạt, theo yêu cầu của admin. Không gắn vào lúc mở trang vì
   * mỗi lần là một lượt gọi ra ngoài cho từng nhà cung cấp.
   */
  @Post('health')
  checkAll(@Body('ids') ids?: string[]) {
    return this.partnersService.checkAllConnections(this.providerFactory, ids);
  }

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
