# harness 的沙箱基础镜像：Node 24 + Python 3 + 精确锁定版本的 dsh + Oasis 自己的 dsh 组合（oasis profile）+ oasis-tool。
# 每次 agent 运行起一个这个镜像的容器，容器里只跑 dsh，经 stdin/stdout 说 JSON-RPC。
# dsh 版本只在这里锁定；升级时同时改镜像标签（harness 和 scripts/sandbox.mjs 的 SANDBOX_IMAGE 默认值）。
# 构建（在仓库根目录）：pnpm sandbox:build
# 基础镜像连摘要一起锁：同一个标签以后被重新构建也不影响我们
ARG NODE_IMAGE=node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66
FROM ${NODE_IMAGE}
ARG DSH_VERSION=0.2.1-rc.5
# 通用文档/数据工具；预装包在独立 venv 内，运行时仍可经出口代理安装任务需要的包。
ARG APT_RETRIES=3
# 系统软件从 Debian 的快照源装：DEBIAN_SNAPSHOT 是官方软件仓库在那一刻的样子，同一个日期什么时候构建，装到的版本都一样。
# （以前给每个包写死小版本：官方仓库一出安全更新就把旧版本下架，过一阵子从头构建就失败。）
# 要拿安全更新：把日期往前挪，重新构建，跑 pnpm sandbox:check 和 sandbox:check:3d。实际装上的版本记在镜像里的
# 软件清单（/opt/oasis/software.txt）。日期不能早于基础镜像自己用的快照（写在它的 debian.sources 里）。
ARG DEBIAN_SNAPSHOT=20261114T000000Z
# 快照源在哪台主机上。snapshot-cloudflare.debian.org 是 Debian 官方给快照源开的 Cloudflare 入口，内容和
# snapshot.debian.org 一样。
ARG DEBIAN_SNAPSHOT_HOST=snapshot-cloudflare.debian.org
# 可选的 Debian 镜像站（如 https://mirrors.tuna.tsinghua.edu.cn），只用来加快下载：快照源只在国外，从国内下
# 很慢（2026-11-18 在开发机上量，约 50 kB/s，全部 687 MB 要几个小时；国内镜像站约 2 MB/s）。装哪个版本仍然
# 只听快照源的（下面把它的优先级定成 1001）；镜像站上有同一个版本就从镜像站下，没有的才从快照源下。
# 同一个版本的包在哪下都是同一个文件，apt 照常校验签名和哈希。镜像站单独写在一个软件源文件里（文件名排在
# 前面，apt 就先从它下），这一层装完就删掉：配不配镜像站，造出来的镜像一样。
ARG APT_MIRROR=
# 走 https。这一层开始时镜像里还没有 CA 证书，所以第一步装 ca-certificates 时不校验服务器证书——包本身的
# 签名 apt 照常校验，和走 http 一样安全；装好以后的下载都校验证书。
# 快照的 Release 文件过了有效期（Check-Valid-Until）是正常的；这些设置留在镜像里，接着它构建的镜像（3D）也用得上。
RUN sed -i \
      -e "s#^URIs: http://deb.debian.org/debian-security\$#URIs: https://${DEBIAN_SNAPSHOT_HOST}/archive/debian-security/${DEBIAN_SNAPSHOT}#" \
      -e "s#^URIs: http://deb.debian.org/debian\$#URIs: https://${DEBIAN_SNAPSHOT_HOST}/archive/debian/${DEBIAN_SNAPSHOT}#" \
      /etc/apt/sources.list.d/debian.sources \
 && test "$(grep -c "^URIs: https://${DEBIAN_SNAPSHOT_HOST}/archive/debian.*/${DEBIAN_SNAPSHOT}\$" /etc/apt/sources.list.d/debian.sources)" = 2 \
 && printf 'Package: *\nPin: origin "%s"\nPin-Priority: 1001\n' "${DEBIAN_SNAPSHOT_HOST}" > /etc/apt/preferences.d/oasis-snapshot \
 && if [ -n "$APT_MIRROR" ]; then \
      keyring="$(sed -n 's/^Signed-By: //p' /etc/apt/sources.list.d/debian.sources | head -n 1)"; \
      printf 'Types: deb\nURIs: %s/debian\nSuites: trixie trixie-updates\nComponents: main\nSigned-By: %s\n\nTypes: deb\nURIs: %s/debian-security\nSuites: trixie-security\nComponents: main\nSigned-By: %s\n' \
        "$APT_MIRROR" "$keyring" "$APT_MIRROR" "$keyring" > /etc/apt/sources.list.d/00-oasis-mirror.sources; \
    fi \
 && printf 'Acquire::Check-Valid-Until "false";\nAcquire::Retries "%s";\n' "${APT_RETRIES}" > /etc/apt/apt.conf.d/99oasis-snapshot \
 && apt-get -o Acquire::https::Verify-Peer=false -o Acquire::https::Verify-Host=false update \
 && apt-get -o Acquire::https::Verify-Peer=false -o Acquire::https::Verify-Host=false install -y --no-install-recommends ca-certificates \
 && apt-get update \
 # PostgreSQL 的程序装上就行：不要它在安装时自己建一个归 postgres 用户的库（AI 以普通用户在工作目录里另起）
 && mkdir -p /etc/postgresql-common \
 && printf 'create_main_cluster = false\n' > /etc/postgresql-common/createcluster.conf \
 && attempt=0 \
 && until apt-get -o Acquire::Retries=${APT_RETRIES} install -y --no-install-recommends python3 python3-pip python3-venv fonts-noto-cjk \
    libreoffice-writer libreoffice-calc libreoffice-impress \
    ffmpeg poppler-utils libpango-1.0-0 libpangoft2-1.0-0 \
    melt frei0r-plugins \
    chromium fonts-noto-color-emoji fonts-unifont \
    pandoc sqlite3 jq imagemagick \
    sox git ripgrep zip unzip \
    postgresql mariadb-server valkey-server \
    curl xz-utils pkg-config libssl-dev libpq-dev python3-dev \
    make g++; do \
      attempt=$((attempt + 1)); \
      if [ "$attempt" -ge "$APT_RETRIES" ]; then exit 1; fi; \
    done \
 && rm -rf /var/lib/apt/lists/* /etc/apt/sources.list.d/00-oasis-mirror.sources \
 # 用户导入的项目要数据库时，AI 以普通用户在工作目录里起一个（技能 projects 里写了怎么起）；这里只装程序、不启动。
 # Debian 把 initdb、pg_ctl、postgres 放在带版本号的目录里，连到 PATH 上
 && for tool in initdb pg_ctl postgres; do ln -s "$(ls -d /usr/lib/postgresql/*/bin)/$tool" "/usr/local/bin/$tool"; done \
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
    chromium fonts-noto-color-emoji fonts-unifont pandoc sqlite3 jq imagemagick sox git ripgrep zip unzip make g++ curl xz-utils pkg-config libssl-dev libpq-dev python3-dev >> /opt/oasis/software.txt \
 && printf '\n数据库程序（不自动启动；要用时以普通用户在工作目录里起，见技能 projects）：\n' >> /opt/oasis/software.txt \
 && dpkg-query -W -f='${Package} ${Version}\n' 'postgresql-[0-9][0-9]' mariadb-server valkey-server >> /opt/oasis/software.txt \
 # 成果里要内嵌字体时用这里的（沙箱不通外网）。Unifont 是点阵字体：真实对比里做像素风小游戏的 AI 没有现成的像素字体，
 # 自己一笔一笔画了几十个汉字，占掉三分之一的步骤
 && printf '\n字体（在 /usr/share/fonts 下，可以拷进成果或取子集后内嵌，都是 OFL 许可）：\nNoto Sans CJK、Noto Serif CJK（中日韩）\nNoto Color Emoji\nUnifont（16×16 点阵像素字体，含中文）%s\n' "$(fc-list Unifont file | grep -m1 -E '/unifont\.(otf|ttf)' | cut -d: -f1 | sed 's/^/：/')" >> /opt/oasis/software.txt \
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
 && mkdir -p /workspace/in /workspace/out /cache \
 # /cache：每个用户一块的缓存卷挂在这里（下载下来的包和工具链，见 harness 的 executor），先建好并交给沙箱用户
 && chown -R node:node /workspace /cache
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
# 不设 NODE_ENV：这里的环境变量 AI 跑的每条命令都会继承，设成 production 的话 npm 默认不装 devDependencies，
# 接手现成项目时测试工具装不上（2026-11-19 真模型验收时碰到）。
ENV DSH_HOME=/home/node/.dsh \
    DSH_PERMISSION_MODE=danger-full-access
# 从 dsh 自带的 sdk 模板复制出 oasis profile，再叠上 Oasis 的组合（关掉用不上的插件、模型指向 model-gateway）
RUN dsh oasis --from-default-profile sdk --dump-config > /dev/null
RUN mkdir -p /home/node/.dsh/sessions
COPY --chown=node:node services/harness/src/adapter/profile/cordis.patch.yml services/harness/src/adapter/profile/node-goal.mjs services/harness/src/adapter/profile/approval.mjs /home/node/.dsh/profiles/oasis/
# 沙箱里调用 Oasis 工具的命令：Node 直接运行 TypeScript
COPY services/harness/sandbox/oasis-tool.ts /opt/oasis/oasis-tool.ts
COPY services/harness/sandbox/tool-api.ts services/harness/sandbox/batch.ts services/harness/sandbox/tool-files.ts /opt/oasis/
COPY services/harness/sandbox/media.py /opt/oasis/media.py
# 本地操作 oasis-op（拼视频、裁剪、抽帧……；参数定义与 model-gateway 共用 packages/contracts 里的同一份）。
# 按仓库里的相对位置放，import 路径在仓库和镜像里一致。
COPY packages/contracts/src/tool-args.ts packages/contracts/src/ops.ts /opt/oasis/packages/contracts/src/
COPY services/harness/sandbox/oasis-op.ts /opt/oasis/services/harness/sandbox/
USER root
RUN printf '#!/bin/sh\nexec node --no-warnings /opt/oasis/oasis-tool.ts "$@"\n' > /usr/local/bin/oasis-tool \
 && printf '#!/bin/sh\nexec python3 /opt/oasis/media.py "$@"\n' > /usr/local/bin/oasis-media \
 && printf '#!/bin/sh\nexec node --no-warnings /opt/oasis/services/harness/sandbox/oasis-op.ts "$@"\n' > /usr/local/bin/oasis-op \
 && chmod 755 /usr/local/bin/oasis-tool /usr/local/bin/oasis-media /usr/local/bin/oasis-op
USER node
# 用时再装的工具链（Go、Rust、JDK……）装在缓存卷 /cache 里：命令放在这几个目录下就直接能用
ENV PATH="/cache/bin:/cache/cargo/bin:/cache/go/bin:${PATH}"
WORKDIR /workspace
ENTRYPOINT ["dsh", "--profile", "oasis"]
