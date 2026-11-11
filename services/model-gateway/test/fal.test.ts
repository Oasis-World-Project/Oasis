import { describe, expect, it } from 'vitest';
import { createFalClient } from '../src/adapters/fal.ts';

describe('fal 队列与媒体边界', () => {
  it('只在队列请求带凭据；拒绝跨来源句柄和不受信媒体重定向', async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const client = createFalClient({
      baseUrl: 'https://queue.fal.run',
      apiKey: 'test',
      mediaHosts: ['fal.media'],
      fetcher: async (input, init) => {
        const url = String(input);
        calls.push({ url, auth: new Headers(init?.headers).get('authorization') });
        return url.includes('redirect')
          ? new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } })
          : new Response('audio', { headers: { 'content-type': 'audio/mpeg' } });
      },
    });
    const memo = { model: 'fal-ai/music', micro: 150_000 };
    const handle = client.handle(
      {
        request_id: 'one',
        status_url: 'https://queue.fal.run/fal-ai/music/requests/one/status',
        response_url: 'https://queue.fal.run/fal-ai/music/requests/one',
        // 供应商回的正文里就算带了 memo 也不认，只记提交时自己给的
        memo: { model: 'other', micro: 1 },
      },
      memo,
    );
    expect(client.memo(handle)).toEqual(memo);
    // 这项改动之前存下的任务号没有 memo
    expect(client.memo(JSON.stringify({ ...JSON.parse(handle), memo: undefined }))).toBeUndefined();
    await client.status(handle);
    await client.cancel(handle);
    await client.media('https://v3.fal.media/audio.mp3');
    expect(calls[1]?.url).toBe('https://queue.fal.run/fal-ai/music/requests/one/cancel');
    expect(calls.map((call) => call.auth)).toEqual(['Key test', 'Key test', null]);
    expect(() =>
      client.handle(
        {
          request_id: 'x',
          status_url: 'https://evil.example/x',
          response_url: 'https://queue.fal.run/result',
        },
        memo,
      ),
    ).toThrow('不安全');
    await expect(client.media('https://v3.fal.media/redirect')).rejects.toThrow('放行范围');
    await expect(client.media('https://fal.media.evil.example/a')).rejects.toThrow('放行范围');
  });

  it('下载按速度判断：够快的不限总时长；只有一点点在来、或连上后没动静的掐断', async () => {
    // 每 everyMs 来 bytes 字节，一共 times 段
    const stream = (everyMs: number, bytes: number, times: number, signal: AbortSignal) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          let sent = 0;
          const stop = () => clearInterval(tick);
          const tick = setInterval(() => {
            controller.enqueue(new Uint8Array(bytes));
            sent += 1;
            if (sent < times) return;
            stop();
            controller.close();
          }, everyMs);
          signal.addEventListener(
            'abort',
            () => {
              stop();
              controller.error(signal.reason);
            },
            { once: true },
          );
        },
      });
    const client = createFalClient({
      baseUrl: 'https://queue.fal.run',
      mediaHosts: ['fal.media'],
      // 每 60 毫秒至少 64 字节
      mediaFlow: { windowMs: 60, minBytes: 64 },
      fetcher: async (input, init) => {
        const url = String(input);
        const body = url.includes('fast')
          ? stream(10, 64, 20, init!.signal!) // 一共 200 毫秒，是窗口的三倍多
          : url.includes('trickle')
            ? stream(10, 1, 1000, init!.signal!) // 一直有字节，但每个窗口只有几个
            : stream(100_000, 1, 1, init!.signal!); // 连上后什么都不来
        return new Response(body, { headers: { 'content-type': 'model/gltf-binary' } });
      },
    });
    const fast = await client.media('https://v3.fal.media/fast.glb');
    expect(fast.headers.get('content-type')).toBe('model/gltf-binary');
    expect((await fast.arrayBuffer()).byteLength).toBe(1280);
    for (const name of ['trickle', 'silent']) {
      const slow = await client.media(`https://v3.fal.media/${name}.glb`);
      await expect(slow.arrayBuffer()).rejects.toThrow('fal 媒体下载太慢');
    }
  });
});
