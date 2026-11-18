// 工具服务：fal 上按型号标价的两个工具（生成音乐、生成 3D）——冻结跟着型号走、按时长计价、文字生成 3D。
import { describe, expect, it } from 'vitest';
import { knobs, PAYER, billingCalls } from './support/tool-fakes.ts';
import { tools, falCalls, geometryImage, useTools, call, errorOf } from './support/tool-fixture.ts';

describe('fal 上按型号标价的工具', () => {
  it('按时长计价的型号照 duration 算标价，冻结跟着型号的标价走；供应商下游出错算没生成', async () => {
    useTools('key', true);
    const held = () => billingCalls.filter((c) => c.path === 'hold').map((c) => c.body.amountMicro);
    const settled = () =>
      billingCalls.filter((c) => c.path === 'settle').map((c) => c.body.costMicro);
    // ElevenLabs：每分钟 $0.6、不足一分钟按一分钟，90 秒算两分钟；冻结是标价的 1.2 倍
    const eleven = (
      await call('audio.music', {
        prompt: 'Cinematic orchestral piece',
        instrumental: true,
        duration: '90',
        model: 'elevenlabs/music/v2.5',
      })
    ).job!.id;
    expect(falCalls.at(-1)).toEqual({
      url: 'https://queue.fal.run/elevenlabs/music/v2.5',
      input: {
        prompt: 'Cinematic orchestral piece',
        music_length_ms: 90_000,
        force_instrumental: true,
      },
    });
    await tools.job({ payerId: PAYER }, eleven, AbortSignal.timeout(1000));
    // MiniMax Music 3：按秒，没有器乐开关；结果里的实际秒数比要的短，照实际的算
    knobs.falResult = { audio: { url: 'https://v3.fal.media/files/b/song.wav' }, duration: 41.5 };
    const mini = (
      await call('audio.music', {
        prompt: 'Warm acoustic pop',
        instrumental: true,
        model: 'minimax/music-3',
      })
    ).job!.id;
    expect(falCalls.at(-1)?.input).toEqual({
      prompt: 'Warm acoustic pop',
      lyrics: '[instrumental]',
      duration: 60,
    });
    const done = await tools.job({ payerId: PAYER }, mini, AbortSignal.timeout(1000));
    expect(done.result?.files[0]).toMatchObject({ name: 'music.wav', mediaType: 'audio/wav' });
    knobs.falResult = null;
    // 排到了、取结果时供应商说它下游的服务出错（真实返回，2026-11-19）：算没生成，不收费，不再反复去取
    knobs.falResultStatus = 500;
    knobs.falResult = {
      detail: [{ msg: 'Downstream service error', type: 'downstream_service_error' }],
    };
    const broken = (
      await call('audio.music', { prompt: 'Warm piano and strings', instrumental: true })
    ).job!.id;
    expect(await tools.job({ payerId: PAYER }, broken, AbortSignal.timeout(1000))).toMatchObject({
      status: 'failed',
      error: '音乐供应商没有生成：Downstream service error',
    });
    expect(held()).toEqual([1_440_000, 500_000, 500_000]);
    expect(settled()).toEqual([1_200_000, 83_000]);
  });
  it('文字生成 3D：给文字的用吃文字的型号，给图的用吃图的；冻结跟着型号的标价走', async () => {
    knobs.geometryMode = true;
    useTools('key', true);
    const held = () => billingCalls.filter((c) => c.path === 'hold').map((c) => c.body.amountMicro);
    const settled = () =>
      billingCalls.filter((c) => c.path === 'settle').map((c) => c.body.costMicro);
    // 不点名、只给文字：用第一个吃文字的型号
    const text = (await call('3d.generate', { prompt: '一只陶瓷茶壶' })).job!.id;
    expect(falCalls.findLast((c) => c.input)).toEqual({
      url: 'https://queue.fal.run/meshy/v7.1/text-to-3d',
      input: { prompt: '一只陶瓷茶壶' },
    });
    const done = await tools.job({ payerId: PAYER }, text, AbortSignal.timeout(1000));
    expect(done.result?.text).toContain('文字描述');
    // Rodin：图放在 image_urls 里，GLB 在 model_mesh
    knobs.falResult = { model_mesh: { url: 'https://v3.fal.media/rodin.glb' }, textures: [] };
    const rodin = (
      await call('3d.generate', { image: geometryImage, model: 'fal-ai/hyper3d/rodin/v2.5' })
    ).job!.id;
    expect(Object.keys(falCalls.findLast((c) => c.input)!.input!)).toEqual([
      'image_urls',
      'geometry_file_format',
    ]);
    await tools.job({ payerId: PAYER }, rodin, AbortSignal.timeout(1000));
    expect(falCalls.at(-1)?.url).toBe('https://v3.fal.media/rodin.glb');
    knobs.falResult = null;
    // 图和文字都写、都不写，点名的型号吃的不是这一种：提交前就拒绝
    const submitted = falCalls.length;
    for (const wrong of [
      {},
      { image: geometryImage, prompt: '一只陶瓷茶壶' },
      { prompt: '一只陶瓷茶壶', model: 'fal-ai/trellis-2' },
      { image: geometryImage, model: 'meshy/v7.1/text-to-3d' },
    ])
      expect(await errorOf(call('3d.generate', wrong))).toMatchObject({
        code: 'invalid_tool_args',
      });
    expect(falCalls).toHaveLength(submitted);
    expect(held()).toEqual([1_440_000, 1_000_000]);
    expect(settled()).toEqual([1_200_000, 400_000]);
  });
});
