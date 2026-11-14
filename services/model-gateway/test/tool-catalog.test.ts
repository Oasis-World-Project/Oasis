// 工具服务：工具目录（没配 Key 的不可用、「只用国内模型」的过滤）和目录里的单价。
import { describe, expect, it } from 'vitest';
import { knobs, billingCalls, noHistory } from './support/tool-fakes.ts';
import { build, call, errorOf, seen } from './support/tool-fixture.ts';

describe('工具目录', () => {
  it('列出全部工具；没配 Key 的标成不可用；不替哪个用户列时不过滤型号', async () => {
    knobs.domesticOnly = true;
    const list = await build(undefined).list();
    const byKey = Object.fromEntries(list.map((t) => [t.key, t]));
    expect(Object.keys(byKey)).toEqual([
      'website.test',
      'app.check',
      'android.test',
      '3d.render',
      '3d.generate',
      'image.generate',
      'media.inspect',
      'audio.speech',
      'audio.transcribe',
      'web.search',
      'web.fetch',
      'audio.music',
      'video.generate',
      'jev.decide',
      'model.ask',
      'text.batch',
      // 沙箱里的本地操作：不调供应商，一直可用
      'op.video.concat',
      'op.video.trim',
      'op.video.frames',
      'op.video.audio',
      'op.audio.concat',
      'op.media.convert',
    ]);
    expect(byKey['image.generate']).toMatchObject({
      available: true,
      models: ['bytedance-seed/seedream-4.5', 'openai/gpt-image-2'],
      defaultModel: 'bytedance-seed/seedream-4.5',
      local: false,
      per: { arg: 'n', default: 1 },
    });
    expect(byKey['image.generate']?.args.map((a) => a.name)).toContain('prompt');
    expect(byKey['op.video.concat']).toMatchObject({ available: true, local: true });
    expect(byKey['web.search']?.available).toBe(false);
  });

  it('这一轮打开了「只用国内模型」：目录只留国内厂商的型号，没有国内型号的工具不可用；不按模型厂商分的工具不受影响', async () => {
    const all = Object.fromEntries(
      (await build('k', true, true).list(false)).map((t) => [t.key, t]),
    );
    const list = await build('k', true, true).list(true);
    const byKey = Object.fromEntries(list.map((t) => [t.key, t]));
    expect(byKey['image.generate']).toMatchObject({
      available: true,
      models: ['bytedance-seed/seedream-4.5'],
      defaultModel: 'bytedance-seed/seedream-4.5',
      rates: [{ model: 'bytedance-seed/seedream-4.5' }],
    });
    expect(byKey['video.generate']?.models).toEqual(['alibaba/wan-2.7']);
    // 型号全是国外厂商的：整个工具不可用
    for (const key of ['media.inspect', 'audio.transcribe'])
      expect(byKey[key]).toMatchObject({ available: false, models: [], defaultModel: null });
    // 快速判断：专用的决策模型是国外的，剩下清单里的国内聊天模型
    expect(byKey['jev.decide']).toMatchObject({
      available: true,
      models: ['alibaba/judge-1'],
      defaultModel: 'alibaba/judge-1',
    });
    // 搜索（Tavily）、云渲染（Runpod）、音乐和 3D 生成（FAL）、浏览器检查、本地操作：和没开时一样
    for (const key of ['web.search', '3d.render', '3d.generate', 'audio.music', 'app.check'])
      expect(byKey[key]).toEqual(all[key]);
    expect(byKey['web.search']?.available).toBe(true);
    expect(byKey['3d.render']?.models).toEqual(['oasis/blender-cuda']);
  });

  it('开着「只用国内模型」时调用工具：默认用国内型号；点名国外型号或工具没有国内型号，调供应商之前就拒绝、不冻结', async () => {
    knobs.domesticOnly = true;
    const done = await call('image.generate', { prompt: 'x' });
    expect(done.text).toContain('bytedance-seed/seedream-4.5');
    const holds = billingCalls.length;
    const named = await errorOf(
      call('image.generate', { prompt: 'x', model: 'openai/gpt-image-2' }),
    );
    expect(named).toMatchObject({ statusCode: 409, code: 'model_out_of_scope' });
    expect(named?.message).toBe(
      '已开启「只用国内模型」，生成图片不能用 openai/gpt-image-2；可以用：bytedance-seed/seedream-4.5',
    );
    const none = await errorOf(call('media.inspect', { files: [seen], question: '?' }));
    expect(none).toMatchObject({ code: 'model_out_of_scope' });
    expect(none?.message).toBe('已开启「只用国内模型」，看图、看视频、听音频没有国内型号可用');
    expect(billingCalls).toHaveLength(holds);
  });
});

describe('工具目录里的单价', () => {
  it('有调用记录用记录的中位数；视频按供应商每秒单价；都没有才用兜底值并标出来', async () => {
    knobs.typical = {
      ...noHistory(),
      tools: new Map([
        ['bytedance-seed/seedream-4.5', { costMicro: 45_000, seconds: 110, samples: 8 }],
      ]),
    };
    const list = await build('k').list();
    const byKey = Object.fromEntries(list.map((t) => [t.key, t]));
    expect(byKey['image.generate']?.rates).toEqual([
      { model: 'bytedance-seed/seedream-4.5', costMicro: 45_000, seconds: 110, basis: 'history' },
      { model: 'openai/gpt-image-2', costMicro: 150_000, seconds: null, basis: 'fallback' },
    ]);
    expect(byKey['video.generate']).toMatchObject({
      unit: '秒',
      rates: [{ model: 'alibaba/wan-2.7', costMicro: 50_000, basis: 'catalog' }],
    });
  });
  it('fal 的音乐、3D 各型号按自己的标价列；没对接过的型号不列', async () => {
    const list = await build('k', true).list();
    const byKey = Object.fromEntries(list.map((t) => [t.key, t]));
    expect(byKey['audio.music']?.rates).toEqual([
      { model: 'fal-ai/minimax-music/v2.6', costMicro: 150_000, seconds: null, basis: 'catalog' },
      { model: 'fal-ai/lyria3/pro', costMicro: 80_000, seconds: null, basis: 'catalog' },
      { model: 'google/lyria/v3', costMicro: 100_000, seconds: null, basis: 'catalog' },
      { model: 'fal-ai/ace-step-1.5', costMicro: 72_000, seconds: null, basis: 'catalog' },
    ]);
    expect(byKey['3d.generate']).toMatchObject({
      defaultModel: 'fal-ai/trellis-2',
      rates: [
        { model: 'fal-ai/trellis-2', costMicro: 300_000 },
        { model: 'fal-ai/hunyuan-3d/v3.1/pro/image-to-3d', costMicro: 375_000 },
        { model: 'tripo3d/h3.1/image-to-3d', costMicro: 300_000 },
        { model: 'fal-ai/pixal3d', costMicro: 300_000 },
      ],
    });
  });
  it('开发阶段不看调用记录：有记录也只用供应商价格和目录兜底值', async () => {
    knobs.typical = {
      ...noHistory(),
      tools: new Map([
        ['bytedance-seed/seedream-4.5', { costMicro: 45_000, seconds: 110, samples: 8 }],
      ]),
    };
    const list = await build('k', false, false, false).list();
    const rates = list.find((t) => t.key === 'image.generate')?.rates ?? [];
    expect(rates.every((r) => r.basis !== 'history')).toBe(true);
  });
});
