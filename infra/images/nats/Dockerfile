# oasis/nats：官方镜像 + 开启 JetStream 的配置（账号密码从环境变量读取）
FROM nats:2.15.1-alpine
COPY nats.conf /etc/nats/nats.conf
CMD ["-c", "/etc/nats/nats.conf"]
