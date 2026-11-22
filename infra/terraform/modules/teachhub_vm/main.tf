# Module dùng chung cho dev (S0-OPS-01) và staging (S3-OPS-01): 1 VM ở sin gộp api/worker/PostgreSQL/Redis/MinIO (Plan Mục 2, Spec Mục 9.1).
# Cloudflare → (443, chỉ dải IP Cloudflare) → Caddy trên VM (chứng chỉ Origin CA, Full strict) → api.
# Cấu hình cấp zone (ssl strict…) KHÔNG nằm ở đây: chỉ khai ở infra/terraform/dev để hai state không giành nhau.

data "cloudflare_zone" "this" {
  filter = { name = var.zone }
}

data "cloudflare_ip_ranges" "this" {}

data "hcloud_location" "this" {
  name = var.location
}

data "hcloud_server_type" "this" {
  name = var.server_type
}

check "server_type_in_location" {
  assert {
    condition = anytrue([
      for l in data.hcloud_server_type.this.locations : l.name == var.location && !l.is_deprecated
    ])
    error_message = "Loại máy ${var.server_type} không có (hoặc sắp ngừng) ở ${var.location}. Chạy infra/terraform/r25-probe để xem loại máy có ở vùng này."
  }
}

# --- Mạng ---

resource "hcloud_network" "this" {
  name     = "teachhub-${var.env}"
  ip_range = var.network_cidr
}

resource "hcloud_network_subnet" "app" {
  network_id   = hcloud_network.this.id
  type         = "cloud"
  network_zone = data.hcloud_location.this.network_zone
  ip_range     = var.subnet_cidr
}

resource "hcloud_firewall" "this" {
  name = "teachhub-${var.env}"

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
  name       = "teachhub-${var.env}-admin"
  public_key = var.ssh_public_key
}

resource "hcloud_server" "this" {
  name         = "teachhub-${var.env}-1"
  server_type  = var.server_type
  image        = "ubuntu-24.04"
  location     = var.location
  ssh_keys     = [hcloud_ssh_key.admin.id]
  firewall_ids = [hcloud_firewall.this.id]
  labels       = { env = var.env_label, app = "teachhub" }

  network {
    network_id = hcloud_network.this.id
    ip         = var.server_ip
  }

  # Provider hcloud 1.70 đọc lại block network (alias_ips, mac_address, subnet_id) khác khai báo → plan luôn đòi
  # gỡ/gắn lại mạng (#200 chưa hết). Mạng chỉ gắn lúc tạo máy; đổi mạng/IP có chủ đích thì `-replace` máy.
  lifecycle {
    ignore_changes = [network]
  }

  # Subnet phải có trước khi gắn máy.
  depends_on = [hcloud_network_subnet.app]
}

# --- DNS + TLS ---

resource "cloudflare_dns_record" "this" {
  for_each = var.hostnames

  zone_id = data.cloudflare_zone.this.zone_id
  name    = "${each.value}.${var.zone}"
  type    = "A"
  content = hcloud_server.this.ipv4_address
  proxied = true
  ttl     = 1
  comment = var.dns_comment
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

  # Provider Cloudflare đọc lại csr/requested_validity khác giá trị khai báo (validity còn lại, PEM chuẩn hóa) → mỗi
  # lần apply đòi thay chứng chỉ, chứng chỉ cũ bị thu hồi trong khi VM còn dùng → 526. Muốn xoay chứng chỉ thì
  # `tofu apply -replace=cloudflare_origin_ca_certificate.origin` rồi xuất lại <env>-vars.json và chạy playbook.
  lifecycle {
    ignore_changes = [csr, requested_validity, hostnames, request_type]
  }
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

# Khóa ứng dụng bắt buộc ngoài local/test (libs/core/src/config.ts): ba khóa phải khác nhau.
resource "random_password" "app_key" {
  for_each = toset(["consent_ip_hmac", "invite_code_hmac", "idempotency_enc", "admin_api"])
  length   = 48
  special  = false
}
