// 工具节点（ADR 0025）：规划门怎么查步骤、上游文件怎么变成上游必须交出的文件、怎么估价、开跑交给 harness 什么。
import type { ToolEntry } from '@oasis/contracts/model-gateway';
import { TOOL_RUN_MODEL } from '@oasis/contracts/harness';
import { checkToolArgs } from '@oasis/contracts/tool-args';
import { describe, expect, it } from 'vitest';
import { checkRules } from '../src/service/gate.ts';
import { kindOf } from '../src/service/kinds/index.ts';
import { unitsOf, upstreamFiles } from '../src/service/kinds/tool.ts';
import {
  checkPlan,
  estimatePlan,
  plannerPrompt,
  resourceSections,
} from '../src/service/planner.ts';

const sheet = {
  title: 't',
  deliverables: [{ name: '成片', form: 'MP4' }],
  criteria: [],
  style: [],
  budgetMicro: null,
  assumptions: [],
  materials: [],
};
const catalog = [
  {
    key: 'ds',
    name: 'DeepSeek',
    vendor: 'v',
    category: 'llm' as const,
    tags: [],
    providerModel: 'deepseek/x',
  },
];
const entry = (key: string, patch: Partial<ToolEntry> = {}): ToolEntry => ({
  key,
  name: key,
  description: 'd',
  usage: 'u',
  unit: '次',
  estimateMicro: 0,
  long: false,
  available: true,
  models: [],
  defaultModel: null,
  rates: [],
  args: [],
  local: false,
  ...patch,
});
const tools: ToolEntry[] = [
  entry('video.generate', {
    unit: '秒',
    long: true,
    models: ['v/fast', 'v/best'],
    defaultModel: 'v/fast',
    rates: [
      { model: 'v/fast', costMicro: 50_000, seconds: 60, basis: 'catalog' },
      { model: 'v/best', costMicro: 200_000, seconds: 90, basis: 'catalog' },
    ],
    args: [
      { name: 'prompt', kind: 'text', required: true, description: '画面' },
      { name: 'first_frame', kind: 'path', description: '首帧' },
      { name: 'duration', kind: 'number', min: 1, max: 20, description: '秒数' },
      { name: 'model', kind: 'text', description: '型号' },
    ],
    per: { arg: 'duration', default: 5 },
  }),
  entry('op.video.concat', {
    local: true,
    args: [{ name: 'in', kind: 'paths', required: true, min: 2, max: 50, description: '视频' }],
  }),
  entry('text.batch', { args: [{ name: 'in', kind: 'path', required: true, description: '行' }] }),
];
const fallback = { workRun: 1_000, speechRun: 1_000, computeRun: 10_000, nodeSeconds: 600 };

const shots = {
  key: 'shots',
  title: '写分镜',
  kind: 'work',
  goal: '写分镜和首帧',
  model: 'deepseek/x',
};
const cut = (steps: unknown[], extra: Record<string, unknown> = {}) => ({
  key: 'cut',
  title: '出片',
  kind: 'tool',
  goal: '按分镜生成两段再拼起来',
  steps,
  deliver: ['成片.mp4'],
  ...extra,
});
const goodSteps = [
  {
    tool: 'video.generate',
    args: { prompt: '镜头一', first_frame: 'in/shots/1.png', duration: 4 },
    out: 'out/1.mp4',
  },
  { tool: 'video.generate', args: { prompt: '镜头二', model: 'v/best' }, out: 'out/2.mp4' },
  { tool: 'op.video.concat', args: { in: ['out/1.mp4', 'out/2.mp4'] }, out: 'out/成片.mp4' },
];
const planOf = (nodes: unknown[], edges = [{ from: 'shots', to: 'cut' }]) =>
  JSON.stringify({ nodes, edges, deliverables: { 成片: 'cut' } });

describe('工具节点', () => {
  it('规划门：步骤合格就通过；上游文件成为上游必须交出的文件', () => {
    const result = checkPlan(planOf([shots, cut(goodSteps)]), sheet, catalog, tools);
    expect(result).toHaveProperty('plan');
    const plan = (result as Extract<typeof result, { plan: unknown }>).plan;
    expect(plan.nodes.find((n) => n.key === 'shots')?.expects).toEqual(['1.png']);
    // 工具节点不写模型
    expect(plan.nodes.find((n) => n.key === 'cut')?.model).toBe('');
  });

  it('规划门：工具不在目录、参数不对、型号不能用、引用的上游没连线，都交回规划员', () => {
    const result = checkPlan(
      planOf(
        [
          shots,
          cut([
            { tool: 'video.explode', args: {} },
            { tool: 'video.generate', args: { duration: 40, model: 'v/none' } },
            { tool: 'op.video.concat', args: { in: ['in/draw/1.mp4', 'out/x.mp4'] } },
            { tool: 'text.batch', args: { in: 'out/rows.jsonl' } },
          ]),
        ],
        [],
      ),
      sheet,
      catalog,
      tools,
    );
    expect(result).toHaveProperty('problems');
    const problems = (result as { problems: string[] }).problems.join('\n');
    expect(problems).toContain('工具节点「cut」第 1 步的工具 video.explode 不在可以用的工具里');
    expect(problems).toContain('第 2 步（video.generate）缺少参数 prompt');
    expect(problems).toContain('参数 duration 要在 1–20 之间');
    expect(problems).toContain('不能用型号 v/none');
    expect(problems).toContain('用到的 in/draw/ 不是任何节点交来的');
    expect(problems).toContain('text.batch 要写 model');
  });

  it('引用了上游的文件却没连线：要求连线', () => {
    const result = checkPlan(
      planOf(
        [
          shots,
          cut([{ tool: 'video.generate', args: { prompt: 'p', first_frame: 'in/shots/1.png' } }]),
        ],
        [],
      ),
      sheet,
      catalog,
      tools,
    );
    expect((result as { problems: string[] }).problems.join('\n')).toContain('要连线 shots → cut');
  });

  it('同一个结果路径写了两次：会互相覆盖，交回', () => {
    const result = checkPlan(
      planOf([
        shots,
        cut([
          { tool: 'video.generate', args: { prompt: 'a' }, out: 'out/a.mp4' },
          { tool: 'video.generate', args: { prompt: 'b' }, out: 'out/a.mp4' },
        ]),
      ]),
      sheet,
      catalog,
      tools,
    );
    expect((result as { problems: string[] }).problems.join('\n')).toContain(
      '有几步的结果都存到 out/a.mp4',
    );
  });

  it('估价：每步按工具单价 × 计费单位数（视频按秒，没写按默认），加一次算力；本地操作不花工具钱', () => {
    const plan = { nodes: [cut(goodSteps)], edges: [] } as never;
    const { perNode } = estimatePlan(plan, [], tools, fallback);
    // 4 秒 × 0.05 + 默认 5 秒 × 0.2 + 拼接 0 + 算力 0.01
    expect(perNode.get('cut')).toBe(4 * 50_000 + 5 * 200_000 + 10_000);
    expect(unitsOf({ tool: 'x', args: { n: 3 } }, { arg: 'n', default: 1 })).toBe(3);
    expect(unitsOf({ tool: 'x', args: {} }, undefined)).toBe(1);
  });

  it('估价：单价随清晰度变的按步骤写的清晰度取，没写或表里没有用默认（720p）单价', () => {
    const tiered = tools.map((t) =>
      t.key === 'video.generate'
        ? {
            ...t,
            rates: [
              {
                model: 'v/fast',
                costMicro: 100_000,
                seconds: 60,
                basis: 'catalog' as const,
                by: { arg: 'resolution', costMicro: { '480p': 50_000, '1080p': 200_000 } },
              },
            ],
          }
        : t,
    );
    const step = (resolution?: string) => ({
      tool: 'video.generate',
      args: { prompt: 'p', duration: 4, ...(resolution ? { resolution } : {}) },
    });
    const plan = {
      nodes: [cut([step('480p'), step('1080p'), step(), step('2K')])],
      edges: [],
    } as never;
    const { perNode } = estimatePlan(plan, [], tiered, fallback);
    expect(perNode.get('cut')).toBe(4 * (50_000 + 200_000 + 100_000 + 100_000) + 10_000);
    // 规划员看得到各档单价
    const text = resourceSections({
      catalog,
      tools: tiered,
      playbooks: [],
      defaultModel: 'deepseek/x',
    }).join('\n');
    expect(text).toContain('v/fast 每秒约 $0.10（resolution 480p $0.05、1080p $0.20）');
  });

  it('上游文件：路径、数组、JSON 数组、逗号分隔都认得出；不是文件的参数不算', () => {
    expect(
      upstreamFiles([
        {
          tool: 'op.video.concat',
          args: {
            in: 'in/a/1.mp4,in/b/2.mp4',
            extra: '["in/c/3.mp4"]',
            list: ['in/d/4.mp4'],
            prompt: '参考 in/e/5.png 的风格',
          },
        },
      ]),
    ).toEqual([
      { from: 'a', path: '1.mp4' },
      { from: 'b', path: '2.mp4' },
      { from: 'c', path: '3.mp4' },
      { from: 'd', path: '4.mp4' },
    ]);
  });

  it('开跑：一次工具运行，model 写 oasis/tool，带上步骤和上游；不收追问，关卡不返工，不换模型', () => {
    const node = {
      id: 'n1',
      key: 'cut',
      title: '出片',
      kind: 'tool' as const,
      goal: 'g',
      model: '',
      config: { steps: goodSteps },
      userNotes: [],
      currentRunId: null,
    };
    const plugin = kindOf(node);
    const snapshot = {
      task: { brief: 'b', sheet: null, materials: [], spentMicro: 0, createdAt: new Date() },
      nodes: [node],
      edges: [],
    } as never;
    const step = plugin.start(snapshot, node as never);
    expect(step.requests[0]).toMatchObject({
      purpose: 'work',
      model: TOOL_RUN_MODEL,
      steps: goodSteps,
      inputsFrom: [],
    });
    expect(plugin.listens || plugin.reworkable || plugin.switchable || plugin.continuable).toBe(
      false,
    );
    // 停下前那次运行已经交出产出：直接重新过关卡；否则接着原运行
    const last = { id: 'r1', status: 'succeeded' } as never;
    expect(
      plugin.resume(
        snapshot,
        { ...node, config: { ...node.config, outputsRunId: 'r1' } } as never,
        last,
      ),
    ).toBe('gate');
    const carry = plugin.resume(snapshot, { ...node, currentRunId: 'r2' } as never, undefined);
    expect(carry).toMatchObject({ requests: [{ continueFrom: 'r2', steps: goodSteps }] });
    expect(plugin.body(node as never)).toMatchObject({
      tools: [
        { key: 'video.generate', uses: 2 },
        { key: 'op.video.concat', uses: 1 },
      ],
      steps: goodSteps,
    });
  });

  it('规划员看得到每个工具的参数和本地操作，也知道什么时候用工具节点', () => {
    const prompt = plannerPrompt({
      brief: 'b',
      sheet,
      catalog,
      tools,
      playbooks: [],
      defaultModel: 'deepseek/x',
    });
    expect(prompt).toContain('参数：prompt*（文字；画面）、first_frame（文件；首帧）');
    expect(prompt).toContain('duration（数字 1–20；秒数）');
    expect(prompt).toContain(
      'op.video.concat（op.video.concat）：d\n  沙箱里的本地操作，不花工具钱',
    );
    expect(prompt).toContain('kind：tool 不用 AI');
  });

  it('参数检查：多余的参数、文件路径不在沙箱、列表个数不对', () => {
    const specs = tools[1]!.args;
    expect(checkToolArgs(specs, { in: ['in/a/1.mp4'] })).toEqual(['参数 in 要写 2–50 项']);
    expect(checkToolArgs(specs, { in: ['/etc/passwd', 'in/a/2.mp4'] })[0]).toContain(
      '沙箱里的文件路径',
    );
    expect(checkToolArgs(specs, { in: 'in/a/1.mp4,in/a/2.mp4', fps: 30 })[0]).toContain(
      '不认识参数 fps',
    );
  });

  it('目录参数（app.check 检查上游交来的网页）：要写沙箱里的目录；上游要交出这个目录，目录里有文件就算交了', () => {
    const withCheck = [
      ...tools,
      entry('app.check', {
        args: [{ name: 'dir', kind: 'dir', required: true, description: '应用目录' }],
      }),
    ];
    const build = {
      key: 'build',
      title: '做网页',
      kind: 'work',
      goal: '做网页',
      model: 'deepseek/x',
      deliver: ['site/**'],
    };
    const plan = (dir: string) =>
      JSON.stringify({
        nodes: [
          build,
          {
            key: 'check',
            title: '浏览器自查',
            kind: 'tool',
            goal: '检查上游交来的网页',
            steps: [{ tool: 'app.check', args: { dir }, out: 'out/check-report.json' }],
          },
        ],
        edges: [{ from: 'build', to: 'check' }],
        deliverables: { 成片: 'build' },
      });
    // 不在沙箱目录约定里的写法在规划时就退回，不等到节点开跑才失败
    const bad = checkPlan(plan('site'), sheet, catalog, withCheck);
    expect((bad as { problems: string[] }).problems.join('\n')).toContain(
      '参数 dir 要写沙箱里的目录路径',
    );
    const good = checkPlan(plan('in/build/site'), sheet, catalog, withCheck);
    expect(good).toHaveProperty('plan');
    const expects = (good as Extract<typeof good, { plan: unknown }>).plan.nodes.find(
      (n) => n.key === 'build',
    )!.expects;
    expect(expects).toEqual(['site']);
    // 2026-11-10：以前关卡把「site」当成一个文件找，报缺少文件并让上游白返工一次
    expect(checkRules([{ path: 'site/index.html', size: 10 }], expects)).toEqual([]);
    expect(
      resourceSections({ catalog, tools: withCheck, playbooks: [], defaultModel: 'x' })[1],
    ).toContain('dir*（目录；应用目录）');
  });
});
