import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/**
 * Hợp đồng OpenAPI 3.1 sinh từ schema zod gắn trên controller (`@Body({ schema })`,
 * `@ApiOkResponse({ standardSchema })`). NestJS 12 + @nestjs/swagger 12 đọc Standard Schema trực tiếp —
 * không cần nestjs-zod (chưa hỗ trợ NestJS 12) hay zod-openapi (ADR-TH-BE-001 §7).
 */
export function buildOpenApiDocument(app: INestApplication) {
  const config = new DocumentBuilder()
    .setOpenAPIVersion('3.1.0')
    .setTitle('TeachHub API')
    .setVersion('1')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
    .build();
  return SwaggerModule.createDocument(app, config, {
    // `AppConfigController.get` → `appConfig_get`: tên ổn định cho mã sinh ở web/app.
    operationIdFactory: (controller, method) =>
      `${controller[0]?.toLowerCase()}${controller.slice(1).replace(/Controller$/, '')}_${method}`,
  });
}
