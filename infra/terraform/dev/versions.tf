terraform {
  required_version = ">= 1.8"

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.53"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.12"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # shortcut: state lưu local (gitignore) vì dev dựng lại được và chỉ một người chạy; khi dựng staging (S3-OPS-01) chuyển sang backend S3 trên R2.
}

# Token đọc từ biến môi trường: HCLOUD_TOKEN, CLOUDFLARE_API_TOKEN (quyền xem infra/README.md).
provider "hcloud" {}
provider "cloudflare" {}
