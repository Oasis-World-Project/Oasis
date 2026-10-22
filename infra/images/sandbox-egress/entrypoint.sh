#!/bin/sh
# 把逗号分隔的域名白名单写成 tinyproxy 的过滤规则（整个域名精确匹配），再前台运行 tinyproxy。
set -eu
hosts="${SANDBOX_EGRESS_ALLOW_HOSTS:-}"
if [ -z "$hosts" ]; then
  echo "SANDBOX_EGRESS_ALLOW_HOSTS 是空的：所有出站请求都会被拒绝" >&2
fi
: > /etc/tinyproxy/allow
for host in $(echo "$hosts" | tr ',' ' '); do
  # 点要转义，前后加锚点，避免 evil-registry.npmjs.org.example.com 之类的绕过
  printf '^%s$\n' "$(echo "$host" | sed 's/\./\\./g')" >> /etc/tinyproxy/allow
done
echo "出口代理放行：${hosts:-（无）}"
exec tinyproxy -d -c /etc/tinyproxy/tinyproxy.conf
