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
    // BFF admin gọi `/v1/admin/**` bằng ba header này (Spec §5.2e); mỗi route admin yêu cầu cả ba.
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: 'x-admin-secret',
        description:
          'Secret server-to-server của BFF admin, xoay vòng định kỳ. Sai hoặc thiếu → 401 `UNAUTHENTICATED`.',
      },
      'adminSecret',
    )
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: 'x-admin-user-id',
        description:
          'Định danh nhân sự trên IAM Tasco. Bắt buộc, không rỗng; ghi vào `audit_logs`.',
      },
      'adminUserId',
    )
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: 'x-admin-permissions',
        description:
          'Đúng MỘT URI quyền mà BFF vừa kiểm cho thao tác này (không gửi cả danh sách quyền của nhân sự). ' +
          'Giá trị hợp lệ: `/teachhub/admin/bank-transfer`, `/teachhub/admin/legal-articles`, `/teachhub/admin/support`. ' +
          'Khác URI route yêu cầu (`x-admin-permission` của operation) → 403 `FORBIDDEN`.',
      },
      'adminPermissions',
    )
    .build();
  return SwaggerModule.createDocument(app, config, {
    // `AppConfigController.get` → `appConfig_get`: tên ổn định cho mã sinh ở web/app.
    operationIdFactory: (controller, method) =>
      `${controller[0]?.toLowerCase()}${controller.slice(1).replace(/Controller$/, '')}_${method}`,
  });
}
