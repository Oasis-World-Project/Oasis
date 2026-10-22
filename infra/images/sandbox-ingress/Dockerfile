# 沙箱入口代理：沙箱容器所在的内部网络不通外网，只能访问它。
# 它只放行两条路径（chat completions、Jev 决策），转到 model-gateway 的 /run/v1/*（凭临时 Key 计费），
# 其余一律 403。这样沙箱里的代码碰不到任何服务的 /internal 接口。
FROM nginx:1.29.3-alpine
COPY default.conf.template /etc/nginx/templates/default.conf.template
COPY sandbox-proxy.inc /etc/nginx/conf.d/sandbox-proxy.inc
