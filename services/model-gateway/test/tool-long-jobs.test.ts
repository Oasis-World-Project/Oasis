// 工具服务：长任务（视频、音乐），以及任务删除时回收工具结果。
import { describe, expect, it } from 'vitest';
import {
  knobs,
  PAYER,
  TASK,
  billingCalls,
  upstream,
  settled,
  jobRows,
  jobs,
  mediaFiles,
} from './support/tool-fakes.ts';
import { tools, falCalls, geometryImage, useTools, call, errorOf } from './support/tool-fixture.ts';

describe('任务删除回收工具结果', () => {
  async function completed(taskId = TASK) {
    useTools('key', true);
    const id = (
      await call('audio.music', { prompt: 'A warm instrumental track', instrumental: true }, taskId)
    ).job!.id;
    await tools.job({ payerId: PAYER, taskId }, id, AbortSignal.timeout(3000));
    return id;
  }
  it('只删除目标任务的对象，保留账单，重复事件幂等，拒绝读取和迟到提交', async () => {
    const id = await completed();
    const other = await completed('00000000-0000-4000-8000-000000000008');
    const cost = jobRows.get(id)!.cost;
    // 旧版在第二个文件写入后未保存清单便中断，也必须回收。
    delete jobRows.get(id)!.call.resultFileIds;
    mediaFiles.set(`tool-results/${id}/1`, Buffer.from('legacy partial'));
    await tools.purgeTask(TASK);
    await tools.purgeTask(TASK);
    expect([...mediaFiles.keys()].filter((key) => key.startsWith(`tool-results/${id}/`))).toEqual(
      [],
    );
    expect(mediaFiles.has(`tool-results/${other}/0`)).toBe(true);
    expect(jobRows.get(id)).toMatchObject({
      status: 'completed',
      phase: 'expired',
      result: null,
      cost,
    });
    await expect(
      tools.job({ payerId: PAYER, taskId: TASK }, id, AbortSignal.timeout(1000)),
    ).rejects.toMatchObject({ statusCode: 410 });
    const holds = billingCalls.length;
    await expect(
      call('audio.music', { prompt: 'another track', instrumental: true }, TASK),
    ).rejects.toMatchObject({ statusCode: 410 });
    expect(billingCalls).toHaveLength(holds);
  });
  it('删除失败保留清单，重启后可继续；不抢在途作业租约', async () => {
    const id = await completed();
    jobRows.get(id)!.leaseToken = 'other';
    jobRows.get(id)!.leaseUntil = new Date(Date.now() + 60000);
    await tools.purgeTask(TASK);
    expect(mediaFiles.has(`tool-results/${id}/0`)).toBe(true);
    jobRows.get(id)!.leaseUntil = null;
    knobs.resultDeleteFails = true;
    await tools.purgeTask(TASK);
    expect(jobRows.get(id)!.result).not.toBeNull();
    expect(jobRows.get(id)!.call.resultFileIds).toEqual(['0']);
    knobs.resultDeleteFails = false;
    useTools('key', true);
    await tools.purgeTask(TASK);
    expect(mediaFiles.has(`tool-results/${id}/0`)).toBe(false);
  });
  it('删除与供应商完成竞争时照常结算，停止归档结果', async () => {
    knobs.geometryMode = true;
    knobs.geometryCancelCompleted = true;
    useTools('key', true);
    const id = (await call('3d.generate', { image: geometryImage }, TASK)).job!.id;
    await tools.purgeTask(TASK);
    expect(jobRows.get(id)).toMatchObject({ status: 'completed', phase: 'expired', result: null });
    expect([...mediaFiles.keys()].some((key) => key.startsWith(`tool-results/${id}/`))).toBe(false);
    expect(billingCalls.filter((call) => call.path === 'settle')).toHaveLength(1);
  });
  it('失败作业的部分写入也回收；未知费用记录不冒充已结算', async () => {
    const id = await completed();
    const row = jobRows.get(id)!;
    row.status = 'pending';
    row.phase = 'uncertain';
    row.result = null;
    row.cost = null;
    await tools.purgeTask(TASK);
    expect(mediaFiles.has(`tool-results/${id}/0`)).toBe(false);
    expect(jobRows.get(id)!.status).toBe('pending');
    expect(jobRows.get(id)!.cost).toBeNull();
  });
});

describe('长任务（视频）', () => {
  const job = (id: string, payerId = PAYER) =>
    tools.job({ payerId, taskId: TASK }, id, new AbortController().signal);

  it('供应商不回费用时使用持久化的时长/模型报价，重建服务不会变成固定短镜头价格', async () => {
    knobs.videoUsageCost = undefined;
    const submitted = await call('video.generate', { prompt: 'x', duration: 20 }, TASK);
    const id = submitted.job!.id;
    expect(jobRows.get(id)?.call.videoEstimateMicro).toBe(1_000_000);
    // 之后目录变价也不改变原报价；新的工具服务只从同一持久作业取回结果。
    knobs.videoCentsPerSecond = '20';
    useTools('tvly-k');
    const done = await job(id);
    expect(done.result?.costMicro).toBe(1_000_000);
    expect(billingCalls.at(-1)?.body.costMicro).toBe(1_000_000);
    await job(id);
    expect(billingCalls.filter((x) => x.path === 'settle')).toHaveLength(1);
  });

  it('私有首帧以内联图像传给供应商；不支持时在冻结前拒绝，不能退化为文生视频', async () => {
    const base64 = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex').toString(
      'base64',
    );
    const args = {
      prompt: '保持原商品，镜头缓慢推进',
      first_frame: [{ mediaType: 'image/png', base64 }],
    };
    knobs.videoFramesSupported = false;
    expect((await errorOf(call('video.generate', args)))?.code).toBe(
      'video_parameters_unsupported',
    );
    expect(billingCalls).toHaveLength(0);
    expect(upstream).toHaveLength(0);
    knobs.videoFramesSupported = true;
    const result = await call('video.generate', args, TASK);
    expect(result.job).toBeDefined();
    expect(upstream[0]?.body.frame_images).toEqual([
      {
        type: 'image_url',
        frame_type: 'first_frame',
        image_url: { url: `data:image/png;base64,${base64}` },
      },
    ]);
  });

  it('视频提交被 API Key 的花费上限拒绝：说明是平台额度不够，不是笼统的「拒绝了提交」', async () => {
    knobs.videoReject = {
      status: 403,
      body: { error: { message: 'Key limit exceeded (total limit).', code: 403 } },
    };
    expect(await errorOf(call('video.generate', { prompt: 'x' }))).toMatchObject({
      statusCode: 402,
      code: 'provider_credits',
    });
    knobs.videoReject = { status: 400, body: { error: { message: 'bad prompt' } } };
    expect((await errorOf(call('video.generate', { prompt: 'x' })))?.code).toBe('provider_error');
  });

  it('参数和价格预检失败不冻结；高价模型冻结覆盖实时目录而非固定单价', async () => {
    expect((await errorOf(call('video.generate', { prompt: 'x', duration: 21 })))?.statusCode).toBe(
      400,
    );
    expect((await errorOf(call('video.generate', { prompt: 'x', resolution: '768p' })))?.code).toBe(
      'video_parameters_unsupported',
    );
    expect(billingCalls).toHaveLength(0);
    knobs.videoCentsPerSecond = '100';
    knobs.videoUsdTariff = false;
    await call('video.generate', { prompt: 'x', duration: 6 });
    expect(billingCalls[0]?.body.amountMicro).toBe(6_000_000);
  });

  it('提交时冻结（留够时间）并交回任务号；做好前是 pending；做好后按实际花费结算一次', async () => {
    knobs.videoPolls = 1;
    const submitted = await call('video.generate', { prompt: '木屋的清晨', duration: '6' }, TASK);
    const id = submitted.job?.id ?? '';
    expect(submitted).toMatchObject({ tool: 'video.generate', costMicro: 0, files: [] });
    expect(upstream[0]).toEqual({
      path: 'video',
      body: { model: 'alibaba/wan-2.7', prompt: '木屋的清晨', duration: 6, resolution: '720p' },
    });
    expect(billingCalls[0]?.body).toMatchObject({ amountMicro: 4_200_000, ttlMs: 40 * 60_000 });

    expect(await job(id)).toEqual({ status: 'pending' });
    const done = await job(id);
    expect(done).toMatchObject({
      status: 'completed',
      result: { costMicro: 500_000, files: [{ name: 'video.mp4', mediaType: 'video/mp4' }] },
    });
    const file = await tools.file({ payerId: PAYER, taskId: TASK }, id, done.result!.files[0]!.id!);
    const chunks: Buffer[] = [];
    for await (const chunk of file.content) chunks.push(Buffer.from(chunk as Uint8Array));
    expect(Buffer.concat(chunks).toString()).toBe('mp4');
    knobs.videoPolls = 99;
    knobs.videoEnd = 'failed';
    expect(settled[0]).toMatchObject({
      data: { kind: 'tool', taskId: TASK, chargedMicro: 500_000 },
    });

    // 再取一次：照样交回结果，但不再结算
    expect((await job(id)).status).toBe('completed');
    expect(billingCalls.map((c) => c.path)).toEqual(['hold', 'settle']);
  });

  it('供应商说失败：退回冻结；之后再问也是失败', async () => {
    knobs.videoEnd = 'failed';
    const id = (await call('video.generate', { prompt: 'x' })).job?.id ?? '';
    const result = await job(id);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('内容不合规');
    expect((await job(id)).status).toBe('failed');
    expect(billingCalls.map((c) => c.path)).toEqual(['hold', 'release']);
  });

  it('等太久：保留未确认状态，不自动退回或重发', async () => {
    knobs.videoPolls = 99;
    const id = (await call('video.generate', { prompt: 'x' })).job?.id ?? '';
    const row = jobRows.get(id)!;
    jobRows.set(id, { ...row, createdAt: new Date(Date.now() - 31 * 60_000) });
    expect(await job(id)).toMatchObject({
      status: 'uncertain',
      error: expect.stringContaining('费用待核对'),
    });
    expect(billingCalls.map((c) => c.path)).toEqual(['hold']);
  });

  it('别人的任务号：查不到', async () => {
    const id = (await call('video.generate', { prompt: 'x' })).job?.id ?? '';
    expect((await errorOf(job(id, TASK)))?.statusCode).toBe(404);
  });
});

describe('音乐长任务', () => {
  it('提交尚在途时查询保持 pending，只有遗留提交才转为未确认且不重发', async () => {
    useTools('key', true);
    const id = '00000000-0000-4000-8000-000000000097';
    await jobs.insert({
      id,
      tool: 'audio.music',
      providerJobId: '',
      requestKey: null,
      requestHash: 'test',
      call: { caller: { payerId: PAYER, taskId: TASK } },
    });
    expect(
      await tools.job({ payerId: PAYER, taskId: TASK }, id, AbortSignal.timeout(1000)),
    ).toEqual({ status: 'pending' });
    jobRows.get(id)!.createdAt = new Date(Date.now() - 121_000);
    expect(
      await tools.job({ payerId: PAYER, taskId: TASK }, id, AbortSignal.timeout(1000)),
    ).toMatchObject({ status: 'uncertain' });
    expect(falCalls).toEqual([]);
    expect(billingCalls).toEqual([]);
  });
  it('相同幂等键的并发提交只生成一次，重复冻结退回，改参数不能复用键', async () => {
    useTools('key', true);
    const input = {
      caller: { payerId: PAYER, taskId: TASK },
      key: 'audio.music',
      args: { prompt: 'A complete instrumental with a warm ending', instrumental: true },
      requestId: 'test',
      idempotencyKey: '00000000-0000-4000-8000-000000000098',
      signal: AbortSignal.timeout(5000),
    };
    const [first, second] = await Promise.all([tools.call(input), tools.call(input)]);
    expect(first.job?.id).toBe(second.job?.id);
    expect(falCalls.filter((call) => call.input)).toHaveLength(1);
    await tools.job(input.caller, first.job!.id, AbortSignal.timeout(1000));
    expect(billingCalls.filter((call) => call.path === 'settle')).toHaveLength(1);
    await expect(
      tools.call({
        ...input,
        args: { ...input.args, prompt: 'Different complete instrumental song' },
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
  it('器乐与歌词参数明确；结果保存后进程重建不再调供应商，其他任务不能访问', async () => {
    useTools('key', true);
    const id = (
      await call(
        'audio.music',
        { prompt: 'Warm piano and strings with a complete ending', instrumental: 'true' },
        TASK,
      )
    ).job!.id;
    expect(falCalls[0]?.input).toMatchObject({ is_instrumental: true, lyrics: '' });
    expect(falCalls[0]?.input).toMatchObject({
      audio_setting: { sample_rate: 44100, bitrate: 256000, format: 'mp3' },
    });
    const done = await tools.job({ payerId: PAYER, taskId: TASK }, id, AbortSignal.timeout(1000));
    expect(done.status).toBe('completed');
    expect(done.result?.files[0]).toMatchObject({ id: '0', size: 8 });
    const count = falCalls.length;
    await tools.close();
    useTools('key', true);
    expect(
      (await tools.job({ payerId: PAYER, taskId: TASK }, id, AbortSignal.timeout(1000))).status,
    ).toBe('completed');
    expect(falCalls).toHaveLength(count);
    expect(billingCalls.map((call) => call.path)).toEqual(['hold', 'settle']);
    await expect(tools.file({ payerId: PAYER, taskId: PAYER }, id, '0')).rejects.toMatchObject({
      statusCode: 404,
    });
    const missing = await errorOf(
      call('audio.music', {
        prompt: 'A complete vocal song with accompaniment',
        instrumental: 'false',
      }),
    );
    expect(missing?.code).toBe('invalid_tool_args');
    const song = await call('audio.music', {
      prompt: 'A complete vocal song with accompaniment',
      instrumental: 'false',
      lyrics: '[Verse] 测试歌词',
    });
    expect(song.job).toBeTruthy();
    expect(falCalls.at(-1)?.input).toMatchObject({
      is_instrumental: false,
      lyrics: '[Verse] 测试歌词',
    });
  });
  it('各型号的入参、格式、价钱照各自的写法：Lyria 把歌词写进 prompt；ACE-Step 只做纯器乐，出 FLAC、按 120 秒算钱', async () => {
    useTools('key', true);
    const settledMicro = () =>
      billingCalls.filter((c) => c.path === 'settle').map((c) => c.body.costMicro);
    const lyria = (
      await call('audio.music', {
        prompt: 'A complete vocal song with accompaniment',
        instrumental: false,
        lyrics: '[Verse] 测试歌词',
        model: 'fal-ai/lyria3/pro',
      })
    ).job!.id;
    expect(falCalls.at(-1)).toEqual({
      url: 'https://queue.fal.run/fal-ai/lyria3/pro',
      input: { prompt: 'A complete vocal song with accompaniment\n\nLyrics:\n[Verse] 测试歌词' },
    });
    await tools.job({ payerId: PAYER }, lyria, AbortSignal.timeout(1000));
    expect(settledMicro()).toEqual([80_000]);

    // 真实返回（2026-11-11）：类型写 audio/flac，地址以 .bin 结尾
    knobs.falResult = {
      audio: { url: 'https://v3.fal.media/files/b/song.bin', content_type: 'audio/flac' },
    };
    const ace = (
      await call('audio.music', {
        prompt: `Warm piano ${'x'.repeat(600)}`,
        instrumental: true,
        model: 'fal-ai/ace-step-1.5',
      })
    ).job!.id;
    const input = falCalls.at(-1)?.input as { prompt: string; lyrics: string; duration: number };
    expect(input).toMatchObject({ lyrics: '[Instrumental]', duration: 120 });
    expect(input.prompt).toHaveLength(512);
    // 带歌词的歌点名它：提交之前就拒绝
    const song = { prompt: 'A complete vocal song', instrumental: false, lyrics: '[Verse] 歌词' };
    const refused = await errorOf(call('audio.music', { ...song, model: 'fal-ai/ace-step-1.5' }));
    expect(refused).toMatchObject({ code: 'invalid_tool_args' });
    expect(refused?.message).toContain('只做纯器乐');
    expect(falCalls.at(-1)?.input).toBe(input);
    const done = await tools.job({ payerId: PAYER }, ace, AbortSignal.timeout(1000));
    expect(done.result?.files[0]).toMatchObject({ name: 'music.flac', mediaType: 'audio/flac' });
    expect(settledMicro()).toEqual([80_000, 72_000]);
    // 没对接过的型号：目录不列，点名也不提交
    const holds = billingCalls.length;
    await expect(
      call('audio.music', {
        prompt: 'x'.repeat(12),
        instrumental: true,
        model: 'someone/unknown-music',
      }),
    ).rejects.toMatchObject({ message: '生成音乐不能用模型 someone/unknown-music' });
    expect(billingCalls).toHaveLength(holds);
  });
  it('供应商没生成（如内容审核拦下）：不收费，把供应商说的原因交回去', async () => {
    useTools('key', true);
    knobs.falResultStatus = 422;
    knobs.falResult = {
      detail: [{ type: 'content_policy_violation', msg: 'flagged by a content checker' }],
    };
    const id = (
      await call('audio.music', { prompt: 'A warm instrumental track', instrumental: true })
    ).job!.id;
    expect(await tools.job({ payerId: PAYER }, id, AbortSignal.timeout(1000))).toMatchObject({
      status: 'failed',
      error: '音乐供应商没有生成：flagged by a content checker',
    });
    expect(billingCalls.some((c) => c.path === 'settle')).toBe(false);
  });
  it('提交断连不重新提交；结算失败从已存文件继续而不重新生成或下载', async () => {
    useTools('key', true);
    knobs.falSubmitFails = true;
    const unknown = (
      await call('audio.music', {
        prompt: 'A warm instrumental track with a soft ending',
        instrumental: true,
      })
    ).job!.id;
    expect((await tools.job({ payerId: PAYER }, unknown, AbortSignal.timeout(1000))).status).toBe(
      'uncertain',
    );
    expect(falCalls).toHaveLength(1);
    expect(billingCalls.map((call) => call.path)).toEqual(['hold']);
    knobs.falSubmitFails = false;
    knobs.settleFails = true;
    const id = (
      await call('audio.music', {
        prompt: 'A warm instrumental track with a soft ending',
        instrumental: true,
      })
    ).job!.id;
    expect((await tools.job({ payerId: PAYER }, id, AbortSignal.timeout(1000))).status).toBe(
      'pending',
    );
    expect(jobRows.get(id)?.phase).toBe('stored');
    const count = falCalls.length;
    knobs.settleFails = false;
    useTools('key', true);
    expect((await tools.job({ payerId: PAYER }, id, AbortSignal.timeout(1000))).status).toBe(
      'completed',
    );
    expect(falCalls).toHaveLength(count);
  });
});
