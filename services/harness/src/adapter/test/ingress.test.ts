// 真实入口镜像的断网回归：假网关与代理共用容器回环，没有供应商调用。
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function docker(args: string[]) {
  return spawnSync('docker', args, { encoding: 'utf8', timeout: 15_000 });
}

describe.skipIf(!process.env.OASIS_INGRESS_IMAGE)('沙箱入口真实镜像', () => {
  it('网关两个地址连接失败后立即恢复，保持路由白名单及付费人头隔离', async () => {
    const image = process.env.OASIS_INGRESS_IMAGE!;
    if (!/^oasis\/[a-z0-9._-]+:[\w.-]+$/.test(image)) throw new Error('test image must use oasis/');
    const directory = join(process.env.OASIS_INGRESS_TEST_DIR!, randomUUID());
    const name = `oasis-ingress-check-${randomUUID()}`;
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'backend.conf'),
      `pid /tmp/fake-gateway.pid;
events {}
http {
  access_log /tmp/fake-gateway-access.log;
  server {
    listen 18080;
    location / {
      if ($http_authorization != "Bearer fixture") { return 401; }
      default_type application/json;
      return 200 '{"path":"$uri","payer":"$http_x_oasis_payer_id","authorization":"$http_authorization"}';
    }
  }
}
`,
    );
    try {
      const started = docker([
        'run',
        '--rm',
        '--pull',
        'never',
        '-d',
        '--name',
        name,
        '--network',
        'none',
        '--add-host',
        'model.test:127.0.0.1',
        '--add-host',
        'model.test:127.0.0.2',
        '--env',
        'MODEL_GATEWAY_UPSTREAM=http://model.test:18080',
        '--mount',
        `type=bind,source=${directory},target=/fixture,readonly`,
        image,
      ]);
      expect(started.status, started.stderr).toBe(0);
      for (let attempt = 0; attempt < 50; attempt++) {
        if (
          docker(['exec', name, 'wget', '-q', '-O', '-', 'http://127.0.0.1:8080/healthz'])
            .status === 0
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const request = (path: string, authorization = 'Bearer fixture') =>
        docker([
          'exec',
          name,
          'wget',
          '-S',
          '-O',
          '-',
          '--post-data',
          '{}',
          '--header',
          `Authorization: ${authorization}`,
          '--header',
          'X-Oasis-Payer-Id: forged',
          `http://127.0.0.1:8080${path}`,
        ]);
      expect(request('/v1/chat/completions').stderr).toContain('502');
      const backend = docker(['exec', name, 'nginx', '-c', '/fixture/backend.conf']);
      expect(backend.status, backend.stderr).toBe(0);
      // 不等待默认 fail_timeout；两地址均失败后的下一次请求必须立即到达已恢复的网关。
      const recovered = request('/v1/chat/completions');
      expect(recovered.status, recovered.stderr).toBe(0);
      expect(JSON.parse(recovered.stdout)).toEqual({
        path: '/run/v1/chat/completions',
        payer: '',
        authorization: 'Bearer fixture',
      });
      expect(request('/v1/decisions').stdout).toContain('/run/v1/decisions');
      const inputPath = '/v1/tools/jobs/4a2ba294-b720-4a14-a065-4d910fe42a81/inputs/0';
      expect(request(inputPath).stdout).toContain(`/run${inputPath}`);
      expect(request('/internal/holds').stderr).toContain('403');
      expect(request('/v1/chat/completions', 'wrong').stderr).toContain('401');
    } finally {
      docker(['rm', '-f', name]);
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it.each([
    'http://user:password@host:4108',
    'http://host:4108/path',
    'http://host:4108;injected',
    'http://host:4108\ninjected',
  ])('拒绝非 origin 配置且不回显配置内容', (origin) => {
    const result = docker([
      'run',
      '--rm',
      '--pull',
      'never',
      '--network',
      'none',
      '--env',
      `MODEL_GATEWAY_UPSTREAM=${origin}`,
      '--entrypoint',
      'sh',
      process.env.OASIS_INGRESS_IMAGE!,
      '-c',
      '. /docker-entrypoint.d/19-model-gateway.envsh',
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain(origin);
  });
});
