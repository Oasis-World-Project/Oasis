# harness 的沙箱基础镜像：Node 24 + Python 3 + 精确锁定版本的 dsh + Oasis 自己的 dsh 组合（oasis profile）+ oasis-tool。
# 每次 agent 运行起一个这个镜像的容器（ADR 0003 §6），容器里只跑 dsh，经 stdin/stdout 说 JSON-RPC。
# dsh 版本只在这里锁定；升级时同时改镜像标签（harness 和 scripts/sandbox.mjs 的 SANDBOX_IMAGE 默认值）。
# 构建（在仓库根目录）：pnpm sandbox:build
ARG NODE_IMAGE=node:24.21.0-trixie-slim
FROM ${NODE_IMAGE}
ARG DSH_VERSION=0.2.1-rc.5
# 通用文档/数据工具（ADR 0008 G1）；预装包在独立 venv 内，运行时仍可经出口代理安装任务需要的包。
ARG APT_RETRIES=3
RUN apt-get -o Acquire::Retries=${APT_RETRIES} update \
 && attempt=0 \
 && until apt-get -o Acquire::Retries=${APT_RETRIES} install -y --no-install-recommends python3 python3-pip python3-venv fonts-noto-cjk \
    libreoffice-writer=4:25.2.3-2+deb13u8 libreoffice-calc=4:25.2.3-2+deb13u8 libreoffice-impress=4:25.2.3-2+deb13u8 \
    ffmpeg=7:7.1.5-0+deb13u1 poppler-utils=25.03.0-5+deb13u4 libpango-1.0-0=1.56.3-1 libpangoft2-1.0-0=1.56.3-1 \
    melt=7.30.0-1+b2 frei0r-plugins=2.3.3-1+b1; do \
      attempt=$((attempt + 1)); \
      if [ "$attempt" -ge "$APT_RETRIES" ]; then exit 1; fi; \
    done \
 && rm -rf /var/lib/apt/lists/*
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PATH="/opt/oasis/venv/bin:${PATH}" \
    MPLBACKEND=Agg \
    MPLCONFIGDIR=/home/node/.config/matplotlib \
    OASIS_SOFTWARE_MANIFEST=/opt/oasis/software.txt
COPY services/harness/sandbox/requirements.txt /opt/oasis/requirements.txt
RUN --mount=type=secret,id=pip_index \
    python3 -m venv /opt/oasis/venv \
 && if [ -f /run/secrets/pip_index ]; then export PIP_INDEX_URL="$(cat /run/secrets/pip_index)"; fi \
 && /opt/oasis/venv/bin/python -m pip install --no-cache-dir --only-binary=:all: -r /opt/oasis/requirements.txt \
 && /opt/oasis/venv/bin/python -m pip check \
 && chown -R node:node /opt/oasis/venv \
 && mkdir -p /home/node/.config/matplotlib \
 && printf 'font.family: sans-serif\nfont.sans-serif: Noto Sans CJK JP, DejaVu Sans\naxes.unicode_minus: False\n' > /home/node/.config/matplotlib/matplotlibrc \
 && chown -R node:node /home/node/.config \
 && printf '系统软件（无界面）：\n' > /opt/oasis/software.txt \
 && dpkg-query -W -f='${Package} ${Version}\n' libreoffice-writer libreoffice-calc libreoffice-impress ffmpeg poppler-utils fonts-noto-cjk melt frei0r-plugins >> /opt/oasis/software.txt \
 && printf '\nPython 包（使用 python3，无需激活环境）：\n' >> /opt/oasis/software.txt \
 && /opt/oasis/venv/bin/python -m pip list --format=freeze >> /opt/oasis/software.txt
# 不跑安装脚本：dsh 用到的原生组件都是预编译包
ARG NPM_RETRIES=3
RUN --mount=type=secret,id=npm_registry \
    if [ -f /run/secrets/npm_registry ]; then export npm_config_registry="$(cat /run/secrets/npm_registry)"; fi \
 && attempt=0 \
 && until npm install --global --ignore-scripts --fetch-retries=0 --fetch-timeout=60000 "@deepseek-ai/dsh@${DSH_VERSION}"; do \
      attempt=$((attempt + 1)); \
      if [ "$attempt" -ge "$NPM_RETRIES" ]; then exit 1; fi; \
    done \
 && npm cache clean --force \
 && mkdir -p /workspace/in /workspace/out \
 && chown -R node:node /workspace
USER node
ENV DSH_HOME=/home/node/.dsh \
    DSH_PERMISSION_MODE=danger-full-access \
    NODE_ENV=production
# 从 dsh 自带的 sdk 模板复制出 oasis profile，再叠上 Oasis 的组合（关掉用不上的插件、模型指向 model-gateway）
RUN dsh oasis --from-default-profile sdk --dump-config > /dev/null
RUN mkdir -p /home/node/.dsh/sessions
COPY --chown=node:node services/harness/src/adapter/profile/cordis.patch.yml /home/node/.dsh/profiles/oasis/cordis.patch.yml
# 沙箱里调用 Oasis 工具的命令（ADR 0006）：Node 直接运行 TypeScript
COPY services/harness/sandbox/oasis-tool.ts /opt/oasis/oasis-tool.ts
COPY services/harness/sandbox/batch.ts /opt/oasis/batch.ts
COPY services/harness/sandbox/media.py /opt/oasis/media.py
USER root
RUN printf '#!/bin/sh\nexec node --no-warnings /opt/oasis/oasis-tool.ts "$@"\n' > /usr/local/bin/oasis-tool \
 && printf '#!/bin/sh\nexec python3 /opt/oasis/media.py "$@"\n' > /usr/local/bin/oasis-media \
 && chmod 755 /usr/local/bin/oasis-tool /usr/local/bin/oasis-media
USER node
COPY --chown=node:node services/harness/src/adapter/profile/node-goal.mjs /opt/oasis/node-goal.mjs
WORKDIR /workspace
ENTRYPOINT ["dsh", "--profile", "oasis"]
