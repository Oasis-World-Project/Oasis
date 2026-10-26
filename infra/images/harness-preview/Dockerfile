# 独立预览浏览器，应用与 Chromium 同容器、无外部网络；应用文件由 harness 启动前拷入。
FROM mcr.microsoft.com/playwright:v1.64.0-noble
RUN mkdir -p /opt/oasis /workspace/app \
 && npm install --prefix /opt/oasis --ignore-scripts --save-exact playwright-core@1.64.0 \
 && npm cache clean --force \
 && chown -R pwuser:pwuser /opt/oasis /workspace
COPY services/harness/preview/controller.mjs /opt/oasis/controller.mjs
USER pwuser
WORKDIR /workspace/app
ENTRYPOINT ["node", "/opt/oasis/controller.mjs"]
