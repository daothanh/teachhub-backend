import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { WorkerModule } from './worker.module.js';

// Không mở HTTP: worker chỉ tiêu thụ hàng đợi và chạy lịch.
const app = await NestFactory.createApplicationContext(WorkerModule, {
  bufferLogs: true,
});
app.useLogger(app.get(Logger));
app.enableShutdownHooks();
app.get(Logger).log('worker đã khởi động');
