-- Chỉ dùng cho môi trường local (docker compose). Staging/production tạo vai trò bằng Ansible.
-- Mật khẩu dưới đây là giá trị local, không dùng ở môi trường khác.
create role teachhub_owner login password 'teachhub_owner';
create role teachhub_app login password 'teachhub_app';                 -- api: không BYPASSRLS, không sở hữu bảng
create role teachhub_worker login password 'teachhub_worker' bypassrls; -- worker: xử lý chéo tenant có kiểm soát
create role teachhub_readonly login password 'teachhub_readonly';

create database teachhub owner teachhub_owner;
\connect teachhub
alter schema public owner to teachhub_owner;
