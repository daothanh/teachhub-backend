import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'isPublic';

/** Route không cần access token (JwtAuthGuard toàn cục bỏ qua). Mặc định mọi route đều cần. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
