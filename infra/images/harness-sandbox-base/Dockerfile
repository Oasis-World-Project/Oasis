# harness 的沙箱基础镜像：Node 24 + 精确锁定版本的 dsh + Oasis 自己的 dsh 组合（oasis profile）+ oasis-tool。
# 每次 agent 运行起一个这个镜像的容器（ADR 0003 §6），容器里只跑 dsh，经 stdin/stdout 说 JSON-RPC。
# dsh 版本只在这里锁定；升级时同时改镜像标签（harness 的 SANDBOX_IMAGE 默认值）和 package.json 的 sandbox:build。
# 构建（在仓库根目录）：pnpm sandbox:build
ARG NODE_IMAGE=node:24.21.0-trixie-slim
FROM ${NODE_IMAGE}
ARG DSH_VERSION=0.2.1-rc.2
# 不跑安装脚本：dsh 用到的原生组件都是预编译包
RUN npm install --global --ignore-scripts "@deepseek-ai/dsh@${DSH_VERSION}" \
 && npm cache clean --force \
 && mkdir -p /workspace/in /workspace/out \
 && chown -R node:node /workspace
USER node
ENV DSH_HOME=/home/node/.dsh \
    DSH_PERMISSION_MODE=danger-full-access \
    NODE_ENV=production
# 从 dsh 自带的 sdk 模板复制出 oasis profile，再叠上 Oasis 的组合（关掉用不上的插件、模型指向 model-gateway）
RUN dsh oasis --from-default-profile sdk --dump-config > /dev/null
COPY --chown=node:node services/harness/src/adapter/profile/cordis.patch.yml /home/node/.dsh/profiles/oasis/cordis.patch.yml
# 沙箱里调用 Oasis 工具的命令（ADR 0006）：Node 直接运行 TypeScript
COPY services/harness/sandbox/oasis-tool.ts /opt/oasis/oasis-tool.ts
USER root
RUN printf '#!/bin/sh\nexec node --no-warnings /opt/oasis/oasis-tool.ts "$@"\n' > /usr/local/bin/oasis-tool \
 && chmod 755 /usr/local/bin/oasis-tool
USER node
WORKDIR /workspace
ENTRYPOINT ["dsh", "--profile", "oasis"]
