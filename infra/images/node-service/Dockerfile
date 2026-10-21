# 所有 Node 服务共用的镜像构建文件，用 SERVICE 参数区分服务；每个服务仍单独构建、单独出镜像。
# 用法（在仓库根目录）：
#   docker build -f infra/images/node-service/Dockerfile --build-arg SERVICE=identity -t oasis/identity:local .
ARG NODE_IMAGE=node:24.21.0-trixie-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

FROM base AS build
ARG SERVICE
RUN test -n "$SERVICE" || (echo "缺少构建参数 SERVICE" && exit 1)
COPY . .
# 镜像构建不需要任何安装脚本（git 钩子之类），也没有需要编译的原生依赖
RUN --mount=type=cache,id=oasis-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --store-dir=/pnpm/store --filter "@oasis/${SERVICE}..."
RUN pnpm --filter "@oasis/${SERVICE}..." run build
# 把服务和它依赖的工作区包（service-kit、contracts）连同运行时依赖一起复制到 /out，不再依赖 /repo
RUN --mount=type=cache,id=oasis-pnpm-store,target=/pnpm/store \
    pnpm --filter "@oasis/${SERVICE}" --config.inject-workspace-packages=true \
      deploy --prod --ignore-scripts --store-dir=/pnpm/store /out

FROM ${NODE_IMAGE} AS runtime
ARG SERVICE
ARG SERVICE_VERSION=0.0.0
ARG GIT_COMMIT=unknown
ENV NODE_ENV=production \
    SERVICE_VERSION=${SERVICE_VERSION} \
    GIT_COMMIT=${GIT_COMMIT}
LABEL org.opencontainers.image.title="oasis/${SERVICE}" \
      org.opencontainers.image.revision="${GIT_COMMIT}"
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
STOPSIGNAL SIGTERM
CMD ["node", "dist/main.js"]
