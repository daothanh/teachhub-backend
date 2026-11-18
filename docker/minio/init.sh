#!/bin/sh
# Dựng bucket MinIO giống R2 (Mục 2.8): bucket private/public, quyền đọc, lifecycle theo prefix. Chạy lại nhiều lần được (idempotent).
# Local: service `minio-init` trong docker-compose.yml. VM dev: cùng service, khác biến.
set -eu

: "${MC_HOST_local:?Cần MC_HOST_local=http://USER:PASS@HOST:9000}"
PRIVATE="${S3_BUCKET_PRIVATE:-teachhub-local-private}"
PUBLIC="${S3_BUCKET_PUBLIC:-teachhub-local-public}"

mc mb --ignore-existing "local/$PRIVATE" "local/$PUBLIC"

# Bucket public chỉ cho đọc ẩn danh (PDF Mẫu 02 công khai); private chỉ qua presigned URL.
mc anonymous set download "local/$PUBLIC"
mc anonymous set none "local/$PRIVATE"

# CORS: MinIO không hỗ trợ CORS theo bucket (NotImplemented) — đặt ở cấp server bằng
# MINIO_API_CORS_ALLOW_ORIGIN trong docker-compose.yml. R2 đặt theo bucket bằng Terraform.

# Lifecycle: exports/ xóa sau 7 ngày, imports/ sau 1 ngày. Xóa rule cũ trước để chạy lại không nhân đôi.
mc ilm rule rm --all --force "local/$PRIVATE" >/dev/null 2>&1 || true
mc ilm rule add --prefix exports/ --expire-days 7 "local/$PRIVATE"
mc ilm rule add --prefix imports/ --expire-days 1 "local/$PRIVATE"

echo "MinIO sẵn sàng: $PRIVATE (private), $PUBLIC (public)"
