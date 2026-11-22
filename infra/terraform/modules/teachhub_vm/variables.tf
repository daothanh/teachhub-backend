variable "env" {
  description = "Tên ngắn của môi trường (dev, staging): đặt hậu tố tên tài nguyên Hetzner."
  type        = string
}

variable "env_label" {
  description = "Giá trị nhãn `env` của VM (development, staging)."
  type        = string
}

variable "zone" {
  description = "Zone Cloudflare (D1)."
  type        = string
}

variable "location" {
  description = "Vùng Hetzner (D18)."
  type        = string
}

variable "server_type" {
  description = "Loại máy Hetzner; check `server_type_in_location` báo lỗi nếu sai tên hoặc không có ở `location`."
  type        = string
}

variable "ssh_public_key" {
  description = "Khóa SSH công khai của admin (nội dung file .pub)."
  type        = string
}

variable "admin_ssh_cidrs" {
  description = "Dải IP được SSH vào VM. SSH chỉ qua key."
  type        = list(string)

  validation {
    condition     = length(var.admin_ssh_cidrs) > 0 && !contains(var.admin_ssh_cidrs, "0.0.0.0/0") && !contains(var.admin_ssh_cidrs, "::/0")
    error_message = "Cần ít nhất một dải IP admin và không được mở SSH cho toàn Internet."
  }
}

variable "hostnames" {
  description = "Tên miền của môi trường, một cấp dưới zone để Universal SSL phủ được (khóa: api, app, admin)."
  type        = map(string)
}

variable "network_cidr" {
  description = "Dải Private Network."
  type        = string
}

variable "subnet_cidr" {
  description = "Dải subnet của VM (nằm trong network_cidr)."
  type        = string
}

variable "server_ip" {
  description = "IP riêng của VM trong subnet."
  type        = string
}

variable "dns_comment" {
  description = "Ghi chú trên bản ghi DNS. Đổi giá trị này làm bản ghi DNS bị cập nhật tại chỗ (không tạo lại)."
  type        = string
}
