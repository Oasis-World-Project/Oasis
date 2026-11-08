# inspector 的检查浏览器（ADR 0024）：应用与 Chromium 同容器、无外部网络；应用文件由 inspector 启动前拷入。
# 构建（在仓库根目录）：pnpm browser:build
FROM mcr.microsoft.com/playwright:v1.64.0-noble
RUN mkdir -p /opt/oasis /workspace/app \
 && npm install --prefix /opt/oasis --ignore-scripts --save-exact playwright-core@1.64.0 \
 && npm cache clean --force \
 && chown -R pwuser:pwuser /opt/oasis /workspace
COPY services/inspector/browser/controller.mjs services/inspector/browser/checks.mjs /opt/oasis/
USER pwuser
WORKDIR /workspace/app
ENTRYPOINT ["node", "/opt/oasis/controller.mjs"]
