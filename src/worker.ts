import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  // createApplicationContext = không khởi tạo HTTP server
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ['log', 'warn', 'error', 'debug'],
  });

  // Thoát sạch khi nhận SIGTERM / SIGINT (Supervisor/PM2 gửi khi stop)
  app.enableShutdownHooks();
}

bootstrap();
