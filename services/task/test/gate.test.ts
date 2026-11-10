import { HttpError, type ServiceClient } from '@oasis/service-kit';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import { createCheckCompute } from '../src/service/check-compute.ts';
import { checkRules, checkWebManifest, createGate } from '../src/service/gate.ts';

describe('交给用户的网页要配 oasis-app.json', () => {
  const page = (path: string) => ({ path, size: 10 });
  it('交付目录里有网页却没有清单：按最外层目录报一次，告诉节点怎么补', () => {
    const unmet = checkWebManifest(
      [page('site/index.html'), page('site/pages/about.html'), page('site/app.js')],
      ['site/**'],
    );
    expect(unmet).toHaveLength(1);
    expect(unmet[0]).toContain('out/site/ 里没有 oasis-app.json');
    expect(unmet[0]).toContain('in/.oasis-formats.json');
  });
  it('配了清单、不交给用户的网页、直接放在 out/ 下的网页都不报', () => {
    expect(
      checkWebManifest([page('site/index.html'), page('site/oasis-app.json')], ['site/**']),
    ).toEqual([]);
    expect(checkWebManifest([page('draft/index.html')], ['报告.md'])).toEqual([]);
    expect(checkWebManifest([page('index.html')], ['*.html'])).toEqual([]);
    expect(checkWebManifest([page('site/index.html')], [])).toEqual([]);
  });
});

describe('关卡的规则检查', () => {
  it('expects 与 deliver 重复的缺文件提醒只列一次，仍逐条执行不同约束', () => {
    expect(
      checkRules([{ path: 'texture.png', size: 1 }], ['scene.glb', { pattern: 'scene.glb' }]),
    ).toEqual(['缺少文件 out/scene.glb']);
  });
  it('未支持的工程 ZIP 和遗漏报告不触发无意义重做，确定损坏或数量不可能满足时仍退回', () => {
    const outputs = [{ path: 'project.zip', size: 100 }];
    const unparsed = [
      { path: 'project.zip', text: '', valid: false, warning: '此格式未解析，需人工核对' },
    ];
    expect(checkRules(outputs, [{ pattern: '*.zip' }], unparsed)).toEqual([]);
    expect(checkRules(outputs, [{ pattern: '*.zip' }], [])).toEqual([]);
    expect(checkRules(outputs, [{ pattern: '*.zip', exactCount: 2 }], unparsed)[0]).toContain(
      '有效文件 0 个',
    );
    expect(
      checkRules(
        outputs,
        [{ pattern: '*.zip' }],
        [{ path: 'project.zip', text: '', valid: false, error: 'ZIP 损坏' }],
      )[0],
    ).toContain('有效文件 0 个');
    expect(checkRules([{ path: 'empty.zip', size: 0 }], [{ pattern: '*.zip' }], [])[0]).toContain(
      '有效文件 0 个',
    );
  });
  it('精确和至少数量只计有效非空文件，并核对图片尺寸', () => {
    const outputs = [
      { path: '图/a.png', size: 1 },
      { path: '图/b.png', size: 1 },
      { path: '图/c.png', size: 0 },
    ];
    const inspected = [
      { path: '图/a.png', text: '', valid: true, width: 100, height: 200 },
      { path: '图/b.png', text: '', valid: false, error: '不能解码' },
    ];
    expect(
      checkRules(
        outputs,
        [{ pattern: '图/*.png', minCount: 1, width: 100, height: 200 }],
        inspected,
      ),
    ).toEqual([]);
    expect(checkRules(outputs, [{ pattern: '图/*.png', exactCount: 2 }], inspected)[0]).toContain(
      '有效文件 1 个',
    );
    expect(
      checkRules(outputs, [{ pattern: '图/*.png', exactCount: 1, width: 200 }], inspected)[0],
    ).toContain('尺寸 100×200');
  });
  it('没有产出、缺文件、文件是空的都算没过；通配只匹配一段路径', () => {
    expect(checkRules([], [])).toEqual(['out/ 里没有任何产出文件']);
    const outputs = [
      { path: '报告.md', size: 120 },
      { path: 'img/封面.png', size: 0 },
    ];
    expect(checkRules(outputs, ['*.md'])).toEqual([]);
    expect(checkRules(outputs, ['img/*.png'])).toEqual(['文件 out/img/*.png 是空的']);
    expect(checkRules(outputs, ['*.png', '数据.csv'])).toEqual([
      '缺少文件 out/*.png',
      '缺少文件 out/数据.csv',
    ]);
  });
  it('不带通配符的要求写的是目录时，目录里有文件就算有（不当成一个叫这个名字的文件去找）', () => {
    const outputs = [
      { path: 'site/index.html', size: 10 },
      { path: 'site/js/app.js', size: 10 },
      { path: 'sitemap.txt', size: 10 },
    ];
    // 2026-11-10：工具节点检查 in/build/site，上游被要求交出「site」，以前报「缺少文件 out/site」
    expect(checkRules(outputs, ['site', 'site/', 'site/js'])).toEqual([]);
    // 只认整段目录名：sitemap.txt 不算 site 目录里的文件
    expect(checkRules([{ path: 'sitemap.txt', size: 10 }], ['site'])).toEqual([
      '缺少文件 out/site',
    ]);
    expect(checkRules([{ path: 'site/index.html', size: 0 }], ['site'])).toEqual([
      '文件 out/site 是空的',
    ]);
    // 交付写目录名：目录里的文件都交付，缺清单的提醒照常
    expect(checkWebManifest([{ path: 'site/index.html', size: 10 }], ['site'])[0]).toContain(
      'out/site/ 里没有 oasis-app.json',
    );
  });
});

/** 假的服务：按路径返回固定内容，记下请求；和真的客户端一样按约定的格式校验回答 */
function fakeService(answer: (path: string) => unknown) {
  const calls: { path: string; body: unknown }[] = [];
  const client = {
    async json(_method: string, path: string, options?: { body?: unknown; schema?: ZodType }) {
      calls.push({ path, body: options?.body });
      const result = answer(path);
      if (result instanceof Error) throw result;
      if (!options?.schema || result === undefined) return result;
      const checked = options.schema.safeParse(result);
      if (!checked.success) throw new HttpError(502, 'upstream_error', '返回的数据格式不对');
      return checked.data;
    },
    stream: () => Promise.reject(new Error('不用')),
  } as unknown as ServiceClient;
  return { client, calls };
}

const PAYER = '7d0c2f1e-1b2a-4c3d-8e4f-5a6b7c8d9e0f';
const TASK = '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b';
const input = {
  payerId: PAYER,
  taskId: TASK,
  nodeId: '3c3c3c3c-3c3c-4c3c-8c3c-3c3c3c3c3c3c',
  runId: 'run-1',
  outputs: [{ path: '介绍.md', size: 50 }],
  expects: ['*.md'],
};
/** harness 签发的产出包链接 */
const LINK = {
  url: 'http://127.0.0.1:8333/oasis-harness/runs/run-1/outputs.tar?sig',
  expiresAt: '2026-01-01T00:15:00.000Z',
};
/** harness：产出包链接、浏览器检查（各测试可以覆盖） */
const harnessWith = (answer: (path: string) => unknown = () => undefined) =>
  fakeService((path) => (path.endsWith('/outputs/link') ? LINK : answer(path)));
const parsed = (files: unknown[] = []) => ({ files, truncated: false });
const CALL = '4d4d4d4d-4d4d-4d4d-8d4d-4d4d4d4d4d4d';
/** model-gateway：检查容器的算力冻结和结算 */
const meterWith = (hold: () => unknown = () => ({ callId: CALL, heldMicro: 30 })) =>
  fakeService((path) => (path === '/internal/v1/compute' ? hold() : undefined));
const gateWith = (
  harness: ServiceClient,
  inspector: ServiceClient,
  modelGateway: ServiceClient = meterWith().client,
) => {
  const logger = pino({ level: 'silent' });
  return createGate({
    harness,
    inspector,
    compute: createCheckCompute({ modelGateway, logger }),
    media: { cores: 2, timeoutMs: 90_000 },
    browser: { cores: 2, maxMs: 3_600_000 },
    logger,
  });
};
/** 检查浏览器的报告（inspector 报回的格式） */
const pageReport = {
  version: 1,
  target: 'application',
  passed: false,
  steps: [],
  diagnostics: ['页面错误：boom'],
  unchecked: [],
};
const webApp = {
  ...input,
  expects: [],
  outputs: [
    { path: 'site/oasis-app.json', size: 50 },
    { path: 'site/index.html', size: 100 },
  ],
};

describe('轻量关卡（ADR 0017）', () => {
  it('普通文字成果只取 inspector 的解析报告，不读正文、不调模型', async () => {
    const harness = harnessWith();
    const inspector = fakeService(() => parsed([{ path: '介绍.md', text: '', valid: true }]));
    expect(await gateWith(harness.client, inspector.client).check(input)).toEqual({ unmet: [] });
    expect(harness.calls).toEqual([
      { path: '/internal/runs/run-1/outputs/link', body: { payerId: PAYER, taskId: TASK } },
    ]);
    expect(inspector.calls).toEqual([
      {
        path: '/internal/files/check',
        body: { source: LINK, paths: ['介绍.md'], maxChars: 1 },
      },
    ]);
  });
  it('缺文件直接退回，不再往下查', async () => {
    const harness = harnessWith();
    const inspector = fakeService(() => parsed());
    const result = await gateWith(harness.client, inspector.client).check({
      ...input,
      expects: ['报告.pdf'],
    });
    expect(result.unmet).toEqual(['缺少文件 out/报告.pdf']);
    expect(harness.calls).toHaveLength(0);
    expect(inspector.calls).toHaveLength(0);
  });
  it('确定损坏退回；解析资源不足只记未检查，不误报数量不足', async () => {
    const run = {
      ...input,
      outputs: [{ path: 'project.zip', size: 50 }],
      expects: [{ pattern: '*.zip', minCount: 1 }],
    };
    const gateFor = (errorKind: 'invalid' | 'incomplete') =>
      gateWith(
        harnessWith().client,
        fakeService(() =>
          parsed([{ path: 'project.zip', text: '', valid: false, error: '读取失败', errorKind }]),
        ).client,
      );
    const broken = await gateFor('invalid').check(run);
    expect(broken.unmet).toContain('project.zip：读取失败');
    expect(broken.unmet.join('')).toContain('有效文件 0 个');
    expect((await gateFor('incomplete').check(run)).unmet).toEqual([]);
  });
  it('期望文件没有解析报告时记为未检查', async () => {
    const result = await gateWith(harnessWith().client, fakeService(() => parsed()).client).check({
      ...input,
      expects: [{ pattern: '*.md' }],
    });
    expect(result).toEqual({ unmet: [], unchecked: ['介绍.md：没取得文件解析结果'] });
  });
  it('网页应用交给 inspector 在隔离浏览器里跑一遍：没跑通进入未满足项，报告存回 harness，算力记在任务上', async () => {
    const harness = harnessWith();
    const checked = {
      passed: false,
      reason: '首页脚本报错',
      frameCaptured: true,
      report: pageReport,
      screenshots: [{ name: 'opening.jpg', base64: 'AA==' }],
    };
    const inspector = fakeService((path) =>
      path === '/internal/applications/check'
        ? { ...checked, usage: { cores: 2, elapsedMs: 4000 } }
        : parsed(),
    );
    const meter = meterWith();
    const result = await gateWith(harness.client, inspector.client, meter.client).check(webApp);
    expect(result).toEqual({ unmet: ['浏览器实际运行检查失败：首页脚本报错'] });
    expect(inspector.calls.at(-1)).toEqual({
      path: '/internal/applications/check',
      body: { source: LINK, manifest: 'site/oasis-app.json', cores: 2 },
    });
    // 产出包链接只要一次；报告（不含用量）存回 harness，用户在工作流里下载
    expect(harness.calls).toEqual([
      { path: '/internal/runs/run-1/outputs/link', body: { payerId: PAYER, taskId: TASK } },
      {
        path: '/internal/runs/run-1/application-check',
        body: { payerId: PAYER, taskId: TASK, report: checked },
      },
    ]);
    expect(meter.calls).toEqual([
      {
        path: '/internal/v1/compute',
        body: expect.objectContaining({
          payerId: PAYER,
          taskId: TASK,
          nodeId: input.nodeId,
          cores: 2,
          maxMs: 3_600_000,
          purpose: 'application-check',
        }),
      },
      { path: `/internal/v1/compute/${CALL}/settle`, body: { cores: 2, elapsedMs: 4000 } },
    ]);
  });
  it('没开浏览器就有结论（清单不合格）时照样退回，没有报告可存；报告没存上不影响结论', async () => {
    const unopened = fakeService((path) =>
      path === '/internal/applications/check'
        ? {
            passed: false,
            reason: 'out/site/oasis-app.json 缺少 root',
            frameCaptured: false,
            usage: { cores: 2, elapsedMs: 0 },
          }
        : parsed(),
    );
    const harness = harnessWith();
    const result = await gateWith(harness.client, unopened.client).check(webApp);
    expect(result).toEqual({
      unmet: ['浏览器实际运行检查失败：out/site/oasis-app.json 缺少 root'],
    });
    expect(harness.calls.map((call) => call.path)).toEqual(['/internal/runs/run-1/outputs/link']);

    const opened = fakeService((path) =>
      path === '/internal/applications/check'
        ? {
            passed: true,
            reason: null,
            frameCaptured: true,
            report: { ...pageReport, passed: true, diagnostics: [] },
            usage: { cores: 2, elapsedMs: 10 },
          }
        : parsed(),
    );
    const storeDown = harnessWith((path) =>
      path.endsWith('/application-check')
        ? new HttpError(503, 'upstream_unavailable', 'harness 暂时不可用')
        : undefined,
    );
    expect(await gateWith(storeDown.client, opened.client).check(webApp)).toEqual({ unmet: [] });
  });
  it('音视频交给 inspector 解码：损坏退回，没查到的记未检查；算力按实际用时记在任务上', async () => {
    const harness = harnessWith();
    const inspector = fakeService((path) =>
      path === '/internal/media/check'
        ? {
            files: [
              { path: 'broken.mp3', valid: false, error: '解码失败' },
              { path: 'final.mp4', valid: true },
            ],
            unchecked: ['song.mp3'],
            usage: { cores: 2, elapsedMs: 1500 },
          }
        : parsed(),
    );
    const meter = meterWith();
    const result = await gateWith(harness.client, inspector.client, meter.client).check({
      ...input,
      expects: [{ pattern: '*.mp4', exactCount: 1 }],
      outputs: [
        { path: 'broken.mp3', size: 3 },
        { path: 'song.mp3', size: 10 },
        { path: 'final.mp4', size: 100 },
      ],
    });
    expect(result.unmet).toEqual(['音频「broken.mp3」解码失败']);
    expect(result.unchecked).toEqual(['音频「song.mp3」未完成解码检查']);
    // 音视频不交给文件解析；产出包链接只要一次
    expect(inspector.calls).toEqual([
      {
        path: '/internal/media/check',
        body: {
          source: LINK,
          paths: ['broken.mp3', 'song.mp3', 'final.mp4'],
          cores: 2,
          timeoutMs: 90_000,
        },
      },
    ]);
    expect(harness.calls).toHaveLength(1);
    expect(meter.calls).toEqual([
      {
        path: '/internal/v1/compute',
        body: expect.objectContaining({
          payerId: PAYER,
          taskId: TASK,
          nodeId: input.nodeId,
          cores: 2,
          maxMs: 120_000,
          purpose: 'media-check',
        }),
      },
      { path: `/internal/v1/compute/${CALL}/settle`, body: { cores: 2, elapsedMs: 1500 } },
    ]);
  });
  it('解码检查没做完（服务出错、余额不够冻结）：记未检查、不收钱，不当成果失败', async () => {
    const run = { ...input, expects: [], outputs: [{ path: 'final.mp4', size: 100 }] };
    const down = fakeService((path) =>
      path === '/internal/media/check'
        ? new HttpError(503, 'media_check_unavailable', '媒体检查镜像不存在')
        : parsed(),
    );
    const meter = meterWith();
    expect(await gateWith(harnessWith().client, down.client, meter.client).check(run)).toEqual({
      unmet: [],
      unchecked: ['音视频解码检查没做完：媒体检查镜像不存在（服务暂时不可用）'],
    });
    expect(meter.calls.at(-1)).toEqual({
      path: `/internal/v1/compute/${CALL}/settle`,
      body: { cores: 2, elapsedMs: 0 },
    });

    const broke = meterWith(() => new HttpError(402, 'insufficient_balance', '余额不足'));
    const idle = fakeService(() => parsed());
    const unpaid = await gateWith(harnessWith().client, idle.client, broke.client).check(run);
    expect(unpaid.unchecked).toEqual(['音视频解码检查没做完：余额不足']);
    expect(idle.calls).toHaveLength(0);
  });
  it('检查服务出错只记未检查，不当成果失败', async () => {
    const down = fakeService(() => new HttpError(502, 'bad_gateway', '上游断了'));
    const result = await gateWith(harnessWith().client, down.client).check(input);
    expect(result.unmet).toEqual([]);
    expect(result.unchecked).toEqual([
      '文件解析检查没做完：连不上平台的检查服务（网络中断或超时）',
    ]);
  });
  it('检查服务答非所问（缺字段、格式不对）：记未检查，不当成通过', async () => {
    const odd = fakeService(() => ({ passed: true }));
    const meter = meterWith();
    const result = await gateWith(harnessWith().client, odd.client, meter.client).check({
      ...input,
      expects: [{ pattern: '*.md' }],
      outputs: [
        { path: '介绍.md', size: 50 },
        { path: 'site/oasis-app.json', size: 50 },
        { path: '片段.mp4', size: 50 },
      ],
    });
    expect(result.unmet).toEqual([]);
    expect(result.unchecked).toEqual([
      expect.stringContaining('文件解析检查没做完'),
      expect.stringContaining('浏览器实际运行检查没做完'),
      expect.stringContaining('音视频解码检查没做完'),
    ]);
    // 解码、浏览器检查的报告不合格式也不收钱
    expect(meter.calls.filter((call) => call.path.endsWith('/settle'))).toEqual([
      { path: `/internal/v1/compute/${CALL}/settle`, body: { cores: 2, elapsedMs: 0 } },
      { path: `/internal/v1/compute/${CALL}/settle`, body: { cores: 2, elapsedMs: 0 } },
    ]);
  });
  it('用户取消时直接抛出，不记成未检查', async () => {
    const controller = new AbortController();
    controller.abort();
    const failing = fakeService(() => new Error('aborted'));
    await expect(
      gateWith(harnessWith().client, failing.client).check({
        ...input,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });
});
