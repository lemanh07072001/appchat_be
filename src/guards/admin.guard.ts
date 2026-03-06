import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { UserRoleEnum } from '../enum/user.enum';

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request['user'];
    if (user?.role !== UserRoleEnum.ADMIN) {
      throw new ForbiddenException('Chỉ admin mới có quyền truy cập');
    }
    return true;
  }
}
