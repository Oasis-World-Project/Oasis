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
    const handle = client.handle({
      request_id: 'one',
      status_url: 'https://queue.fal.run/fal-ai/music/requests/one/status',
      response_url: 'https://queue.fal.run/fal-ai/music/requests/one',
    });
    await client.status(handle);
    await client.media('https://v3.fal.media/audio.mp3');
    expect(calls.map((call) => call.auth)).toEqual(['Key test', null]);
    expect(() =>
      client.handle({
        request_id: 'x',
        status_url: 'https://evil.example/x',
        response_url: 'https://queue.fal.run/result',
      }),
    ).toThrow('不安全');
    await expect(client.media('https://v3.fal.media/redirect')).rejects.toThrow('放行范围');
    await expect(client.media('https://fal.media.evil.example/a')).rejects.toThrow('放行范围');
  });
});
