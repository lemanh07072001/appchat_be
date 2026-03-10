import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { UploadController } from './upload.controller';
import { UploadService } from './upload.service';

@Module({
  imports: [JwtModule],
  controllers: [UploadController],
  providers: [UploadService],
})
export class UploadModule {}
