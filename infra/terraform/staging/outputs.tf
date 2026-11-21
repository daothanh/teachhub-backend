output "server_ipv4" {
  value = module.vm.server_ipv4
}

output "urls" {
  value = module.vm.urls
}

# Đầu vào cho infra/ansible/staging.yml: tofu output -json ansible_vars > ../../ansible/staging-vars.json
output "ansible_vars" {
  sensitive = true
  value     = module.vm.ansible_vars
}
