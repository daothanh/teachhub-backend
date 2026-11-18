# Hạ tầng (S0-OPS-01)

Một VM development ở Hetzner `sin` chạy `api`, `worker`, PostgreSQL, Redis, MinIO và Mailpit bằng Docker Compose. Phía trước là Caddy, dùng chứng chỉ Cloudflare Origin CA. Luồng truy cập: Cloudflare (Full strict) → cổng 443 chỉ nhận dải IP Cloudflare → Caddy → `api`.

| Thư mục | Nội dung |
| --- | --- |
| `terraform/dev` | VM, Private Network `10.0.0.0/16`, Firewall, bản ghi DNS, chế độ SSL của zone, chứng chỉ origin, các bí mật (mật khẩu DB/MinIO, khóa JWT) |
| `terraform/r25-probe` | Thử tạo các loại máy production ở `sin` rồi xóa ngay (R25) |
| `ansible` | Cài Docker và dựng stack trên VM (`dev.yml`) |

Tên miền dev chỉ có **một cấp** dưới zone (`api-dev.`, `app-dev.`, `admin-dev.dayhoc.app`) vì Universal SSL của Cloudflare không phủ tên hai cấp như `api.dev.dayhoc.app`.

## Cần chuẩn bị

- [OpenTofu](https://opentofu.org) ≥ 1.8 hoặc Terraform, và `uv` (để chạy Ansible bằng `uvx`).
- `HCLOUD_TOKEN`: token của project Hetzner, quyền **Read & Write**.
- `CLOUDFLARE_API_TOKEN`: token giới hạn cho zone `dayhoc.app`, gồm các quyền Zone → **Zone: Read**, **DNS: Edit**, **Zone Settings: Edit**, **SSL and Certificates: Edit**.
- GitHub PAT (classic) có quyền `read:packages`, vì image `ghcr.io/daothanh/teachhub-backend` đang private.

## Dựng VM dev

```bash
export HCLOUD_TOKEN=... CLOUDFLARE_API_TOKEN=...
cd infra/terraform/dev
cp terraform.tfvars.example terraform.tfvars   # điền khóa SSH và IP admin
tofu init && tofu apply
tofu output -json ansible_vars > ../../ansible/dev-vars.json

cd ../../ansible
uvx --from ansible-core ansible-playbook -i "$(tofu -chdir=../terraform/dev output -raw server_ipv4)," -u root dev.yml \
  -e @dev-vars.json -e ghcr_user=<github-user> -e ghcr_token=<PAT>

curl -s https://api-dev.dayhoc.app/health/ready   # {"status":"ok",...}
```

Playbook chạy lại được nhiều lần. Mỗi lần chạy, nó kéo image `main` mới nhất và chờ `/health/ready` trả OK. Deploy tự động khi merge thuộc S0-OPS-02.

Xem email OTP trong Mailpit: `ssh -L 8025:127.0.0.1:8025 root@<IP>`, rồi mở `http://localhost:8025`.

## R25: thử hạn mức tạo máy

```bash
cd infra/terraform/r25-probe && tofu init
tofu plan                            # output types_in_location: loại máy có ở sin
tofu apply   -var create=true        # tạo mỗi loại 1 máy (tính tiền theo giờ)
tofu destroy -var create=true        # xóa ngay, rồi ghi kết quả vào issue R25
```

## Lưu ý

- State Terraform lưu ở local và **chứa bí mật**: mật khẩu DB, khóa origin, khóa JWT. Không commit, không chia sẻ. Khi làm staging thì chuyển state sang backend S3 trên R2.
- `cloudflare_zone_setting` áp dụng cho cả zone: SSL Full (strict), Always Use HTTPS, TLS ≥ 1.2.
- Muốn đổi IP được SSH thì sửa `admin_ssh_cidrs` rồi chạy `tofu apply`. Cổng 22 không bao giờ mở cho toàn Internet.
- MinIO chưa mở ra Internet. Khi client cần upload thẳng bằng presigned URL ở môi trường dev thì phải thêm một hostname riêng cho MinIO.
