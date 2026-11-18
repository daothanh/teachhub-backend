import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

const semver = z.string().regex(/^\d+\.\d+\.\d+$/);

export const appConfigResponseSchema = z
  .object({
    /** App dưới phiên bản này phải cập nhật mới dùng tiếp (Mục 5.1). */
    minSupportedVersion: z.object({ android: semver, ios: semver }),
  })
  .meta({
    example: { minSupportedVersion: { android: '0.0.0', ios: '0.0.0' } },
  });
export type AppConfigResponse = z.infer<typeof appConfigResponseSchema>;

// Ép cập nhật = sửa hằng số này và merge (CD dev tự triển khai). Endpoint công khai.
const APP_CONFIG: AppConfigResponse = {
  minSupportedVersion: { android: '0.0.0', ios: '0.0.0' },
};

@ApiTags('app-config')
@Controller('app-config')
export class AppConfigController {
  @Get()
  @ApiOkResponse({ standardSchema: appConfigResponseSchema })
  get(): AppConfigResponse {
    return APP_CONFIG;
  }
}
