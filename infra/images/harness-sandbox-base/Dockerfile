# harness 的沙箱基础镜像：Node 24 + Python 3 + 精确锁定版本的 dsh + Oasis 自己的 dsh 组合（oasis profile）+ oasis-tool。
# 每次 agent 运行起一个这个镜像的容器（ADR 0003 §6），容器里只跑 dsh，经 stdin/stdout 说 JSON-RPC。
# dsh 版本只在这里锁定；升级时同时改镜像标签（harness 和 scripts/sandbox.mjs 的 SANDBOX_IMAGE 默认值）。
# 构建（在仓库根目录）：pnpm sandbox:build
ARG NODE_IMAGE=node:24.21.0-trixie-slim
FROM ${NODE_IMAGE}
ARG DSH_VERSION=0.2.1-rc.5
# 通用文档/数据工具（ADR 0008 G1）；预装包在独立 venv 内，运行时仍可经出口代理安装任务需要的包。
ARG APT_RETRIES=3
# 可选的 Debian 镜像站（如 https://mirrors.tuna.tsinghua.edu.cn）：deb.debian.org 太慢时用，只影响构建。
# 这一层开始时镜像里还没有 CA 证书，https 的镜像站改走 http；包的签名由 apt 自己校验。
ARG APT_MIRROR=
RUN if [ -n "$APT_MIRROR" ]; then sed -i "s#http://deb.debian.org#$(printf %s "$APT_MIRROR" | sed 's#^https://#http://#')#g" /etc/apt/sources.list.d/debian.sources; fi \
 && apt-get -o Acquire::Retries=${APT_RETRIES} update \
 && attempt=0 \
 && until apt-get -o Acquire::Retries=${APT_RETRIES} install -y --no-install-recommends python3 python3-pip python3-venv fonts-noto-cjk \
    libreoffice-writer=4:25.2.3-2+deb13u9 libreoffice-calc=4:25.2.3-2+deb13u9 libreoffice-impress=4:25.2.3-2+deb13u9 \
    ffmpeg=7:7.1.5-0+deb13u1 poppler-utils=25.03.0-5+deb13u4 libpango-1.0-0=1.56.3-1 libpangoft2-1.0-0=1.56.3-1 \
    melt=7.30.0-1+b2 frei0r-plugins=2.3.3-1+b1 \
    chromium=156.0.8078.79-1~deb13u1 fonts-noto-color-emoji=2.051-0+deb13u1 \
    pandoc=3.1.11.1+ds-2 sqlite3=3.46.1-7+deb13u2 jq=1.7.1-6+deb13u4 imagemagick=8:7.1.1.43+dfsg1-1+deb13u14 \
    sox=14.4.2+git20190427-5+b3 git=1:2.47.3-0+deb13u1 ripgrep=14.1.1-1+b4 zip=3.0-15+deb13u1 unzip=6.0-29+deb13u1 \
    make=4.4.1-2 g++=4:14.2.0-1; do \
      attempt=$((attempt + 1)); \
      if [ "$attempt" -ge "$APT_RETRIES" ]; then exit 1; fi; \
    done \
 && rm -rf /var/lib/apt/lists/* \
 # 沙箱以非 root、无特权、/dev/shm 只有 64 MB 运行，也没有显卡：这三项写成 Chromium 的默认参数，命令行和 playwright-core 都用得上
 && printf 'export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --no-sandbox --disable-dev-shm-usage --enable-unsafe-swiftshader"\n' > /etc/chromium.d/oasis
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
 && dpkg-query -W -f='${Package} ${Version}\n' libreoffice-writer libreoffice-calc libreoffice-impress ffmpeg poppler-utils fonts-noto-cjk melt frei0r-plugins \
    chromium fonts-noto-color-emoji pandoc sqlite3 jq imagemagick sox git ripgrep zip unzip make g++ >> /opt/oasis/software.txt \
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
# 预装的 Node 包从根目录的 /node_modules 找得到：Node 找包时一路往上找，任何目录下的脚本都能直接 import / require，
# 工作目录里自己装的同名包优先。包装在 /opt/oasis/node 再连过去（npm 不能在根目录下安装）。
# playwright-core 不自带浏览器，用上面 apt 装的 Chromium。
ARG PLAYWRIGHT_VERSION=1.64.0
ARG ESBUILD_VERSION=0.28.2
ARG TYPESCRIPT_VERSION=6.0.3
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/oasis/browsers \
    PATH="/node_modules/.bin:${PATH}"
RUN --mount=type=secret,id=npm_registry \
    if [ -f /run/secrets/npm_registry ]; then export npm_config_registry="$(cat /run/secrets/npm_registry)"; fi \
 && mkdir -p /opt/oasis/node && cd /opt/oasis/node \
 && attempt=0 \
 && until npm install --ignore-scripts --no-save --fetch-retries=0 --fetch-timeout=60000 \
      "playwright-core@${PLAYWRIGHT_VERSION}" "esbuild@${ESBUILD_VERSION}" "typescript@${TYPESCRIPT_VERSION}"; do \
      attempt=$((attempt + 1)); \
      if [ "$attempt" -ge "$NPM_RETRIES" ]; then exit 1; fi; \
    done \
 && npm cache clean --force \
 && ln -s /opt/oasis/node/node_modules /node_modules \
 && printf '\nNode 包（任何目录下可直接 import / require；浏览器用 chromium 命令或 playwright-core 的 chromium.launch()）：\nplaywright-core %s\nesbuild %s\ntypescript %s\n' "${PLAYWRIGHT_VERSION}" "${ESBUILD_VERSION}" "${TYPESCRIPT_VERSION}" >> /opt/oasis/software.txt \
 # playwright-core 按自己的版本号到 PLAYWRIGHT_BROWSERS_PATH 下找浏览器，找不到时报出那个路径：把它连到系统的 Chromium，
 # 不带参数的 chromium.launch() 就能用；最后真的开一页确认能渲染。
 && cd /opt/oasis \
 && node --input-type=module -e 'import { mkdirSync, symlinkSync } from "node:fs"; import path from "node:path"; import { chromium } from "playwright-core"; for (let i = 0; i < 4; i += 1) { try { const browser = await chromium.launch(); const page = await browser.newPage(); await page.setContent("<p id=ok>ok</p>"); const text = await page.textContent("#ok"); await browser.close(); if (text !== "ok") throw new Error("page did not render"); console.log("playwright-core launches the system chromium"); process.exit(0); } catch (error) { const missing = /Executable doesn.t exist at (\S+)/.exec(String(error && error.message)); if (!missing) throw error; mkdirSync(path.dirname(missing[1]), { recursive: true }); symlinkSync("/usr/bin/chromium", missing[1]); } } throw new Error("could not link playwright-core to the system chromium");'
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
COPY services/harness/sandbox/batch.ts services/harness/sandbox/tool-files.ts /opt/oasis/
COPY services/harness/sandbox/media.py /opt/oasis/media.py
# 工具节点（ADR 0025）：步骤执行器 oasis-steps 和本地操作 oasis-op（参数定义与 task、model-gateway 共用
# packages/contracts 里的同一份）。按仓库里的相对位置放，import 路径在仓库和镜像里一致。
COPY packages/contracts/src/tool-args.ts packages/contracts/src/ops.ts /opt/oasis/packages/contracts/src/
COPY services/harness/sandbox/oasis-steps.ts services/harness/sandbox/oasis-op.ts /opt/oasis/services/harness/sandbox/
USER root
RUN printf '#!/bin/sh\nexec node --no-warnings /opt/oasis/oasis-tool.ts "$@"\n' > /usr/local/bin/oasis-tool \
 && printf '#!/bin/sh\nexec python3 /opt/oasis/media.py "$@"\n' > /usr/local/bin/oasis-media \
 && printf '#!/bin/sh\nexec node --no-warnings /opt/oasis/services/harness/sandbox/oasis-op.ts "$@"\n' > /usr/local/bin/oasis-op \
 && chmod 755 /usr/local/bin/oasis-tool /usr/local/bin/oasis-media /usr/local/bin/oasis-op
USER node
COPY --chown=node:node services/harness/src/adapter/profile/node-goal.mjs /opt/oasis/node-goal.mjs
WORKDIR /workspace
ENTRYPOINT ["dsh", "--profile", "oasis"]
