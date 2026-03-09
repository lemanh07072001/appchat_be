import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { UsersService } from './users.service';
import { CreateUserDto } from '../dto/create-user.dto';
import { AuthGuard } from '../guards/auth.guard';
import { AdminGuard } from '../guards/admin.guard';

@Controller('api/admin/users')
@UseGuards(AuthGuard, AdminGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  getList(
    @Query('page')   page   = '1',
    @Query('limit')  limit  = '10',
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('role')   role?: string,
  ) {
    return this.usersService.findAllPaginated(
      Number(page),
      Number(limit),
      search,
      status != null ? Number(status) : undefined,
      role != null ? Number(role) : undefined,
    );
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.usersService.findById(id);
  }

  @Post()
  create(@Body() createUserDto: CreateUserDto) {
    return this.usersService.create(createUserDto);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.usersService.update(id, body);
  }

  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.usersService.delete(id);
  }

  @Delete()
  deleteMany(@Body('ids') ids: string[]) {
    return this.usersService.deleteMany(ids);
  }

  // ─── Admin: nạp tiền cho user ─────────────────────────────────────────
  @Post(':id/deposit')
  deposit(
    @Param('id') id: string,
    @Body('amount') amount: number,
    @Body('note')   note?: string,
  ) {
    return this.usersService.deposit(id, amount, note);
  }
}
