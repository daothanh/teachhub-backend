# S3-OPS-01: 1 VM staging ở sin, cùng cấu hình với dev (module ../modules/teachhub_vm), network/hostname/state riêng.
# Cấu hình cấp zone (ssl strict, always_use_https, min_tls_version) đã khai ở ../dev: không khai lại ở đây.
module "vm" {
  source = "../modules/teachhub_vm"

  env             = "staging"
  env_label       = "staging"
  zone            = var.zone
  location        = var.location
  server_type     = var.server_type
  ssh_public_key  = var.ssh_public_key
  admin_ssh_cidrs = var.admin_ssh_cidrs
  hostnames       = var.hostnames
  network_cidr    = "10.1.0.0/16"
  subnet_cidr     = "10.1.1.0/24"
  server_ip       = "10.1.1.10"
  dns_comment     = "teachhub staging (S3-OPS-01, Terraform)"
}
