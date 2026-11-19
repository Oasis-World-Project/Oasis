#!/bin/sh
# 把域名白名单（SANDBOX_EGRESS_ALLOW_HOSTS，逗号分隔；加上镜像里的 project-hosts）写成 tinyproxy 的过滤规则
# （整个域名精确匹配），再前台运行 tinyproxy。
set -eu
hosts="${SANDBOX_EGRESS_ALLOW_HOSTS:-}"
# 导入项目要到的站（代码托管、各语言的包仓库和工具链）：名单在镜像里，SANDBOX_EGRESS_PROJECT_HOSTS=off 时不放行
if [ "${SANDBOX_EGRESS_PROJECT_HOSTS:-on}" != "off" ]; then
  hosts="$hosts,$(grep -v '^#' /etc/tinyproxy/project-hosts | tr '\n' ',')"
fi
if [ -z "$hosts" ]; then
  echo "没有放行任何域名：所有出站请求都会被拒绝" >&2
fi
: > /etc/tinyproxy/allow
for host in $(echo "$hosts" | tr ',' ' '); do
  # 点要转义，前后加锚点，避免 evil-registry.npmjs.org.example.com 之类的绕过
  printf '^%s$\n' "$(echo "$host" | sed 's/\./\\./g')" >> /etc/tinyproxy/allow
done
echo "出口代理放行：${hosts:-（无）}"
exec tinyproxy -d -c /etc/tinyproxy/tinyproxy.conf
