#!/bin/sh
# Vai trò PostgreSQL trên VM dev — cùng phân quyền với docker/postgres-init/01-roles.sql (ADR-TH-BE-001), mật khẩu lấy từ biến môi trường.
# Chỉ chạy khi volume dữ liệu còn trống (cơ chế /docker-entrypoint-initdb.d).
set -eu
psql -v ON_ERROR_STOP=1 --username postgres <<SQL
create role teachhub_owner login password '${PG_OWNER_PASSWORD}';
create role teachhub_app login password '${PG_APP_PASSWORD}';
create role teachhub_worker login password '${PG_WORKER_PASSWORD}' bypassrls;
create role teachhub_readonly login password '${PG_READONLY_PASSWORD}';
create database teachhub owner teachhub_owner;
\connect teachhub
alter schema public owner to teachhub_owner;
SQL
