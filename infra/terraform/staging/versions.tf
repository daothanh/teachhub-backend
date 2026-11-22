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

  # State riêng cho staging, trên R2 (S3 API). Giá trị bucket/endpoint/khóa truyền lúc init: xem backend.hcl.example.
  backend "s3" {
    key                         = "staging/terraform.tfstate"
    region                      = "auto"
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
    use_path_style              = true
  }
}

# Token đọc từ biến môi trường: HCLOUD_TOKEN, CLOUDFLARE_API_TOKEN (quyền xem infra/README.md).
provider "hcloud" {}
provider "cloudflare" {}
