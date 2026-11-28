import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { type Env, validateEnv } from './config.js';
import { reqLogSerializer } from './log-serializer.js';

/** Cấu hình (zod) + log JSON (pino) dùng chung cho `api` và `worker`. */
@Module({
  imports: [
    // Chỉ đọc process.env: lệnh chạy tự nạp .env bằng --env-file, production nhận env từ Compose.
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      ignoreEnvFile: true,
      validate: validateEnv,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL'),
          serializers: { req: reqLogSerializer },
          transport:
            config.get('NODE_ENV') === 'local'
              ? { target: 'pino-pretty' }
              : undefined,
          // Không log token, cookie; body request không được log (Mục 6.6).
          redact: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.headers["x-admin-secret"]',
            'res.headers.location', // Deep link Apple Android chứa mã dùng một lần.
          ],
        },
      }),
    }),
  ],
})
export class CoreModule {}
