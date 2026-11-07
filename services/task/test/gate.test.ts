import { HttpError, type ServiceClient } from '@oasis/service-kit';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { checkRules, createGate } from '../src/service/gate.ts';

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
});

/** 假的 harness：按路径返回固定内容，记下请求 */
function fakeHarness(answer: (path: string) => unknown) {
  const calls: { path: string; body: unknown }[] = [];
  const client = {
    async json(_method: string, path: string, options?: { body?: unknown }) {
      calls.push({ path, body: options?.body });
      const result = answer(path);
      if (result instanceof Error) throw result;
      return result;
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
const gateWith = (harness: ServiceClient) =>
  createGate({ harness, logger: pino({ level: 'silent' }) });
const texts = (files: unknown[] = []) => ({ files, truncated: false });

describe('轻量关卡（ADR 0017）', () => {
  it('普通文字成果只取解析报告，不读正文、不调模型', async () => {
    const harness = fakeHarness(() => texts([{ path: '介绍.md', text: '', valid: true }]));
    expect(await gateWith(harness.client).check(input)).toEqual({ unmet: [] });
    expect(harness.calls).toEqual([
      { path: '/internal/runs/run-1/texts', body: { paths: ['介绍.md'], maxChars: 1 } },
    ]);
  });
  it('缺文件直接退回，不再往下查', async () => {
    const harness = fakeHarness(() => texts());
    const result = await gateWith(harness.client).check({ ...input, expects: ['报告.pdf'] });
    expect(result.unmet).toEqual(['缺少文件 out/报告.pdf']);
    expect(harness.calls).toHaveLength(0);
  });
  it('确定损坏退回；解析资源不足只记未检查，不误报数量不足', async () => {
    const run = {
      ...input,
      outputs: [{ path: 'project.zip', size: 50 }],
      expects: [{ pattern: '*.zip', minCount: 1 }],
    };
    const gateFor = (errorKind: 'invalid' | 'incomplete') =>
      gateWith(
        fakeHarness(() =>
          texts([{ path: 'project.zip', text: '', valid: false, error: '读取失败', errorKind }]),
        ).client,
      );
    const broken = await gateFor('invalid').check(run);
    expect(broken.unmet).toContain('project.zip：读取失败');
    expect(broken.unmet.join('')).toContain('有效文件 0 个');
    expect((await gateFor('incomplete').check(run)).unmet).toEqual([]);
  });
  it('期望文件没有解析报告时记为未检查', async () => {
    const result = await gateWith(fakeHarness(() => texts()).client).check({
      ...input,
      expects: [{ pattern: '*.md' }],
    });
    expect(result).toEqual({ unmet: [], unchecked: ['介绍.md：没取得文件解析结果'] });
  });
  it.each(['site/oasis-app.json'])(
    '网页应用（清单 %s）在隔离浏览器里跑一遍，没跑通进入未满足项',
    async (manifest) => {
      const harness = fakeHarness((path) =>
        path.endsWith('/application-check')
          ? { passed: false, reason: '首页脚本报错', frameCaptured: true }
          : texts(),
      );
      const result = await gateWith(harness.client).check({
        ...input,
        expects: [],
        outputs: [
          { path: manifest, size: 50 },
          { path: 'index.html', size: 100 },
        ],
      });
      expect(result.unmet).toEqual(['浏览器实际运行检查失败：首页脚本报错']);
      expect(harness.calls[1]).toEqual({
        path: '/internal/runs/run-1/application-check',
        body: { payerId: PAYER, taskId: TASK },
      });
    },
  );
  it('音视频只看能不能解码：损坏退回，没报告的记未检查', async () => {
    const harness = fakeHarness((path) =>
      path.endsWith('/audio-check')
        ? { files: [{ path: 'broken.mp3', valid: false, error: '解码失败' }] }
        : path.endsWith('/video-check')
          ? { files: [{ path: 'final.mp4', valid: true }] }
          : texts(),
    );
    const result = await gateWith(harness.client).check({
      ...input,
      expects: [],
      outputs: [
        { path: 'broken.mp3', size: 3 },
        { path: 'song.mp3', size: 10 },
        { path: 'final.mp4', size: 100 },
      ],
    });
    expect(result.unmet).toEqual(['音频「broken.mp3」解码失败']);
    expect(result.unchecked).toEqual(['音频「song.mp3」未完成解码检查']);
  });
  it('检查服务出错只记未检查，不当成果失败', async () => {
    const harness = fakeHarness(() => new HttpError(502, 'bad_gateway', '上游断了'));
    const result = await gateWith(harness.client).check(input);
    expect(result.unmet).toEqual([]);
    expect(result.unchecked).toEqual([
      '文件解析检查没做完：连不上平台的检查服务（网络中断或超时）',
    ]);
  });
  it('用户取消时直接抛出，不记成未检查', async () => {
    const controller = new AbortController();
    controller.abort();
    const harness = fakeHarness(() => new Error('aborted'));
    await expect(
      gateWith(harness.client).check({ ...input, signal: controller.signal }),
    ).rejects.toThrow();
  });
});
