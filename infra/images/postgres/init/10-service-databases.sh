#!/usr/bin/env bash
# 只在数据库卷首次初始化时运行：为每个服务建独立账号和独立 database，并收回其他账号的连接权限。
# 以后新增服务：先把服务名加进 SERVICES，再用 `pnpm infra:down -v` 和 `pnpm infra:up` 重建镜像和本地卷（会清空本地数据）。
set -euo pipefail

SERVICES=(identity billing agent conversation task canvas harness model_gateway)

for svc in "${SERVICES[@]}"; do
  var="${svc^^}_DB_PASSWORD"
  password="${!var:?缺少环境变量 ${var}}"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
    -v role="svc_${svc}" -v pw="$password" -v db="$svc" <<'SQL'
CREATE ROLE :"role" LOGIN PASSWORD :'pw';
CREATE DATABASE :"db" OWNER :"role";
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE :"db" TO :"role";
SQL
done
