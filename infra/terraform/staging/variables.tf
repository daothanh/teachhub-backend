variable "zone" {
  description = "Zone Cloudflare (D1)."
  type        = string
  default     = "dayhoc.app"
}

variable "location" {
  description = "Vùng Hetzner (D18): Singapore."
  type        = string
  default     = "sin"
}

variable "server_type" {
  description = "CPX 4 vCPU / 8 GB. Hetzner đã đổi tên dòng CPX (thế hệ 2); check `server_type` báo lỗi nếu tên sai hoặc không có ở `location`."
  type        = string
  default     = "cpx32"
}

variable "ssh_public_key" {
  description = "Khóa SSH công khai của admin (nội dung file .pub)."
  type        = string
}

variable "admin_ssh_cidrs" {
  description = "Dải IP được SSH vào VM (vd. [\"203.0.113.7/32\"]). SSH chỉ qua key."
  type        = list(string)

  validation {
    condition     = length(var.admin_ssh_cidrs) > 0 && !contains(var.admin_ssh_cidrs, "0.0.0.0/0") && !contains(var.admin_ssh_cidrs, "::/0")
    error_message = "Cần ít nhất một dải IP admin và không được mở SSH cho toàn Internet."
  }
}

variable "hostnames" {
  description = "Tên miền staging (Spec Mục 8, A4), một cấp dưới zone để Universal SSL phủ được."
  type        = map(string)
  default = {
    api   = "api-staging"
    app   = "app-staging"
    admin = "admin-staging"
  }
}
