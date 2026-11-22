# S0-OPS-01: 1 VM development ở sin (Plan Mục 2, Spec Mục 9.1). Phần dựng VM dùng chung với staging: ../modules/teachhub_vm.
module "vm" {
  source = "../modules/teachhub_vm"

  env             = "dev"
  env_label       = "development"
  zone            = var.zone
  location        = var.location
  server_type     = var.server_type
  ssh_public_key  = var.ssh_public_key
  admin_ssh_cidrs = var.admin_ssh_cidrs
  hostnames       = var.hostnames
  network_cidr    = "10.0.0.0/16"
  subnet_cidr     = "10.0.1.0/24"
  server_ip       = "10.0.1.10"
  dns_comment     = "teachhub dev (S0-OPS-01, Terraform)" # giữ nguyên chuỗi cũ để plan không có diff
}

# Chuyển tài nguyên đã có vào module mà KHÔNG tạo lại (tên Hetzner/Cloudflare, ID và state giữ nguyên).
# `tofu plan` dev lần đầu sau khi tách phải chỉ báo "has moved to" cho các dòng dưới và 0 add/0 destroy.
moved {
  from = hcloud_network.this
  to   = module.vm.hcloud_network.this
}
moved {
  from = hcloud_network_subnet.app
  to   = module.vm.hcloud_network_subnet.app
}
moved {
  from = hcloud_firewall.dev
  to   = module.vm.hcloud_firewall.this
}
moved {
  from = hcloud_ssh_key.admin
  to   = module.vm.hcloud_ssh_key.admin
}
moved {
  from = hcloud_server.dev
  to   = module.vm.hcloud_server.this
}
moved {
  from = cloudflare_dns_record.dev
  to   = module.vm.cloudflare_dns_record.this
}
moved {
  from = tls_private_key.origin
  to   = module.vm.tls_private_key.origin
}
moved {
  from = tls_cert_request.origin
  to   = module.vm.tls_cert_request.origin
}
moved {
  from = cloudflare_origin_ca_certificate.origin
  to   = module.vm.cloudflare_origin_ca_certificate.origin
}
moved {
  from = tls_private_key.jwt
  to   = module.vm.tls_private_key.jwt
}
moved {
  from = random_password.db
  to   = module.vm.random_password.db
}
moved {
  from = random_password.minio
  to   = module.vm.random_password.minio
}
moved {
  from = random_password.app_key
  to   = module.vm.random_password.app_key
}

# Cấu hình cấp zone: áp cho mọi hostname của dayhoc.app (R2 custom domain không bị ảnh hưởng), kể cả staging.
# CHỈ khai ở state dev; staging không khai lại, nếu không hai state giành quyền với cùng một setting.
data "cloudflare_zone" "this" {
  filter = { name = var.zone }
}

resource "cloudflare_zone_setting" "ssl" {
  zone_id    = data.cloudflare_zone.this.zone_id
  setting_id = "ssl"
  value      = "strict"
}

resource "cloudflare_zone_setting" "always_use_https" {
  zone_id    = data.cloudflare_zone.this.zone_id
  setting_id = "always_use_https"
  value      = "on"
}

resource "cloudflare_zone_setting" "min_tls_version" {
  zone_id    = data.cloudflare_zone.this.zone_id
  setting_id = "min_tls_version"
  value      = "1.2"
}
