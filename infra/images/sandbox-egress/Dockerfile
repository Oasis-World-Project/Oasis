# 沙箱出口代理（ADR 0006 §7）：沙箱容器所在的内部网络不通外网；装软件包时经它出去，
# 它只放行 SANDBOX_EGRESS_ALLOW_HOSTS 里的域名（npm、PyPI 的仓库或镜像站），其余一律拒绝。
# HTTPS 走 CONNECT 隧道（只放行 443 端口），代理看不到内容，只按域名放行。
FROM alpine:3.22
RUN apk add --no-cache tinyproxy~=1.11.2
COPY tinyproxy.conf /etc/tinyproxy/tinyproxy.conf
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
EXPOSE 8888
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
