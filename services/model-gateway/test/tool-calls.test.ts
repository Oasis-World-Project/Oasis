// 工具服务：一次就交回结果的工具调用（生图、看图、配音、转写、联网、决策）。工具目录和单价见 tool-catalog.test.ts。
import { describe, expect, it } from 'vitest';
import {
  knobs,
  PAYER,
  CONVERSATION,
  RUN,
  PNG,
  billingCalls,
  upstream,
  finished,
  startedCalls,
  recordedCalls,
} from './support/tool-fakes.ts';
import { tools, useTools, call, errorOf, reference, seen } from './support/tool-fixture.ts';

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
  it('花钱的工具设了「问我」：先给确认卡，不冻结、不调供应商；允许后带确认号才调；不花钱的不问', async () => {
    const card = '5c5c5c5c-5c5c-4c5c-8c5c-5c5c5c5c5c5c';
    const asked: { text: string; id?: string }[] = [];
    knobs.paidTool = async (_caller, text, id) => {
      asked.push({ text, ...(id ? { id } : {}) });
      return id ? undefined : { id: card };
    };
    await expect(call('image.generate', { prompt: '猫' }, CONVERSATION)).resolves.toMatchObject({
      costMicro: 0,
      files: [],
      confirmation: { id: card },
    });
    expect(upstream).toEqual([]);
    expect(billingCalls).toEqual([]);
    expect(asked[0]?.text).toMatch(/（bytedance-seed\/seedream-4\.5），最多 \$\d+\.\d\d$/);
    const done = await tools.call({
      caller: { payerId: PAYER, conversationId: CONVERSATION, runId: RUN, askPaid: true },
      key: 'image.generate',
      args: { prompt: '猫' },
      requestId: 'r',
      signal: new AbortController().signal,
      confirmationId: card,
    });
    expect(done.files).toHaveLength(1);
    expect(asked.at(-1)).toMatchObject({ id: card });
    asked.length = 0;
    await call('web.search', { query: '天气' }, CONVERSATION);
    expect(asked).toEqual([]);
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
  it('看图按实际费用结算，记在对话和这一轮上；明确地区拒绝才自动换模型', async () => {
    knobs.visionStatus = 403;
    const result = await call(
      'media.inspect',
      { files: [seen], question: '是什么？' },
      CONVERSATION,
    );
    expect(result.text).toContain('杯子');
    expect(upstream.map((r) => r.body.model)).toEqual(['vision/first', 'vision/second']);
    expect(upstream[1]?.body).toMatchObject({
      max_tokens: 2048,
      messages: [{ role: 'user', content: [{ type: 'text' }, { type: 'image_url' }] }],
    });
    expect(billingCalls.map((r) => r.path)).toEqual(['hold', 'release', 'hold', 'settle']);
    // 调用记录写上是哪个工具：一轮用过哪些工具按它汇总
    expect(startedCalls[1]).toMatchObject({
      kind: 'tool',
      tool: 'media.inspect',
      conversationId: CONVERSATION,
      runId: RUN,
    });
    expect(finished.at(-1)).toMatchObject({ status: 'succeeded', chargedMicro: 2000 });
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

describe('调用工具', () => {
  it('生图分辨率被供应商拒绝时按默认档重试一次，只结算成功的那次', async () => {
    const result = await call(
      'image.generate',
      { prompt: '扶手椅', resolution: '1K' },
      CONVERSATION,
    );
    expect(result).toMatchObject({ tool: 'image.generate', costMicro: 40_000 });
    expect(upstream.map((u) => u.body.resolution)).toEqual(['1K', undefined]);
    expect(billingCalls.map((c) => c.path)).toEqual(['hold', 'settle']);
  });
  it('要几张就并行发几个单张请求，合计结算；部分失败时交出成功的那些', async () => {
    const result = await call('image.generate', { prompt: '三张候选', n: '3' }, CONVERSATION);
    expect(upstream.filter((u) => u.path === 'images').map((u) => u.body.n)).toEqual([1, 1, 1]);
    expect(result).toMatchObject({ costMicro: 120_000 });
    expect(result.files.map((f) => f.name)).toEqual(['image-1.png', 'image-2.png', 'image-3.png']);

    upstream.length = 0;
    knobs.imageRejections = 1;
    const partial = await call('image.generate', { prompt: '三张候选', n: '3' }, CONVERSATION);
    expect(partial.files).toHaveLength(2);
    expect(partial.costMicro).toBe(80_000);
    expect(partial.text).toContain('另有 1 张没生成出来');
  });
  it('几个不同的画面一次交：同时生成，按描述的顺序编号；没生成出来的空着号', async () => {
    const result = await call(
      'image.generate',
      { prompts: ['开业海报', '门店外景'] },
      CONVERSATION,
    );
    expect(upstream.map((u) => u.body.prompt).sort()).toEqual(['开业海报', '门店外景'].sort());
    expect(result.files.map((f) => f.name)).toEqual(['image-1.png', 'image-2.png']);
    expect(result.text).toContain('第 2 张是第 2 个描述');
    expect(billingCalls[0]?.body).toMatchObject({ amountMicro: 1_000_000 });

    knobs.imageRejections = 1;
    const partial = await call(
      'image.generate',
      { prompts: ['开业海报', '门店外景'] },
      CONVERSATION,
    );
    expect(partial.files).toHaveLength(1);
    expect(partial.text).toMatch(/第 \d 张是第 \d 个描述（没生成出来）/);

    expect(
      (await errorOf(call('image.generate', { prompt: 'a', prompts: ['b'] })))?.message,
    ).toContain('写一个');
    expect(
      (await errorOf(call('image.generate', { prompts: ['a', 'b', 'c'], n: '2' })))?.message,
    ).toContain('一次最多 4 张');
  });
  it('同时在做的生成到了 4 个就不接新的：说清楚在做什么，不冻结、不调供应商；做完一个就又能交', async () => {
    for (const id of ['v1', 'v2', 'v3', 'm1'])
      startedCalls.push({
        id,
        kind: 'tool',
        payerId: PAYER,
        model: 'm',
        tool: id.startsWith('v') ? 'video.generate' : 'audio.music',
        requestId: 'r',
        holdId: 'h',
      });
    const err = await errorOf(call('image.generate', { prompt: 'x' }));
    expect(err).toMatchObject({ statusCode: 429, code: 'too_many_running' });
    expect(err?.message).toContain('同时在做的生成已经有 4 个（生成视频 3 个、生成音乐 1 个）');
    expect(billingCalls).toHaveLength(0);
    expect(upstream).toHaveLength(0);
    await expect(call('web.search', { query: '开业' })).resolves.toMatchObject({
      tool: 'web.search',
    });

    recordedCalls.set('m1', { status: 'succeeded' });
    await expect(call('image.generate', { prompt: 'x' })).resolves.toMatchObject({
      tool: 'image.generate',
    });
  });

  it('供应商说是 PNG、实际是 JPEG：按文件头认成 JPEG', async () => {
    const result = await call('image.generate', { prompt: '说是 PNG 其实是 JPEG' }, CONVERSATION);
    expect(result.files[0]).toMatchObject({ name: 'image-1.jpg', mediaType: 'image/jpeg' });
  });

  it('生图：冻结 → 调 OpenRouter → 按实际花费结算；交回图片文件；调用记在对话和这一轮上', async () => {
    const result = await call(
      'image.generate',
      { prompt: '山里的小木屋', aspect_ratio: '16:9', n: '1' },
      CONVERSATION,
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
    expect(startedCalls[0]).toMatchObject({
      kind: 'tool',
      conversationId: CONVERSATION,
      runId: RUN,
    });
    expect(finished[0]).toMatchObject({ status: 'succeeded', chargedMicro: 40_000 });
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

  it('问另一个模型：问题和材料交给指定的型号，交回它的回答；目录里附上各型号的实测', async () => {
    knobs.judgeAnswer = '标题太长，建议压到 12 个字以内。';
    const result = await call('model.ask', {
      question: '这个标题有什么问题？',
      context: '# 山里的小木屋民宿官网首页开头第一版',
      model: 'openai/ask-2',
    });
    expect(result.text).toBe('标题太长，建议压到 12 个字以内。');
    expect(upstream[0]?.body).toMatchObject({ model: 'openai/ask-2', stream: false });
    expect((upstream[0]?.body.messages as { content: string }[])[0]!.content).toBe(
      '材料：\n# 山里的小木屋民宿官网首页开头第一版\n\n这个标题有什么问题？',
    );
    // 不指定型号用清单里的第一个；不在清单里的型号不给用
    await call('model.ask', { question: '再看一遍' });
    expect(upstream[1]?.body).toMatchObject({ model: 'alibaba/ask-1' });
    expect(await errorOf(call('model.ask', { question: 'x', model: 'other/m' }))).toMatchObject({
      code: 'invalid_tool_args',
    });

    knobs.measured = new Map([
      [
        'alibaba/ask-1',
        { calls: 120, tokensPerSecond: 163, microPerMTok: 232_000, failureRate: 0 },
      ],
    ]);
    const entry = (await tools.list()).find((t) => t.key === 'model.ask');
    expect(entry?.description).toContain(
      '最近的实测（含缓存折扣）：alibaba/ask-1 每秒约 163 个 token、每百万 token 约 $0.23。',
    );
  });

  it('没配 Key 的工具：503', async () => {
    useTools(undefined);
    expect((await errorOf(call('web.search', { query: 'x' })))?.code).toBe('tool_unavailable');
  });
});
