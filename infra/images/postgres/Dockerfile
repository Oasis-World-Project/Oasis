# oasis/postgres：官方镜像 + 每服务独立库和账号的初始化脚本
FROM postgres:18.6-trixie
COPY --chmod=755 init/ /docker-entrypoint-initdb.d/
