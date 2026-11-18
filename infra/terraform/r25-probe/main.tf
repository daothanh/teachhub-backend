# R25: thử tạo đủ loại máy production ở sin rồi xóa ngay (S0-OPS-01). Tách root riêng để destroy không đụng VM dev.
#   tofu plan                                  → output `types_in_location`: loại máy có ở sin
#   tofu apply  -var create=true               → tạo mỗi loại 1 máy (tính tiền theo giờ, vài phút)
#   tofu destroy -var create=true              → xóa; ghi kết quả vào issue R25

terraform {
  required_version = ">= 1.8"
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.53"
    }
  }
}

provider "hcloud" {}

variable "location" {
  type    = string
  default = "sin"
}

variable "create" {
  description = "false: chỉ liệt kê loại máy; true: tạo thử."
  type        = bool
  default     = false
}

variable "probe_types" {
  description = "Loại máy production theo Spec Mục 9.1: app CPX 4/8, db CCX 4 riêng/16, redis + ops CPX 2/4. Sửa theo output `types_in_location` nếu Hetzner đổi tên."
  type        = list(string)
  default     = ["cpx32", "ccx23", "cpx22"]
}

data "hcloud_server_types" "all" {}

output "types_in_location" {
  value = sort([
    for t in data.hcloud_server_types.all.server_types :
    "${t.name} (${t.cores} vCPU ${t.cpu_type}, ${t.memory} GB)"
    if anytrue([for l in t.locations : l.name == var.location && !l.is_deprecated])
  ])
}

resource "hcloud_server" "probe" {
  for_each    = var.create ? toset(var.probe_types) : toset([])
  name        = "r25-probe-${each.key}"
  server_type = each.key
  image       = "ubuntu-24.04"
  location    = var.location
  labels      = { purpose = "r25-probe" }
}

output "created" {
  value = { for k, s in hcloud_server.probe : k => s.status }
}
