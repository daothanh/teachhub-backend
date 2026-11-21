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

Playbook chạy lại được nhiều lần. Mỗi lần chạy, nó kéo image `main` mới nhất và chờ `/health/ready` trả OK. Deploy tự động khi merge xem mục CD bên dưới.

Xem email OTP trong Mailpit: `ssh -L 8025:127.0.0.1:8025 root@<IP>`, rồi mở `http://localhost:8025`.

## CD development (S0-OPS-02)

Merge vào `main` → `image` build + đẩy GHCR (`sha-<40 hex>`, `main`) → `deploy-dev` (workflow_run, chỉ khi build thành công; hoặc chạy tay với input `tag`) → runner vào tailnet → SSH `deploy@VM` → `docker compose pull` → chạy `migrate` (vai trò `teachhub_owner`, thoát ≠ 0 thì dừng, api/worker giữ bản cũ) → ghi `IMAGE_TAG` vào `/opt/teachhub/.env` → `up -d api worker` → chờ `/health/ready` tối đa 120 giây (quá hạn thì job đỏ). Mỗi lần một deploy (`concurrency: deploy-dev`).

Kết nối: cổng 22 công khai chỉ mở cho IP admin (Firewall Hetzner, giữ nguyên) nên runner đi qua Tailscale (`tailscale/github-action`, tag `tag:ci`). Tailscale chỉ cần kết nối ra ngoài, không mở thêm cổng. User `deploy` thuộc nhóm `docker`, không có sudo. Nhóm `docker` tương đương root trên VM nên khóa `DEV_SSH_PRIVATE_KEY` phải được bảo vệ như khóa root.

Việc Owner phải làm một lần:

1. Tailscale: tạo tailnet; thêm vào ACL `tagOwners` cho `tag:ci` và `tag:dev`, và rule `{"action":"accept","src":["tag:ci"],"dst":["tag:dev:22"]}`. Tạo **OAuth client** (scope `auth_keys` ghi, tag `tag:ci`) và một **auth key** dùng một lần, gắn `tag:dev`, cho VM.
2. Khóa SSH deploy: `ssh-keygen -t ed25519 -f deploy_key -N ""`; khóa công khai truyền cho Ansible, khóa riêng làm secret.
3. Chạy lại Ansible (an toàn, idempotent): thêm `-e "deploy_ssh_pubkey='$(cat deploy_key.pub)'" -e ts_authkey=<tskey-auth-...>`. VM vào tailnet với tên `teachhub-dev`.
4. Lấy known_hosts của VM qua tailnet: `ssh-keyscan -t ed25519 teachhub-dev` (hoặc IP Tailscale `100.x.y.z`).
5. GitHub → Settings → Environments → tạo `development`, thêm secrets: `DEV_SSH_HOST` (IP/tên tailnet của VM), `DEV_SSH_USER` (`deploy`), `DEV_SSH_PRIVATE_KEY` (khóa riêng), `DEV_SSH_KNOWN_HOSTS` (kết quả bước 4), `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`.
6. Gói GHCR `teachhub-backend` phải cấp quyền đọc cho repo này (Package settings → Manage Actions access), để `GITHUB_TOKEN` kéo được image private.

Ansible đặt `IMAGE_TAG=main` trong `.env` chỉ khi file chưa có; CD sau đó giữ tag SHA đang chạy, nên chạy lại Ansible không làm lùi phiên bản.

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
