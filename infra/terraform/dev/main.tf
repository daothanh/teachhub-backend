# S0-OPS-01: 1 VM development ở sin gộp api/worker/PostgreSQL/Redis/MinIO (Plan Mục 2, Spec Mục 9.1).
# Cloudflare → (443, chỉ dải IP Cloudflare) → Caddy trên VM (chứng chỉ Origin CA, Full strict) → api.

data "cloudflare_zone" "this" {
  filter = { name = var.zone }
}

data "cloudflare_ip_ranges" "this" {}

data "hcloud_location" "this" {
  name = var.location
}

data "hcloud_server_type" "dev" {
  name = var.server_type
}

check "server_type_in_location" {
  assert {
    condition = anytrue([
      for l in data.hcloud_server_type.dev.locations : l.name == var.location && !l.is_deprecated
    ])
    error_message = "Loại máy ${var.server_type} không có (hoặc sắp ngừng) ở ${var.location}. Chạy infra/terraform/r25-probe để xem loại máy có ở vùng này."
  }
}

# --- Mạng ---

resource "hcloud_network" "this" {
  name     = "teachhub-dev"
  ip_range = "10.0.0.0/16"
}

resource "hcloud_network_subnet" "app" {
  network_id   = hcloud_network.this.id
  type         = "cloud"
  network_zone = data.hcloud_location.this.network_zone
  ip_range     = "10.0.1.0/24"
}

resource "hcloud_firewall" "dev" {
  name = "teachhub-dev"

  # Chỉ Cloudflare vào được origin (Spec Mục 6: origin chỉ nhận lưu lượng từ Cloudflare).
  rule {
    description = "HTTPS từ Cloudflare"
    direction   = "in"
    protocol    = "tcp"
    port        = "443"
    source_ips  = concat(data.cloudflare_ip_ranges.this.ipv4_cidrs, data.cloudflare_ip_ranges.this.ipv6_cidrs)
  }

  rule {
    description = "SSH từ IP admin"
    direction   = "in"
    protocol    = "tcp"
    port        = "22"
    source_ips  = var.admin_ssh_cidrs
  }

  rule {
    description = "Ping"
    direction   = "in"
    protocol    = "icmp"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }
}

# --- Máy ---

resource "hcloud_ssh_key" "admin" {
  name       = "teachhub-dev-admin"
  public_key = var.ssh_public_key
}

resource "hcloud_server" "dev" {
  name         = "teachhub-dev-1"
  server_type  = var.server_type
  image        = "ubuntu-24.04"
  location     = var.location
  ssh_keys     = [hcloud_ssh_key.admin.id]
  firewall_ids = [hcloud_firewall.dev.id]
  labels       = { env = "development", app = "teachhub" }

  network {
    subnet_id = hcloud_network_subnet.app.id
    ip        = "10.0.1.10"
  }

  # Subnet phải có trước khi gắn máy.
  depends_on = [hcloud_network_subnet.app]
}

# --- DNS + TLS ---

resource "cloudflare_dns_record" "dev" {
  for_each = var.hostnames

  zone_id = data.cloudflare_zone.this.zone_id
  name    = "${each.value}.${var.zone}"
  type    = "A"
  content = hcloud_server.dev.ipv4_address
  proxied = true
  ttl     = 1
  comment = "teachhub dev (S0-OPS-01, Terraform)"
}

# Cấu hình cấp zone: áp cho mọi hostname của dayhoc.app (R2 custom domain không bị ảnh hưởng).
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

# Chứng chỉ Origin CA (chỉ Cloudflare tin) cho Caddy trên VM — đủ cho Full (strict).
resource "tls_private_key" "origin" {
  algorithm   = "ECDSA"
  ecdsa_curve = "P256"
}

resource "tls_cert_request" "origin" {
  private_key_pem = tls_private_key.origin.private_key_pem
  dns_names       = [var.zone, "*.${var.zone}"]
  subject {
    common_name = var.zone
  }
}

resource "cloudflare_origin_ca_certificate" "origin" {
  csr                = tls_cert_request.origin.cert_request_pem
  hostnames          = [var.zone, "*.${var.zone}"]
  request_type       = "origin-ecc"
  requested_validity = 5475
}

# --- Bí mật của ứng dụng (sang Ansible qua output `ansible_vars`) ---

resource "tls_private_key" "jwt" {
  algorithm   = "ECDSA"
  ecdsa_curve = "P256"
}

resource "random_password" "db" {
  for_each = toset(["postgres", "owner", "app", "worker", "readonly"])
  length   = 32
  special  = false # nằm trong URL kết nối
}

resource "random_password" "minio" {
  length  = 32
  special = false
}
