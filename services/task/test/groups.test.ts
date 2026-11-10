// 子节点（ADR 0026）的纯函数部分：模板、清单、挑选结果、规划门和估价。
import type { ToolEntry } from '@oasis/contracts/model-gateway';
import { describe, expect, it } from 'vitest';
import { fillTemplate, listItems } from '../src/service/groups.ts';
import { parsePick, pickRequest } from '../src/service/pick.ts';
import { checkPlan, estimatePlan } from '../src/service/planner.ts';

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
  entry('image.generate', {
    rates: [{ model: 'i/1', costMicro: 100_000, seconds: 10, basis: 'catalog' }],
    args: [{ name: 'prompt', kind: 'text', required: true, description: '画面' }],
  }),
  entry('media.inspect', {
    rates: [{ model: 'v/1', costMicro: 2_000, seconds: 5, basis: 'catalog' }],
    args: [
      { name: 'files', kind: 'paths', required: true, min: 1, max: 4, description: '文件' },
      { name: 'question', kind: 'text', required: true, description: '问题' },
    ],
  }),
  entry('video.generate', {
    unit: '秒',
    rates: [{ model: 'v/fast', costMicro: 50_000, seconds: 60, basis: 'catalog' }],
    args: [
      { name: 'prompt', kind: 'text', required: true, description: '画面' },
      { name: 'first_frame', kind: 'path', description: '首帧' },
      { name: 'duration', kind: 'number', min: 1, max: 20, description: '秒数' },
    ],
    per: { arg: 'duration', default: 5 },
  }),
  entry('op.video.concat', {
    local: true,
    args: [{ name: 'in', kind: 'paths', required: true, min: 2, max: 50, description: '视频' }],
  }),
];
const fallback = { workRun: 1_000, speechRun: 1_000, computeRun: 10_000, nodeSeconds: 600 };

const storyboard = {
  key: 'storyboard',
  title: '写分镜',
  kind: 'work',
  goal: '写 out/shots.json',
  model: 'deepseek/x',
  expects: ['shots.json'],
};
const keyframes = {
  key: 'keys',
  title: '关键帧',
  kind: 'foreach',
  over: 'in/storyboard/shots.json',
  count: 4,
  goal: '每个镜头一张关键帧',
  each: {
    kind: 'tool',
    goal: '镜头 {{index}}',
    steps: [{ tool: 'image.generate', args: { prompt: '{{item.prompt}}' }, out: 'out/frame.png' }],
    variants: { n: 2, pick: '构图贴近描述' },
  },
};
const clips = {
  key: 'clips',
  title: '镜头视频',
  kind: 'foreach',
  over: 'in/storyboard/shots.json',
  count: 4,
  goal: '每个镜头一段视频',
  each: {
    kind: 'tool',
    goal: '镜头 {{index}}',
    steps: [
      {
        tool: 'video.generate',
        args: {
          prompt: '{{item.prompt}}',
          first_frame: 'in/keys/{{index}}/frame.png',
          duration: '{{item.seconds}}',
        },
        out: 'out/clip.mp4',
      },
    ],
  },
};
const film = {
  key: 'film',
  title: '成片',
  kind: 'tool',
  goal: '拼成片',
  steps: [{ tool: 'op.video.concat', args: { in: 'in/clips/*/clip.mp4' }, out: 'out/成片.mp4' }],
  deliver: ['成片.mp4'],
};
const edges = [
  { from: 'storyboard', to: 'keys' },
  { from: 'storyboard', to: 'clips' },
  { from: 'keys', to: 'clips' },
  { from: 'clips', to: 'film' },
];
const planText = (nodes: unknown[], deliverables = { 成片: 'film' }, links = edges) =>
  JSON.stringify({ nodes, edges: links, deliverables });

describe('模板和清单', () => {
  it('{{index}} 换成两位数条目号，{{item.字段}} 换成字段；缺的字段记下来', () => {
    const missing: string[] = [];
    expect(
      fillTemplate(
        { a: '镜头 {{index}}：{{item.prompt}}', b: ['{{item.size.w}}', 3], c: '{{item}}' },
        7,
        { prompt: '日出', size: { w: 640 } },
        missing,
      ),
    ).toEqual({ a: '镜头 07：日出', b: ['640', 3], c: '{"prompt":"日出","size":{"w":640}}' });
    expect(missing).toEqual([]);
    fillTemplate('{{item.nope}}', 1, {}, missing);
    expect(missing).toEqual(['{{item.nope}}']);
  });

  it('清单：数组或只含一个数组的对象，1 到 24 条', () => {
    expect(listItems('[1,2]')).toEqual({ items: [1, 2] });
    expect(listItems('{"shots":[{"a":1}],"note":"x"}')).toEqual({ items: [{ a: 1 }] });
    expect(listItems('nope')).toEqual({ problem: '不是合法的 JSON' });
    expect(listItems('[]')).toMatchObject({ problem: expect.stringContaining('空的') });
    expect(listItems(JSON.stringify(Array(25).fill(1)))).toMatchObject({
      problem: expect.stringContaining('最多展开 24 条'),
    });
  });

  it('挑选结果：要选做成了的一版，理由要说出具体差别', () => {
    expect(
      parsePick('结论：{"choice": 2, "reason": "第 2 版人物在画面中央，光线也更自然"}', [1, 2]),
    ).toMatchObject({ choice: 2 });
    expect(
      parsePick('{"choice": 3, "reason": "第 3 版人物在画面中央，光线也更自然"}', [1, 2]),
    ).toMatchObject({ problem: expect.stringContaining('不在做成的几版里') });
    expect(parsePick('{"choice": 1, "reason": "更好"}', [1, 2])).toMatchObject({
      problem: expect.stringContaining('理由太笼统'),
    });
    // 版本号写成 "v2"、"第 2 版" 也认（真实任务里挑配乐的回答写了 "v1"，被当成没选中）
    for (const choice of ['"v2"', '"第 2 版"'])
      expect(
        parsePick(
          `{"choice": ${choice}, "reason": "第 2 版结尾收得干净，雨声一直铺到最后"}`,
          [1, 2],
        ),
      ).toMatchObject({ choice: 2 });
    expect(parsePick(undefined, [1, 2])).toMatchObject({
      problem: expect.stringContaining('pick.txt'),
    });
  });
});

describe('规划门和估价', () => {
  it('按分镜出视频的方案能过：模板参数等展开时再查，展开节点的条目不成为上游必须交出的文件', () => {
    const result = checkPlan(planText([storyboard, keyframes, clips, film]), sheet, catalog, tools);
    expect(result).toHaveProperty('plan');
    const plan = (result as Extract<typeof result, { plan: unknown }>).plan;
    expect(plan.nodes.find((n) => n.key === 'storyboard')?.expects).toEqual(['shots.json']);
    expect(plan.nodes.find((n) => n.key === 'keys')?.expects).toEqual([]);
  });

  it('展开节点不能直接交付，清单不能来自展开节点，名字不能撞上子节点', () => {
    const result = checkPlan(
      planText(
        [
          storyboard,
          keyframes,
          { ...clips, over: 'in/keys/x.json' },
          film,
          { ...film, key: 'clips-01' },
        ],
        { 成片: 'clips' },
        [...edges, { from: 'clips', to: 'clips-01' }],
      ),
      sheet,
      catalog,
      tools,
    );
    const problems = (result as { problems: string[] }).problems.join('\n');
    expect(problems).toContain('不能由展开节点「clips」直接交出');
    expect(problems).toContain('不能来自展开节点「keys」');
    expect(problems).toContain('会和「clips」开出来的子节点撞名');
  });

  it('估价：预计条数 × 每条；做几版的每条乘版数再加一次挑选', () => {
    const result = checkPlan(planText([storyboard, keyframes, clips, film]), sheet, catalog, tools);
    const plan = (result as Extract<typeof result, { plan: unknown }>).plan;
    const { perNode } = estimatePlan(plan, [], tools, fallback);
    // 关键帧：4 条 ×（2 版 ×（生图 0.10 + 算力 0.01）+ 看图 0.002 + 算力 0.01）
    expect(perNode.get('keys')).toBe(4 * (2 * (100_000 + 10_000) + 2_000 + 10_000));
    // 视频：秒数写成模板，按默认 5 秒估
    expect(perNode.get('clips')).toBe(4 * (5 * 50_000 + 10_000));
  });
});

describe('挑一版：各版交给谁比较', () => {
  type Group = Parameters<typeof pickRequest>[0];
  const group = {
    title: '配乐',
    config: { variants: { n: 2, pick: '更像八音盒摇篮曲' } },
  } as unknown as Group;
  const versions = (path: string) =>
    [1, 2].map(
      (k) =>
        ({
          config: { version: { k }, outputsRunId: `run-${k}` },
          outputs: [{ path, size: 1 }],
        }) as unknown as Group,
    );

  it('音频：各版一起交给能听的型号（真实任务里曾落到只读文字的 AI，靠频谱图猜了 14 分钟）', () => {
    const pick = pickRequest(group, versions('bgm.mp3'), 'ai/text-only');
    expect(pick.model).not.toBe('ai/text-only');
    expect(pick.steps).toMatchObject([
      {
        tool: 'media.inspect',
        args: { files: ['in/v1/bgm.mp3', 'in/v2/bgm.mp3'] },
        out: 'out/pick.txt',
      },
    ]);
    expect(String(pick.steps?.[0]?.args.question)).toContain(
      '这几段音频依次是第 1 版、第 2 版，是同一步做的几个版本。挑选标准：更像八音盒摇篮曲。',
    );
  });

  it('视频：看的是缩小后的整段视频，不是第 1 秒的一帧', () => {
    const pick = pickRequest(group, versions('clip.mp4'), 'ai/text-only');
    expect(pick.steps).toMatchObject([
      {
        tool: 'op.media.convert',
        args: { in: 'in/v1/clip.mp4', width: '640' },
        out: 'out/preview-v1.mp4',
      },
      {
        tool: 'op.media.convert',
        args: { in: 'in/v2/clip.mp4', width: '640' },
        out: 'out/preview-v2.mp4',
      },
      {
        tool: 'media.inspect',
        args: { files: ['out/preview-v1.mp4', 'out/preview-v2.mp4'] },
        out: 'out/pick.txt',
      },
    ]);
  });

  it('文字、网页这类产出：还是由 AI 读完各版再比较', () => {
    const pick = pickRequest(group, versions('稿.md'), 'ai/text-only');
    expect(pick.steps).toBeUndefined();
    expect(pick.model).toBe('ai/text-only');
  });
});
