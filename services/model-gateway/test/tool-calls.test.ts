// 工具服务：工具目录和单价，以及一次就交回结果的工具调用（生图、看图、配音、转写、联网、决策）。
import { describe, expect, it } from 'vitest';
import {
  knobs,
  PAYER,
  TASK,
  PNG,
  billingCalls,
  upstream,
  settled,
  noHistory,
} from './support/tool-fakes.ts';
import { tools, build, useTools, call, errorOf, reference, seen } from './support/tool-fixture.ts';

describe('文件场景工具', () => {
  it('参考图仅发送给能力目录确认支持的模型，保留 data URL', async () => {
    await call('image.generate', { prompt: '换背景', references: [reference] });
    expect(upstream[0]?.body).toMatchObject({
      model: 'openai/gpt-image-2',
      input_references: [
        { type: 'image_url', image_url: { url: `data:image/png;base64,${reference.base64}` } },
      ],
      provider: { require_parameters: true },
    });
  });
  it('不支持参考图、数量太多和签名不符均在冻结前拒绝', async () => {
    knobs.referenceLimit = 0;
    await expect(
      call('image.generate', { prompt: 'x', references: [reference] }),
    ).rejects.toMatchObject({ code: 'reference_images_unsupported' });
    for (const images of [Array(5).fill(seen), [{ ...seen, base64: PNG }]]) {
      await expect(call('media.inspect', { question: 'x', files: images })).rejects.toMatchObject({
        code: 'invalid_tool_args',
      });
    }
    expect(billingCalls).toEqual([]);
    expect(upstream).toEqual([]);
  });
  it('大图片校验不递归溢出，总字节数超限在冻结前拒绝', async () => {
    const bytes = Buffer.alloc(6 * 1024 * 1024);
    Buffer.from(reference.base64, 'base64').copy(bytes);
    const large = { ...reference, base64: bytes.toString('base64') };
    // 不支持参考图会在校验之后拒绝，避免把大请求发往假 HTTP 服务。
    knobs.referenceLimit = 0;
    await expect(
      call('image.generate', { prompt: 'x', references: [large] }),
    ).rejects.toMatchObject({ code: 'reference_images_unsupported' });
    await expect(
      call('media.inspect', { question: 'x', files: Array(4).fill({ kind: 'image', ...large }) }),
    ).rejects.toMatchObject({ code: 'invalid_tool_args' });
    expect(billingCalls).toEqual([]);
  });
  it('看图按实际费用结算并归属任务；明确地区拒绝才自动换模型', async () => {
    knobs.visionStatus = 403;
    const result = await call('media.inspect', { files: [seen], question: '是什么？' }, TASK);
    expect(result.text).toContain('杯子');
    expect(upstream.map((r) => r.body.model)).toEqual(['vision/first', 'vision/second']);
    expect(upstream[1]?.body).toMatchObject({
      max_tokens: 2048,
      messages: [{ role: 'user', content: [{ type: 'text' }, { type: 'image_url' }] }],
    });
    expect(billingCalls.map((r) => r.path)).toEqual(['hold', 'release', 'hold', 'settle']);
    expect(settled[0]).toMatchObject({ data: { taskId: TASK, kind: 'tool', chargedMicro: 2000 } });
  });
  it('听音频、看视频：只用目录里读得了这种文件的型号，内容按供应商的写法带上', async () => {
    const heard = {
      kind: 'audio',
      format: 'mp3',
      base64: Buffer.from('ID3 music').toString('base64'),
    };
    const watched = {
      kind: 'video',
      mediaType: 'video/mp4',
      base64: Buffer.from('mp4 video').toString('base64'),
    };
    const result = await call('media.inspect', {
      files: [heard, watched, seen],
      question: '哪一段更好？',
    });
    expect(result.text).toContain('杯子');
    // 前两个型号只看图，直接跳过，不去试
    expect(upstream.map((r) => r.body.model)).toEqual(['listen/first']);
    expect(upstream[0]?.body).toMatchObject({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '哪一段更好？' },
            { type: 'input_audio', input_audio: { data: heard.base64, format: 'mp3' } },
            { type: 'video_url', video_url: { url: `data:video/mp4;base64,${watched.base64}` } },
            { type: 'image_url' },
          ],
        },
      ],
    });
    upstream.length = 0;
    const holds = billingCalls.length;
    // 点名一个读不了音频的型号：说清楚它读不了、谁读得了，不调用也不冻结
    const named = await errorOf(
      call('media.inspect', { files: [heard], question: '?', model: 'vision/first' }),
    );
    expect(named).toMatchObject({ statusCode: 400, code: 'media_unsupported' });
    expect(named?.message).toBe('vision/first 读不了audio；可以用：listen/first');
    expect(upstream).toEqual([]);
    expect(billingCalls).toHaveLength(holds);
    // 目录还没拉到：不筛，照配置的先后试
    knobs.directory = false;
    await call('media.inspect', { files: [heard], question: '?' });
    expect(upstream.map((r) => r.body.model)).toEqual(['vision/first']);
  });
  it('看图的模型被上游限流：退回冻结，换下一个模型；指定了模型就不换', async () => {
    knobs.visionStatus = 429;
    const result = await call('media.inspect', { files: [seen], question: '是什么？' });
    expect(result.text).toContain('杯子');
    expect(upstream.map((r) => r.body.model)).toEqual(['vision/first', 'vision/second']);
    expect(billingCalls.map((r) => r.path)).toEqual(['hold', 'release', 'hold', 'settle']);
    upstream.length = 0;
    await expect(
      call('media.inspect', { files: [seen], question: '是什么？', model: 'vision/first' }),
    ).rejects.toMatchObject({ code: 'provider_busy' });
    expect(upstream.map((r) => r.body.model)).toEqual(['vision/first']);
  });
  it('网页全文不截断，保留来源与失败信息；超限明确失败', async () => {
    knobs.pageText = '研究资料'.repeat(10_000);
    const result = await call('web.fetch', { urls: ['https://a.com'], format: 'files' });
    expect(Buffer.from(result.files[0]!.base64, 'base64').toString()).toContain(knobs.pageText);
    expect(result.text.length).toBeLessThan(300);
    expect(result.files[0]!.name).toMatch(/^1-[a-f0-9]{12}\.md$/);
    expect(result.data).toMatchObject({ failed: [{ url: 'https://b.com' }] });
    knobs.pageText = '汉'.repeat(100_000);
    await expect(
      call('web.fetch', { urls: ['https://a.com'], format: 'files' }),
    ).rejects.toMatchObject({ code: 'web_content_too_large' });
  });
  it('单行预算在冻结和供应商调用前检查', async () => {
    await expect(
      tools.call({
        caller: { payerId: PAYER },
        key: 'jev.decide',
        args: { question: '好不好' },
        maxCostMicro: 1,
        requestId: 'r',
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'call_budget_exceeded' });
    expect(billingCalls).toEqual([]);
    expect(upstream).toEqual([]);
  });
});

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
      'text.batch',
      // 沙箱里的本地操作（ADR 0025）：不调供应商，一直可用
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

  it('用户打开「只用国内模型」：替他列的目录只留国内厂商的型号，没有国内型号的工具不可用；不按模型厂商分的工具不受影响', async () => {
    const all = Object.fromEntries(
      (await build('k', true, true).list(PAYER)).map((t) => [t.key, t]),
    );
    knobs.domesticOnly = true;
    const list = await build('k', true, true).list(PAYER);
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

describe('调用工具', () => {
  it('生图分辨率被供应商拒绝时按默认档重试一次，只结算成功的那次', async () => {
    const result = await call('image.generate', { prompt: '扶手椅', resolution: '1K' }, TASK);
    expect(result).toMatchObject({ tool: 'image.generate', costMicro: 40_000 });
    expect(upstream.map((u) => u.body.resolution)).toEqual(['1K', undefined]);
    expect(billingCalls.map((c) => c.path)).toEqual(['hold', 'settle']);
  });
  it('要几张就并行发几个单张请求，合计结算；部分失败时交出成功的那些', async () => {
    const result = await call('image.generate', { prompt: '三张候选', n: '3' }, TASK);
    expect(upstream.filter((u) => u.path === 'images').map((u) => u.body.n)).toEqual([1, 1, 1]);
    expect(result).toMatchObject({ costMicro: 120_000 });
    expect(result.files.map((f) => f.name)).toEqual(['image-1.png', 'image-2.png', 'image-3.png']);

    upstream.length = 0;
    knobs.imageRejections = 1;
    const partial = await call('image.generate', { prompt: '三张候选', n: '3' }, TASK);
    expect(partial.files).toHaveLength(2);
    expect(partial.costMicro).toBe(80_000);
    expect(partial.text).toContain('另有 1 张没生成出来');
  });

  it('供应商说是 PNG、实际是 JPEG：按文件头认成 JPEG', async () => {
    const result = await call('image.generate', { prompt: '说是 PNG 其实是 JPEG' }, TASK);
    expect(result.files[0]).toMatchObject({ name: 'image-1.jpg', mediaType: 'image/jpeg' });
  });

  it('生图：冻结 → 调 OpenRouter → 按实际花费结算；交回图片文件；属于任务的发结算事件', async () => {
    const result = await call(
      'image.generate',
      { prompt: '山里的小木屋', aspect_ratio: '16:9', n: '1' },
      TASK,
    );
    expect(result).toMatchObject({
      tool: 'image.generate',
      costMicro: 40_000,
      files: [{ name: 'image-1.png', mediaType: 'image/png', base64: PNG }],
    });
    expect(upstream[0]).toEqual({
      path: 'images',
      body: {
        model: 'bytedance-seed/seedream-4.5',
        prompt: '山里的小木屋',
        n: 1,
        output_format: 'png',
        aspect_ratio: '16:9',
      },
    });
    expect(billingCalls.map((c) => c.path)).toEqual(['hold', 'settle']);
    expect(billingCalls[0]?.body).toMatchObject({ amountMicro: 500_000 });
    expect(settled[0]).toMatchObject({
      data: { kind: 'tool', taskId: TASK, chargedMicro: 40_000 },
    });
  });

  it('参数不对、模型不在可选里、工具不存在：调供应商之前就拒绝，不冻结', async () => {
    expect((await errorOf(call('image.generate', {})))?.statusCode).toBe(400);
    expect(
      (await errorOf(call('image.generate', { prompt: 'x', model: 'x/y' })))?.message,
    ).toContain('不能用模型 x/y');
    expect((await errorOf(call('nope', {})))?.statusCode).toBe(404);
    expect(billingCalls).toHaveLength(0);
  });

  it('供应商说地区用不了：退回冻结，给出能看懂的原因', async () => {
    knobs.imageStatus = 403;
    const err = await errorOf(call('image.generate', { prompt: 'x' }));
    expect(err?.code).toBe('provider_region_unavailable');
    expect(billingCalls.map((c) => c.path)).toEqual(['hold', 'release', 'hold', 'release']);
  });

  it('配音：交回 MP3；花费按生成 ID 去查', async () => {
    const result = await call('audio.speech', { text: '欢迎来到小木屋' });
    expect(result).toMatchObject({
      costMicro: 2_100,
      files: [{ name: 'speech.mp3', mediaType: 'audio/mpeg' }],
    });
    expect(Buffer.from(result.files[0]!.base64, 'base64').toString()).toBe('mp3');
    // 没写音色：用供应商目录里这个型号的第一个（多数配音型号不点名音色就拒绝）
    expect(upstream[0]?.body).toMatchObject({
      model: 'bytedance-seed/seed-audio-1-0',
      response_format: 'mp3',
      voice: 'voice-a',
    });
    await call('audio.speech', { text: '欢迎来到小木屋', voice: 'voice-b' });
    expect(upstream[1]?.body).toMatchObject({ voice: 'voice-b' });
  });

  it('转写：把录音交给转写模型，交回文字', async () => {
    const result = await call('audio.transcribe', {
      audio_base64: 'AAA',
      format: 'mp3',
      language: 'zh',
    });
    expect(result.text).toBe('你好，欢迎来到小木屋。');
    expect(upstream[0]?.body).toEqual({
      model: 'openai/whisper-large-v3',
      input_audio: { data: 'AAA', format: 'mp3' },
      language: 'zh',
    });
  });

  it('联网搜索和读取网页：按 Tavily 的积分算钱；读不到的网页写明原因', async () => {
    const search = await call('web.search', { query: '小木屋民宿 设计' });
    expect(search.text).toBe('1. 小木屋民宿\n   https://a.com\n   山里的 木屋');
    expect(search.costMicro).toBe(8_000);
    expect(upstream[0]?.body).toMatchObject({
      query: '小木屋民宿 设计',
      max_results: 5,
      search_depth: 'basic',
    });
    const page = await call('web.fetch', { urls: ['https://a.com', 'https://b.com'] });
    expect(page.text).toContain('## https://a.com\n\n# 正文');
    expect(page.text).toContain('（没读到：超时）');
    expect(page.costMicro).toBe(8_000);
  });

  it('Jev 判断：给选项就是选一个，交回各选项的概率', async () => {
    const result = await call('jev.decide', {
      question: '哪个标题更好',
      options: ['标题A', '标题B'],
    });
    expect(result.data).toMatchObject({ choice: '标题B' });
    expect(upstream[0]?.body).toEqual({
      model: 'typesafe/jev-1.14',
      state: ['哪个标题更好'],
      questions: {
        q: {
          type: 'choice',
          instructions: '哪个标题更好',
          criteria: { 标题A: '标题A', 标题B: '标题B' },
        },
      },
    });
  });

  it('快速判断在「只用国内模型」下：由清单里的聊天模型按同样的格式回答；答非所问不当成判断', async () => {
    knobs.domesticOnly = true;
    const result = await call('jev.decide', {
      question: '哪个标题更好',
      options: ['标题A', '标题B'],
      context: '面向小学生的科普读物',
    });
    expect(result.data).toEqual({ type: 'choice', choice: '标题B' });
    expect(upstream[0]?.body).toMatchObject({ model: 'alibaba/judge-1' });
    const asked = (upstream[0]?.body.messages as { content: string }[])[0]!.content;
    expect(asked).toContain('材料：\n面向小学生的科普读物');
    expect(asked).toContain('选项：["标题A","标题B"]');
    // 选了不在选项里的、或者干脆没给 JSON：报错，不编一个结果
    for (const answer of ['{"type":"choice","choice":"标题C"}', '我觉得都不错']) {
      knobs.judgeAnswer = answer;
      expect(
        await errorOf(
          call('jev.decide', { question: '哪个标题更好', options: ['标题A', '标题B'] }),
        ),
      ).toMatchObject({ code: 'decision_unusable' });
    }
    // 是不是、打分
    knobs.judgeAnswer = '{"type":"noul","noul":0.8}';
    expect((await call('jev.decide', { question: '达标了吗' })).data).toEqual({
      type: 'noul',
      noul: 0.8,
    });
    knobs.judgeAnswer = '{"type":"score","score":"好"}';
    expect(
      (await call('jev.decide', { question: '写得怎么样', scale: ['差', '一般', '好'] })).data,
    ).toEqual({ type: 'score', score: '好' });
  });

  it('没配 Key 的工具：503', async () => {
    useTools(undefined);
    expect((await errorOf(call('web.search', { query: 'x' })))?.code).toBe('tool_unavailable');
  });
});
