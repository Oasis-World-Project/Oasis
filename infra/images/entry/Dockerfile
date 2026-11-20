# oasis/entry：线上唯一对外的入口（官方 Caddy + 构建好的网页）。
#   - HTTPS 证书自动申请和续期（Let's Encrypt），证书存在 /data 卷里；
#   - 发网页的静态文件和桌面版安装包（/download）；/api 转给 gateway；/avatar/v1 转给 model-gateway 的数字人入口。
# 用法（在仓库根目录）：填了 OASIS_DOMAIN 以后 pnpm stack:up 会构建并启动它，见 docs/ops/部署.md。
ARG NODE_IMAGE=node:24.21.0-trixie-slim

FROM ${NODE_IMAGE} AS web
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo
COPY . .
RUN --mount=type=cache,id=oasis-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --store-dir=/pnpm/store --filter "@oasis/web..."
RUN pnpm --filter "@oasis/web..." run build

FROM caddy:2.11.9-alpine
COPY infra/images/entry/Caddyfile /etc/caddy/Caddyfile
COPY --from=web /repo/apps/web/dist /srv
