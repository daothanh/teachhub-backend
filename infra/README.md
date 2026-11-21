# Hạ tầng (S0-OPS-01, S3-OPS-01)

Một VM development ở Hetzner `sin` chạy `api`, `worker`, PostgreSQL, Redis, MinIO và Mailpit bằng Docker Compose. Phía trước là Caddy, dùng chứng chỉ Cloudflare Origin CA. Luồng truy cập: Cloudflare (Full strict) → cổng 443 chỉ nhận dải IP Cloudflare → Caddy → `api`.

| Thư mục | Nội dung |
| --- | --- |
| `terraform/modules/teachhub_vm` | Phần dựng VM dùng chung dev/staging: Private Network, Firewall, VM, bản ghi DNS, chứng chỉ origin, các bí mật (mật khẩu DB/MinIO, khóa JWT, khóa ứng dụng) |
| `terraform/dev` | Gọi module cho dev (`10.0.0.0/16`) + cấu hình cấp zone `dayhoc.app` (SSL strict, Always HTTPS, TLS ≥ 1.2) |
| `terraform/staging` | Gọi module cho staging (`10.1.0.0/16`), state riêng trên R2 |
| `terraform/r25-probe` | Thử tạo các loại máy production ở `sin` rồi xóa ngay (R25) |
| `ansible` | Cài Docker và dựng stack trên VM: `dev.yml`, `staging.yml` dùng chung role `teachhub_app`, khác biến |

Tên miền dev chỉ có **một cấp** dưới zone (`api-dev.`, `app-dev.`, `admin-dev.dayhoc.app`; staging: `api-staging.`, `app-staging.`, `admin-staging.dayhoc.app`) vì Universal SSL của Cloudflare không phủ tên hai cấp như `api.dev.dayhoc.app`.

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

Kết nối: cổng 22 công khai chỉ mở cho IP admin (Firewall Hetzner, giữ nguyên) nên runner đi qua Tailscale (`tailscale/github-action`, tag `tag:ci`). Tailscale chỉ cần kết nối ra ngoài, không mở thêm cổng.

Quyền của `deploy` được khóa chặt, không dùng nhóm `docker` (nhóm này tương đương root):
- Khóa SSH là forced command `sudo /usr/local/bin/teachhub-deploy` kèm `restrict` và `from="100.64.0.0/10"`; sshd drop-in `60-teachhub-deploy.conf` cũng chỉ cho `deploy` vào từ dải Tailscale, không tty, không forwarding.
- sudoers (`/etc/sudoers.d/teachhub-deploy`) chỉ cho `deploy` chạy đúng script đó.
- Script root-owned chạy chuỗi lệnh cố định: kiểm tag, login GHCR (cấu hình docker tạm), pull, migrate, ghi `IMAGE_TAG`, `up -d api worker`, chờ health. Tag lấy từ `SSH_ORIGINAL_COMMAND`, chỉ nhận `main` hoặc `sha-<40 hex>`; token ở dòng đầu stdin; không `eval`, không tham số khác.
- Giao thức từ workflow: `printf '%s\n' "$GHCR_TOKEN" | ssh deploy@host "<tag>"`.

Việc Owner phải làm một lần:

1. Tailscale: tạo tailnet; thêm vào ACL `tagOwners` cho `tag:ci` và `tag:dev`, và rule `{"action":"accept","src":["tag:ci"],"dst":["tag:dev:22"]}`. Tạo **OAuth client** (scope `auth_keys` ghi, tag `tag:ci`) và một **auth key** dùng một lần, gắn `tag:dev`, cho VM.
2. Khóa SSH deploy: `ssh-keygen -t ed25519 -f deploy_key -N ""`; khóa công khai truyền cho Ansible, khóa riêng làm secret.
3. Chạy lại Ansible (an toàn, idempotent): thêm `-e "deploy_ssh_pubkey='$(cat deploy_key.pub)'" -e ts_authkey=<tskey-auth-...>`. VM vào tailnet với tên `teachhub-dev`.
4. Lấy known_hosts của VM qua tailnet: `ssh-keyscan -t ed25519 teachhub-dev` (hoặc IP Tailscale `100.x.y.z`).
5. GitHub → Settings → Environments → tạo `development`, thêm secrets: `DEV_SSH_HOST` (IP/tên tailnet của VM), `DEV_SSH_USER` (`deploy`), `DEV_SSH_PRIVATE_KEY` (khóa riêng), `DEV_SSH_KNOWN_HOSTS` (kết quả bước 4), `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`.
6. Gói GHCR `teachhub-backend` phải cấp quyền đọc cho repo này (Package settings → Manage Actions access), để `GITHUB_TOKEN` kéo được image private.

Ansible đặt `IMAGE_TAG=main` trong `.env` chỉ khi file chưa có; CD sau đó giữ tag SHA đang chạy, nên chạy lại Ansible không làm lùi phiên bản.

## Tách module dev (S3-OPS-01): Owner kiểm trước khi apply

`terraform/dev` giờ gọi `modules/teachhub_vm`. Mọi tài nguyên đã có được chuyển vào module bằng khối `moved {}` (13 khối trong `dev/main.tf`), nên VM, DNS, chứng chỉ origin và mật khẩu **không bị tạo lại**. Chỉ `cloudflare_zone_setting.*` giữ ở gốc.

```bash
cd infra/terraform/dev && tofu init   # cần init lại vì có module mới
tofu plan
```

Kết quả đúng: các dòng `has moved to module.vm...` và **0 to add, 0 to change, 0 to destroy**. Thấy `must be replaced` / `will be destroyed` ở bất kỳ resource nào thì **dừng, không apply**, báo lại. Sau khi plan sạch, `tofu apply` chỉ ghi lại địa chỉ mới vào state.

## Staging (S3-OPS-01)

VM `teachhub-staging-1` ở `sin`, cùng cấu hình với dev, hostname `api-staging`/`app-staging`/`admin-staging`, `NODE_ENV=staging`, state riêng, Google/Apple theo project Firebase stg. Khác dev: email qua **SES SMTP** (không có Mailpit), CD theo tag. Kho tệp vẫn là MinIO trên VM (bucket `teachhub-staging-*`), chưa chuyển sang R2 như Spec Mục 2.8: đổi khi có bucket R2 staging.

Việc Owner phải làm, theo thứ tự:

1. Dev đã `apply` (zone setting) và plan dev sạch như mục trên.
2. R2: tạo bucket riêng tư `teachhub-tfstate` và một API token S3 chỉ cho bucket đó. `cd terraform/staging && cp backend.hcl.example backend.hcl` (điền endpoint, bucket), `cp terraform.tfvars.example terraform.tfvars` (khóa SSH, IP admin). Rồi:
   ```bash
   export HCLOUD_TOKEN=... CLOUDFLARE_API_TOKEN=... AWS_ACCESS_KEY_ID=<R2 key> AWS_SECRET_ACCESS_KEY=<R2 secret>
   tofu init -backend-config=backend.hcl && tofu apply
   tofu output -json ansible_vars > ../../ansible/staging-vars.json
   ```
3. Tailscale: thêm `tag:staging` vào `tagOwners` của ACL và rule `{"action":"accept","src":["tag:ci"],"dst":["tag:staging:22"]}`; tạo auth key dùng một lần gắn `tag:staging`. OAuth client `tag:ci` dùng lại của dev.
4. SES: xác minh domain `dayhoc.app` ở `ap-southeast-1` (S0-PO-08), tạo thông tin xác thực SMTP, và (vì đang sandbox) xác minh các địa chỉ nhận thử. `smtp_url` dạng `smtps://<user>:<pass>@email-smtp.ap-southeast-1.amazonaws.com:465`, mật khẩu phải URL-encode.
5. Firebase stg (`dayhoc-stg`): tạo service account, tải JSON, `jq -n --slurpfile k fcm-stg.json '{fcm_service_account_json: $k[0]}' > fcm-stg-vars.json`. Bước này tùy chọn; thiếu thì worker tắt gửi push.
6. Khóa SSH deploy riêng cho staging (`ssh-keygen -t ed25519 -f deploy_key_stg -N ""`), rồi chạy Ansible:
   ```bash
   cd ../../ansible
   uvx --from ansible-core ansible-playbook -i "$(tofu -chdir=../terraform/staging output -raw server_ipv4)," -u root staging.yml \
     -e @staging-vars.json -e ghcr_user=<github-user> -e ghcr_token=<PAT> \
     -e smtp_url='smtps://...' -e "deploy_ssh_pubkey='$(cat deploy_key_stg.pub)'" -e ts_authkey=<tskey-auth-...> \
     [-e @fcm-stg-vars.json]
   curl -s https://api-staging.dayhoc.app/health/ready
   ```
7. `ssh-keyscan -t ed25519 teachhub-staging` qua tailnet. GitHub → Environments → tạo `staging` (bật Required reviewers nếu muốn duyệt trước khi deploy) với secrets `STAGING_SSH_HOST`, `STAGING_SSH_USER` (`deploy`), `STAGING_SSH_PRIVATE_KEY`, `STAGING_SSH_KNOWN_HOSTS`, `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`.

CD: `git tag v0.1.0 && git push origin v0.1.0` → `image` build + đẩy GHCR với tag `v0.1.0` (kèm `sha-<40 hex>`) → `deploy-staging` (workflow_run, chỉ tag `v*`; hoặc chạy tay với input `tag`) → cùng giao thức forced command như dev. Script trên VM chỉ nhận `v<semver>` (`v1.2.3`, `v1.2.3-rc.1`) hoặc `sha-<40 hex>` để quay lại bản cũ; tag khác bị từ chối. Mỗi lần một deploy (`concurrency: deploy-staging`). Workflow không kiểm tag nằm trên `main`: dùng Required reviewers của Environment nếu cần chặn.

## R25: thử hạn mức tạo máy

```bash
cd infra/terraform/r25-probe && tofu init
tofu plan                            # output types_in_location: loại máy có ở sin
tofu apply   -var create=true        # tạo mỗi loại 1 máy (tính tiền theo giờ)
tofu destroy -var create=true        # xóa ngay, rồi ghi kết quả vào issue R25
```

## Lưu ý

- State Terraform lưu ở local và **chứa bí mật**: mật khẩu DB, khóa origin, khóa JWT. Không commit, không chia sẻ. State staging nằm trên R2 (xem mục Staging).
- `cloudflare_zone_setting` áp dụng cho cả zone (gồm staging): SSL Full (strict), Always Use HTTPS, TLS ≥ 1.2. Chỉ khai ở `terraform/dev`; `terraform/staging` không khai lại để hai state không giành nhau. Hệ quả: dựng dev trước staging, và đừng `tofu destroy` dev khi staging còn chạy.
- Muốn đổi IP được SSH thì sửa `admin_ssh_cidrs` rồi chạy `tofu apply`. Cổng 22 không bao giờ mở cho toàn Internet.
- MinIO chưa mở ra Internet. Khi client cần upload thẳng bằng presigned URL ở môi trường dev thì phải thêm một hostname riêng cho MinIO.
