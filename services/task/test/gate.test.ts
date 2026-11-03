import type { ServiceClient } from '@oasis/service-kit';
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

/** 假的服务客户端：按路径返回固定内容，记下请求 */
function fakeClient(answer: (path: string, body: unknown) => unknown) {
  const calls: { path: string; body: unknown; headers?: Record<string, string> }[] = [];
  const client = {
    async json(
      _method: string,
      path: string,
      options?: { body?: unknown; headers?: Record<string, string> },
    ) {
      calls.push({ path, body: options?.body, headers: options?.headers });
      return answer(path, options?.body);
    },
    stream: () => Promise.reject(new Error('不用')),
  } as unknown as ServiceClient;
  return { client, calls };
}

const PAYER = '7d0c2f1e-1b2a-4c3d-8e4f-5a6b7c8d9e0f';
const TASK = '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b';
const NODE = '3c3c3c3c-3c3c-4c3c-8c3c-3c3c3c3c3c3c';
const input = {
  payerId: PAYER,
  taskId: TASK,
  nodeId: NODE as string | null,
  goal: '写一份介绍',
  runs: [{ runId: 'run-1', summary: '写好了', outputs: [{ path: '介绍.md', size: 50 }] }],
  checks: ['提到了价格', '语气友好'],
  expects: ['*.md'],
};

describe('关卡的验收点检查', () => {
  it.each([NODE, null])('节点与最终语义验收都取得平台浏览器断言证据：%s', async (nodeId) => {
    const report = {
      version: 1,
      target: 'application',
      passed: true,
      steps: [{ index: 0, action: 'text', status: 'passed', actual: '2' }],
      diagnostics: [],
      unchecked: [],
    };
    const application = {
      manifestPath: 'site/oasis-app.json',
      spec: { version: 1, kind: 'static', root: 'site', entry: 'index.html' },
      files: ['site/index.html', 'site/oasis-app.json', 'site/oasis-test.json'],
      plan: { version: 1, steps: [{ action: 'text', selector: '#count', text: '2' }] },
      network: 'none',
    };
    const harness = fakeClient((path) => {
      if (path.endsWith('/application-check/report'))
        return { report, screenshots: [], application, inputSha256: 'a'.repeat(64) };
      if (path.endsWith('/application-check'))
        return {
          passed: true,
          reason: null,
          frameCaptured: true,
          report,
          application,
          inputSha256: 'a'.repeat(64),
        };
      return {
        files: [{ path: 'site/oasis-app.json', text: '{}', valid: true }],
        truncated: false,
      };
    });
    const gateway = fakeClient(() => ({ answers: { c0: { noul: 0.9 }, f0: { noul: 0.1 } } }));
    const gate = createGate({
      harness: harness.client,
      modelGateway: gateway.client,
      model: 'jev',
      threshold: 0.5,
      logger: pino({ level: 'silent' }),
    });
    const result = await gate.check({
      ...input,
      nodeId,
      checks: ['点击两次后显示2'],
      expects: ['site/oasis-app.json'],
      runs: [
        {
          runId: 'app',
          summary: '不采用自述',
          outputs: [{ path: 'site/oasis-app.json', size: 2 }],
        },
      ],
    });
    expect(result).toEqual({ unmet: [] });
    const state = (gateway.calls[0]?.body as { state: string[] }).state.join('\n');
    expect(state).toContain('平台隔离浏览器实际执行的受信报告');
    expect(state).toContain('"actual":"2"');
    expect(state).toContain('"network":"none"');
    expect(state).toContain('ApplicationSpec/ApplicationBundle');
    expect(state).toContain('"manifestPath":"site/oasis-app.json"');
    expect(state).toContain('a'.repeat(64));
    expect(
      harness.calls.filter((c) => c.path.includes('application-check')).map((c) => c.path),
    ).toEqual([`/internal/runs/app/application-check${nodeId ? '' : '/report'}`]);
  });
  it('几何结构证据可以支持结构要求，不能替代外观证据；范围说明不会卡死已核验的要求', async () => {
    const harness = fakeClient(() => ({
      files: [
        {
          path: 'model.glb',
          valid: true,
          text: '{"meshes":2,"unchecked":["外观"]}',
          warning: '仅完成几何结构检查，外观尚未核验',
          evidenceScope: 'geometry',
        },
      ],
      truncated: false,
    }));
    const gateway = fakeClient(() => ({
      answers: { c0: { noul: 0.9 }, f0: { noul: 0.1 }, c1: { noul: 0.1 }, f1: { noul: 0.1 } },
    }));
    const gate = createGate({
      harness: harness.client,
      modelGateway: gateway.client,
      model: 'jev',
      threshold: 0.5,
      logger: pino({ level: 'silent' }),
    });
    const structure = await gate.check({
      ...input,
      runs: [{ runId: 'geometry', summary: null, outputs: [{ path: 'model.glb', size: 100 }] }],
      expects: ['model.glb'],
      checks: ['包含两个网格'],
      details: true,
    });
    expect(structure.unchecked).toBeUndefined();
    expect(structure.checks?.[0]?.status).toBe('passed');
    expect(structure.notes?.join('')).toContain('外观尚未核验');
    const combined = await gate.check({
      ...input,
      runs: [{ runId: 'geometry', summary: null, outputs: [{ path: 'model.glb', size: 100 }] }],
      expects: ['model.glb'],
      checks: ['包含两个网格', '外观符合雨夜便利店'],
      details: true,
    });
    expect(combined.checks?.map((c) => c.status)).toEqual(['passed', 'unchecked']);
    expect(combined.unchecked?.join('')).toContain('外观符合雨夜便利店');
    expect(JSON.stringify(gateway.calls[0]?.body)).toContain('范围外无独立证据须回答否');
  });

  it('缺乏支持不是违反；互相矛盾的判断也保持未知', async () => {
    const gate = createGate({
      harness: fakeClient(() => ({
        files: [{ path: '介绍.md', text: '可读正文' }],
        truncated: false,
      })).client,
      modelGateway: fakeClient(() => ({
        answers: { c0: { noul: 0.1 }, f0: { noul: 0.1 }, c1: { noul: 0.9 }, f1: { noul: 0.9 } },
      })).client,
      model: 'jev',
      threshold: 0.5,
      logger: pino({ level: 'silent' }),
    });
    const result = await gate.check({ ...input, details: true });
    expect(result.unmet).toEqual([]);
    expect(result.checks?.map((c) => c.status)).toEqual(['unchecked', 'unchecked']);
  });
  it('检查器取得原始材料、上游数据和系统计费事实，不要求成果写调用预算', async () => {
    const harness = fakeClient((path) =>
      path.includes('/materials/')
        ? {
            files: [
              {
                uploadId: PAYER,
                name: '原始.csv',
                sha256: 'a'.repeat(64),
                text: 'V01,电器安全,09:00',
                status: 'complete',
              },
            ],
          }
        : {
            files: [
              {
                path: path.includes('source-run') ? '排班.json' : '介绍.md',
                text: path.includes('source-run') ? 'V01 09:00' : '组织者说明',
              },
            ],
            truncated: false,
          },
    );
    const gateway = fakeClient(() => ({ answers: { c0: { noul: 0.9 }, f0: { noul: 0.1 } } }));
    const gate = createGate({
      harness: harness.client,
      modelGateway: gateway.client,
      model: 'jev',
      threshold: 0.5,
      logger: pino({ level: 'silent' }),
    });
    await gate.check({
      ...input,
      checks: ['预算及原始排班一致'],
      ownerId: PAYER,
      materials: [{ uploadId: PAYER, name: '原始.csv', size: 20 }],
      execution: { spentMicro: 54426, budgetMicro: 750000 },
      references: [
        { runId: 'source-run', summary: null, outputs: [{ path: '排班.json', size: 30 }] },
      ],
    });
    const state = (gateway.calls[0]?.body as { state: string[] }).state.join('\n');
    expect(state).toContain('V01,电器安全,09:00');
    expect(state).toContain('V01 09:00');
    expect(state).toContain('54426');
    expect(state).toContain('750000');
  });
  it('确定损坏与解析资源不足区分：损坏退回，超限留未检查且不误报数量不足', async () => {
    const run = {
      ...input,
      checks: [],
      expects: [{ pattern: '*.zip', minCount: 1 }],
      runs: [{ runId: 'r', summary: null, outputs: [{ path: 'project.zip', size: 50 }] }],
    };
    const gateFor = (errorKind: 'invalid' | 'incomplete') =>
      createGate({
        harness: fakeClient(() => ({
          files: [{ path: 'project.zip', text: '', valid: false, error: '读取失败', errorKind }],
          truncated: false,
        })).client,
        modelGateway: fakeClient(() => ({})).client,
        model: 'jev',
        threshold: 0.5,
        logger: pino({ level: 'silent' }),
      });
    expect((await gateFor('invalid').check(run)).unmet.length).toBeGreaterThan(0);
    const limited = await gateFor('incomplete').check(run);
    expect(limited.unmet).toEqual([]);
    expect(limited.unchecked?.join('')).toContain('读取失败');
  });
  it('逐项检查：无法读取附件不阻止对另一个完整文件判断，缺证据不误判失败', async () => {
    const harness = fakeClient(() => ({
      files: [
        { path: '说明.md', text: '报价合计217.80 SGD', valid: true },
        { path: 'unknown.bin', text: '', warning: '格式未支持' },
      ],
      truncated: false,
    }));
    const gateway = fakeClient(() => ({ answers: { c1: { noul: 0.9 }, f1: { noul: 0.1 } } }));
    const gate = createGate({
      harness: harness.client,
      modelGateway: gateway.client,
      model: 'jev',
      threshold: 0.5,
      logger: pino({ level: 'silent' }),
    });
    const result = await gate.check({
      ...input,
      expects: [],
      checks: [
        { id: 'unknown', text: '附件可读', files: ['unknown.bin'], requirementIds: [] },
        { id: 'sum', text: '按报价计算', files: ['说明.md'], requirementIds: [] },
      ],
      runs: [
        {
          runId: 'r',
          summary: null,
          outputs: [
            { path: '说明.md', size: 30 },
            { path: 'unknown.bin', size: 50 },
          ],
        },
      ],
    });
    expect(result.unmet).toEqual([]);
    expect(result.checks?.map((c) => c.status)).toEqual(['unchecked', 'passed']);
    expect(Object.keys((gateway.calls[0]?.body as { questions: object }).questions)).toEqual([
      'c1',
      'f1',
    ]);
  });
  it('视频、工程与字幕使用可信检查；损坏退回，黑帧/音画差及语义检查保留提醒', async () => {
    const harness = fakeClient((path) => {
      expect(path).toContain('/video-check');
      return {
        files: [
          {
            path: 'final.mp4',
            valid: true,
            blackIntervals: [{ startMs: 0, endMs: 500 }],
            avDeltaMs: 200,
          },
          { path: 'project/project.mlt', valid: false, error: '工程摘要不符' },
        ],
        unchecked: ['subtitles.srt'],
      };
    });
    const gate = createGate({
      harness: harness.client,
      modelGateway: fakeClient(() => ({})).client,
      model: 'jev',
      threshold: 0.5,
      logger: pino({ level: 'silent' }),
    });
    const result = await gate.check({
      ...input,
      checks: [],
      expects: ['*.mp4'],
      runs: [
        {
          runId: 'run-1',
          summary: null,
          outputs: [
            { path: 'final.mp4', size: 100 },
            { path: 'project/project.mlt', size: 80 },
            { path: 'subtitles.srt', size: 10 },
          ],
        },
      ],
    });
    expect(result.unmet).toContain('视频/工程/字幕「project/project.mlt」工程摘要不符');
    expect(result.notes?.join('\n')).toContain('黑帧');
    expect(result.notes?.join('\n')).toContain('200 毫秒');
    expect(result.unchecked?.join('\n')).toContain('subtitles.srt');
    expect(result.notes?.join('\n')).toContain('Shotcut');
    expect(harness.calls[0]?.body).toEqual({ payerId: PAYER, taskId: TASK });
  });
  it('音频只用受信解码结果判断文件有效，缺少报告保持未检查', async () => {
    const gate = createGate({
      harness: fakeClient(() => ({
        files: [{ path: 'broken.mp3', valid: false, error: '解码失败' }],
        unchecked: ['song.mp3'],
      })).client,
      modelGateway: fakeClient(() => ({})).client,
      model: 'jev',
      threshold: 0.5,
      logger: pino({ level: 'silent' }),
    });
    const result = await gate.check({
      ...input,
      checks: [],
      expects: ['*.mp3'],
      runs: [
        {
          runId: 'run-1',
          summary: null,
          outputs: [
            { path: 'broken.mp3', size: 3 },
            { path: 'song.mp3', size: 10 },
          ],
        },
      ],
    });
    expect(result.unmet).toEqual(['音频「broken.mp3」解码失败']);
    expect(result.unchecked).toEqual(['音频「song.mp3」未完成解码检查']);
  });
  it('应用清单必须经过隔离浏览器打开；运行失败进入未满足项', async () => {
    const harness = fakeClient((path) =>
      path.endsWith('/application-check')
        ? { passed: false, reason: '首页脚本报错', frameCaptured: true }
        : { files: [], truncated: false },
    );
    const gate = createGate({
      harness: harness.client,
      modelGateway: fakeClient(() => ({})).client,
      model: 'jev',
      threshold: 0.5,
      logger: pino({ level: 'silent' }),
    });
    const result = await gate.check({
      ...input,
      checks: [],
      expects: ['site/oasis-app.json'],
      runs: [
        {
          runId: 'run-1',
          summary: null,
          outputs: [
            { path: 'site/oasis-app.json', size: 50 },
            { path: 'site/index.html', size: 100 },
          ],
        },
      ],
    });
    expect(result.unmet).toEqual(['浏览器实际运行检查失败：首页脚本报错']);
    expect(harness.calls.map((call) => call.path)).toEqual([
      '/internal/runs/run-1/application-check',
    ]);
  });
  it.each([
    { name: '正文截断', files: [{ path: '介绍.md', text: '部分正文' }], truncated: true },
    { name: '内容缺失', files: [], truncated: false },
    {
      name: '解析受限',
      files: [{ path: '介绍.md', text: '', valid: false, warning: '解析范围受限' }],
      truncated: false,
    },
  ])('$name 时报告未检查，不把证据不足转成语义失败', async ({ files, truncated }) => {
    const gateway = fakeClient(() => ({ answers: { c0: { noul: 0 }, c1: { noul: 0 } } }));
    const gate = createGate({
      harness: fakeClient(() => ({ files, truncated })).client,
      modelGateway: gateway.client,
      model: 'jev',
      threshold: 0.5,
      logger: pino({ level: 'silent' }),
    });
    const result = await gate.check({ ...input, expects: [{ pattern: '介绍.md' }] });
    expect(result.unmet).toEqual([]);
    expect(result.unchecked?.length).toBeGreaterThan(0);
    expect(gateway.calls).toHaveLength(0);
  });

  it.each([100, 200])(
    '视觉仅抽样时不让语义检查推断全部文件，确定性尺寸要求 %i 仍有效',
    async (width) => {
      const images = Array.from({ length: 5 }, (_, i) => ({ path: `${i}.png`, size: 3 }));
      const harness = {
        ...fakeClient(() => ({
          files: images.map((image) => ({
            ...image,
            text: '',
            valid: true,
            width: 100,
            height: 100,
          })),
          truncated: false,
        })).client,
        stream: async () => new Response(Buffer.from('png')),
      } as ServiceClient;
      const gateway = fakeClient((path) =>
        path.includes('image.inspect')
          ? { text: '抽样的两张图没有文字' }
          : { answers: { c0: { noul: 0 } } },
      );
      const gate = createGate({
        harness,
        modelGateway: gateway.client,
        model: 'jev',
        threshold: 0.5,
        visionMaxImages: 2,
        logger: pino({ level: 'silent' }),
      });
      const result = await gate.check({
        ...input,
        checks: ['全部五张图片无文字'],
        expects: [{ pattern: '*.png', exactCount: 5, width }],
        runs: [{ runId: 'images', summary: null, outputs: images }],
      });
      if (width === 100) {
        expect(result.unmet).toEqual([]);
        expect(result.unchecked?.join('')).toContain('2/5');
        expect(gateway.calls.map((call) => call.path)).toEqual([
          '/internal/v1/tools/image.inspect',
        ]);
      } else {
        expect(result.unmet).toHaveLength(5);
        expect(result.unmet.every((message) => message.includes('尺寸 100×100'))).toBe(true);
        expect(gateway.calls).toHaveLength(0);
      }
    },
  );

  it('视觉工具取得真实图片并保留支付归属；失败明确未检查且不问 Jev', async () => {
    const images = [{ path: 'a.png', size: 3 }];
    const harness = {
      ...fakeClient(() => ({
        files: [{ path: 'a.png', text: '', valid: true, width: 1, height: 1 }],
        truncated: false,
      })).client,
      stream: async () => new Response(Buffer.from('png')),
    } as ServiceClient;
    const gateway = fakeClient((path) =>
      path.includes('image.inspect')
        ? { text: '一只杯子' }
        : { answers: { c0: { noul: 0.9 }, f0: { noul: 0.1 } } },
    );
    const gate = createGate({
      harness,
      modelGateway: gateway.client,
      model: 'jev',
      threshold: 0.5,
      logger: pino({ level: 'silent' }),
    });
    expect(
      await gate.check({
        ...input,
        checks: ['有杯子'],
        expects: [],
        runs: [{ runId: 'r', summary: null, outputs: images }],
      }),
    ).toEqual({ unmet: [] });
    expect(gateway.calls[0]).toMatchObject({
      path: '/internal/v1/tools/image.inspect',
      headers: { 'x-oasis-payer-id': PAYER, 'x-oasis-task-id': TASK, 'x-oasis-node-id': NODE },
    });
    expect((gateway.calls[1]?.body as { state: string[] }).state.join('\n')).toContain('一只杯子');
    const broken = fakeClient(() => {
      throw new Error('视觉服务不可用');
    });
    const unchecked = await createGate({
      harness,
      modelGateway: broken.client,
      model: 'jev',
      threshold: 0.5,
      logger: pino({ level: 'silent' }),
    }).check({ ...input, expects: [], runs: [{ runId: 'r', summary: null, outputs: images }] });
    expect(unchecked.unchecked?.join('')).toContain('视觉检查未完成');
    expect(broken.calls).toHaveLength(1);
  });
  it('分别询问支持与明确违反证据；明确违反才没满足，记在付钱的人账上', async () => {
    const harness = fakeClient(() => ({
      files: [{ path: '介绍.md', text: '欢迎光临' }],
      truncated: false,
    }));
    const gateway = fakeClient(() => ({
      answers: {
        c0: { type: 'noul', noul: 0.2 },
        f0: { noul: 0.9 },
        c1: { type: 'noul', noul: 0.9 },
        f1: { noul: 0.1 },
      },
    }));
    const gate = createGate({
      harness: harness.client,
      modelGateway: gateway.client,
      model: 'typesafe/jev-1.14',
      threshold: 0.5,
      logger: pino({ level: 'silent' }),
    });
    expect(await gate.check(input)).toEqual({ unmet: ['提到了价格'] });
    expect(harness.calls[0]).toMatchObject({
      path: '/internal/runs/run-1/texts',
      body: { paths: ['介绍.md'], maxChars: 50000 },
    });
    expect(harness.calls).toHaveLength(1);
    const call = gateway.calls[0] as {
      body: { state: string[]; questions: object };
      headers: object;
    };
    expect(call.headers).toEqual({
      'x-oasis-payer-id': PAYER,
      'x-oasis-task-id': TASK,
      'x-oasis-node-id': NODE,
    });
    expect(Object.keys(call.body.questions)).toEqual(['c0', 'f0', 'c1', 'f1']);
    expect(call.body.state.join('\n')).toContain('欢迎光临');
  });

  it('规则没过就不问 Jev；Jev 出错保存为未检查', async () => {
    const gateway = fakeClient(() => {
      throw new Error('连不上');
    });
    const gate = createGate({
      harness: fakeClient(() => ({
        files: [{ path: '介绍.md', text: '完整正文' }],
        truncated: false,
      })).client,
      modelGateway: gateway.client,
      model: 'typesafe/jev-1.14',
      threshold: 0.5,
      logger: pino({ level: 'silent' }),
    });
    expect(await gate.check({ ...input, runs: [{ ...input.runs[0]!, outputs: [] }] })).toEqual({
      unmet: ['out/ 里没有任何产出文件'],
    });
    expect(gateway.calls).toHaveLength(0);
    expect(await gate.check(input)).toEqual({
      unmet: [],
      unchecked: ['验收点检查服务异常，检查未完成'],
    });
  });

  it('整体验收：几个节点的运行一起看（各自标上名字），不带节点归属', async () => {
    const harness = fakeClient((path) => ({
      files: [
        {
          path: path.includes('run-2') ? 'b.md' : '介绍.md',
          text: path.includes('run-2') ? '第二份' : '第一份',
        },
      ],
      truncated: false,
    }));
    const gateway = fakeClient(() => ({
      answers: { c0: { type: 'noul', noul: 0.9 }, f0: { noul: 0.1 } },
    }));
    const gate = createGate({
      harness: harness.client,
      modelGateway: gateway.client,
      model: 'typesafe/jev-1.14',
      threshold: 0.5,
      logger: pino({ level: 'silent' }),
    });
    const result = await gate.check({
      ...input,
      nodeId: null,
      checks: ['都写好了'],
      runs: [
        { ...input.runs[0]!, label: '首页文案' },
        { runId: 'run-2', summary: null, outputs: [{ path: 'b.md', size: 1 }], label: '海报' },
      ],
    });
    expect(result).toEqual({ unmet: [] });
    expect(harness.calls.map((c) => c.path)).toEqual([
      '/internal/runs/run-1/texts',
      '/internal/runs/run-2/texts',
    ]);
    expect(harness.calls.map((c) => c.body)).toEqual([
      { paths: ['介绍.md'], maxChars: 25000 },
      { paths: ['b.md'], maxChars: 25000 },
    ]);
    const call = gateway.calls[0] as { body: { state: string[] }; headers: object };
    expect(call.headers).toEqual({ 'x-oasis-payer-id': PAYER, 'x-oasis-task-id': TASK });
    expect(call.body.state.join('\n')).toContain('「海报」产出文件：b.md');
  });
});
