#!/usr/bin/env node
// 开发期数字人入口的 SSH 反向隧道（ADR 0013 §6）：服务器 127.0.0.1:15200 → 本机 model-gateway 的数字人端口。
// 服务器上的 nginx 只把 https://oasis-dev.elysiumgrid.space/avatar/v1/chat/completions 转到 15200，其余 404。
// 用法：pnpm avatar:tunnel（Ctrl+C 结束；断线会自动重连）
// 主机名取本机 ~/.ssh/config 里的条目，可用 AVATAR_TUNNEL_HOST 覆盖；本机端口可用 AVATAR_LLM_PORT 覆盖。
import { spawn } from 'node:child_process';

const host = process.env.AVATAR_TUNNEL_HOST ?? 'tarot-tencent';
const localPort = Number(process.env.AVATAR_LLM_PORT ?? 4118);
const remotePort = Number(process.env.AVATAR_TUNNEL_REMOTE_PORT ?? 15200);
let stopping = false;
let ssh;

// 退出时一并结束 ssh（只注册一次，重连不再重复注册）
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    stopping = true;
    ssh?.kill();
    process.exit(0);
  });
}

function open() {
  console.log(`隧道：${host} 127.0.0.1:${remotePort} → 本机 127.0.0.1:${localPort}`);
  ssh = spawn(
    'ssh',
    [
      '-N',
      '-o',
      'IPQoS=none',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ServerAliveInterval=30',
      '-o',
      'ServerAliveCountMax=3',
      '-R',
      `127.0.0.1:${remotePort}:127.0.0.1:${localPort}`,
      host,
    ],
    { stdio: 'inherit' },
  );
  ssh.on('exit', (code) => {
    if (stopping) return;
    console.log(`隧道断开（退出码 ${code}），5 秒后重连`);
    setTimeout(open, 5000);
  });
}

open();
