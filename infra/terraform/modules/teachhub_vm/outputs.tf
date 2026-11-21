output "server_ipv4" {
  value = hcloud_server.this.ipv4_address
}

output "urls" {
  value = { for k, v in var.hostnames : k => "https://${v}.${var.zone}" }
}

# Đầu vào cho playbook Ansible của môi trường: tofu output -json ansible_vars > ../../ansible/<env>-vars.json
output "ansible_vars" {
  sensitive = true
  value = {
    hosts            = { for k, v in var.hostnames : k => "${v}.${var.zone}" }
    cloudflare_cidrs = concat(data.cloudflare_ip_ranges.this.ipv4_cidrs, data.cloudflare_ip_ranges.this.ipv6_cidrs)
    origin_cert_pem  = cloudflare_origin_ca_certificate.origin.certificate
    origin_key_pem   = tls_private_key.origin.private_key_pem
    jwt_private_key  = tls_private_key.jwt.private_key_pem_pkcs8
    db_passwords     = { for k, v in random_password.db : k => v.result }
    minio_password   = random_password.minio.result
    app_keys         = { for k, v in random_password.app_key : k => v.result }
  }
}
