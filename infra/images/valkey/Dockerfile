# oasis/valkey：官方镜像，密码由环境变量 VALKEY_PASSWORD 注入
FROM valkey/valkey:9.1.2-alpine
CMD ["sh", "-c", "exec valkey-server --appendonly yes --requirepass \"$VALKEY_PASSWORD\""]
