// BrowserStack 适配器：Android 检查中断后的会话恢复。
import type { ServiceClient } from '@oasis/service-kit';
import { describe, expect, it } from 'vitest';
import { createBrowserStackClient } from '../src/adapters/browserstack.ts';

const UPLOAD_ID = '7d0c2f1e-1b2a-4c3d-8e4f-5a6b7c8d9e0f';

describe('Android 会话恢复', () => {
  const handle = JSON.stringify({
    uploadId: UPLOAD_ID,
    device: 'Samsung Galaxy S23',
    osVersion: '13.0',
    app: 'bs://abc123',
    sha256: 'abc',
    steps: [{ action: 'screenshot' }],
  });
  function setup(phase: string) {
    const calls: string[] = [];
    const receipt = {
      saved: {
        phase,
        sessionId: phase === 'creating' ? undefined : 'session-1',
        startedAt: 1,
        report: {
          version: 1,
          target: 'android',
          passed: true,
          steps: [],
          diagnostics: [],
          unchecked: [],
        },
        screenshots: [],
      },
      async save(value: unknown) {
        this.saved = structuredClone(value) as typeof this.saved;
      },
    };
    const client = createBrowserStackClient({
      username: 'test',
      accessKey: 'test',
      apiUrl: 'https://api.example',
      hubUrl: 'https://hub.example',
      canvas: {} as ServiceClient,
      fetcher: async (url, options) => {
        calls.push(`${options?.method} ${String(url)}`);
        return Response.json({ value: null });
      },
    });
    return { client, receipt, calls };
  }
  it('中断后关闭已知设备，不重放操作，结果标为未检查；重复取回不重复关闭', async () => {
    const { client, receipt, calls } = setup('running');
    const result = await client.check(handle, receipt, AbortSignal.timeout(1000));
    expect(result.state).toBe('completed');
    if (result.state === 'completed') expect(result.outcome.data.report.passed).toBe(false);
    await client.check(handle, receipt, AbortSignal.timeout(1000));
    expect(calls.filter((call) => call.includes('/session/'))).toHaveLength(1);
    expect(calls.every((call) => call.startsWith('DELETE'))).toBe(true);
  });
  it('创建响应丢失时不新开设备，保留待核对状态并删除本次 APK', async () => {
    const { client, receipt, calls } = setup('creating');
    expect((await client.check(handle, receipt, AbortSignal.timeout(1000))).state).toBe(
      'uncertain',
    );
    expect(calls).toEqual(['DELETE https://api.example/app-automate/app/delete/abc123']);
  });
});
