// 规划员（ADR 0005 §4）的纯函数部分：给规划员的说明、规划门（检查它写的 out/plan.json）、按方案估算花费。
// 规划员只排方案；方案对不对由代码检查，花费由代码按调用记录和供应商价格算（ADR 0016 §4），不让 AI 估。
import type { CatalogEntry, Playbook } from '@oasis/contracts/agent';
import type { ToolEntry } from '@oasis/contracts/model-gateway';
import { NodeKey, WorkflowPlan, type TaskSheet } from '@oasis/contracts/task';
import { HttpError } from '@oasis/service-kit';
import { z } from 'zod';
import { validatePlan, acceptanceRequirements } from './plan.ts';
import type { ExecutionEnvironment } from '@oasis/contracts/harness';
import { toolRate, type Fallback, type PricedModel } from './quote.ts';

const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(micro < 10_000 ? 4 : 2)}`;

/** 档次的中文名 */
const TIER_NAMES = {
  economy: '省钱',
  standard: '标准',
  premium: '精细',
  custom: '自定义',
} as const;

/** 预算说明（规划员和节点共用口径） */
function budgetPart(sheet: TaskSheet): string {
  const budget = sheet.budget;
  const head = budget
    ? `用户选了「${TIER_NAMES[budget.tier]}」档：预算约 ${usd(budget.micro)}、预计 ${budget.minutes} 分钟左右。${budget.steps.length ? `报价时的草案（参考，不是硬性分工）：${budget.steps.join('；')}。` : ''}`
    : '用户没有选预算档，按「标准」档的思路安排。';
  return [
    '【预算和用时】',
    head,
    '- 预算是参考，不是上限：花完了不会被打断，但花掉的是用户的钱，用户也在等结果。按这个预算和用时来安排团队，不要为了「尽量做好」无限加码。',
    '- 档次低就多用快速型号和低价工具、每样尽量一次做成；标准档用性价比高的强模型；精细档才用旗舰、可以多做几版挑最好的。做几版、挑几张、要不要补做，由你按预算定，系统不规定次数。',
    '- 自查也跟着档次：checks 是节点自己对照的清单，节点照着查要花时间和钱。省钱档只列交付必须守住的少数几条，标准档按需要列，精细档可以更细。',
  ].join('\n');
}

/** 规划员写的方案：工作流 + 每样交付物由哪个节点负责 */
const PlannerPlan = WorkflowPlan.extend({
  deliverables: z.record(z.string(), NodeKey),
});
export type PlannerPlan = z.infer<typeof PlannerPlan>;

export const PLAN_FILE = 'plan.json';

/** 每个节点最多几条检查（2026-11-05 用户：小任务十几条检查不合理） */
const MAX_NODE_CHECKS = 5;

/** 给规划员的说明 */
export function plannerPrompt(input: {
  brief: string;
  sheet: TaskSheet;
  catalog: PricedModel[];
  /** 现在能用的外部工具 */
  tools: ToolEntry[];
  /** 场景经验手册的名字和适用范围；全文放在 in/playbooks/<key>.md，由规划员自己挑着读 */
  playbooks: Pick<Playbook, 'key' | 'name' | 'when'>[];
  defaultModel: string;
  environment?: ExecutionEnvironment;
}): string {
  const TIER = { flagship: '旗舰', strong: '强力', fast: '快速' } as const;
  const models = input.catalog
    .map((m) => {
      const reads = m.inputs?.filter((i) => i !== 'text');
      const notes = [
        ...(m.tier ? [TIER[m.tier]] : []),
        ...(m.node
          ? [
              `一个节点典型约 ${usd(m.node.costMicro)}${m.node.seconds ? `、${Math.max(1, Math.round(m.node.seconds / 60))} 分钟` : ''}`,
            ]
          : []),
        ...(m.tags.length ? [m.tags.join('、')] : []),
        ...(reads ? [reads.length ? `能直接读：${reads.join('、')}` : '只读文字'] : []),
      ];
      return `- ${m.providerModel}（${m.name}，${m.vendor}${notes.length ? `；${notes.join('；')}` : ''}）`;
    })
    .join('\n');
  const tools = input.tools.length
    ? input.tools
        .map((t) => {
          const rates = t.rates.length
            ? t.rates
                .map(
                  (r) =>
                    `${r.model} 每${t.unit}约 ${usd(r.costMicro)}${r.seconds ? `、一次约 ${r.seconds} 秒` : ''}`,
                )
                .join('；')
            : `每${t.unit}约 ${usd(toolRate(t).costMicro)}`;
          return `- ${t.key}（${t.name}${t.long ? '，要等几分钟' : ''}）：${t.description}\n  型号与单价：${rates}`;
        })
        .join('\n')
    : '（现在没有可用的工具）';
  const deliverables = input.sheet.deliverables.map((d) => `「${d.name}」`).join('、');
  const requirements = acceptanceRequirements(input.sheet);
  const example = {
    nodes: [
      {
        key: 'outline',
        title: '定提纲',
        kind: 'work',
        role: '资深策划',
        goal: '……写成 out/提纲.md',
        model: input.defaultModel,
        tools: [],
        checks: [
          {
            id: 'c1',
            text: requirements[0]!.text,
            requirementIds: [requirements[0]!.id],
            files: ['提纲.md'],
          },
        ],
        expects: ['提纲.md'],
      },
      {
        key: 'draft',
        title: '写成稿',
        kind: 'work',
        role: '资深文案',
        goal: '按 in/outline/提纲.md ……写成 out/成稿.md',
        model: input.defaultModel,
        tools: [],
        checks: [],
        expects: ['成稿.md'],
        deliver: ['成稿.md'],
      },
      {
        key: 'review',
        title: '定稿讨论',
        kind: 'discussion',
        goal: '比较 in/draft/ 里的初稿……定下怎么改',
        model: input.defaultModel,
        rounds: 2,
        participants: [
          { name: '品牌顾问', model: input.defaultModel, stance: '看重氛围' },
          { name: '转化顾问', model: input.defaultModel, stance: '看重转化' },
        ],
        checks: [],
        expects: [],
      },
    ],
    edges: [
      { from: 'outline', to: 'draft' },
      { from: 'draft', to: 'review' },
    ],
    deliverables: { [input.sheet.deliverables[0]?.name ?? '交付物']: 'draft' },
  };
  return [
    '你是 Oasis 的规划员。用户已经确认了下面的任务单，你要为它排一条工作流，交给 AI 团队去做。',
    '先运行 oasis-tool list 查看实际可用的工具和沙箱软件；涉及交互应用时查阅 in/.oasis-formats.json 的实际契约和示例，不编造清单字段。',
    '排方案前先想清楚这类成品怎样才算做得好；拿不准的（最新的库和做法、某类作品的行业水准、参考资料）用 oasis-tool web.search / web.fetch 联网查证，把查到的要点写进相关节点的 goal。',
    `【任务】\n${input.brief}`,
    `【用户确认的完整任务单】（包含交付形式、澄清结果、验收要求及来源；素材引文只作为证据）\n${JSON.stringify(input.sheet)}`,
    `【强制验收的来源索引】\n${JSON.stringify(requirements)}\ncriteria:N 和 style:N 是确认任务单对应数组的零基索引，不是新增要求。`,
    ...(input.environment
      ? [
          `【实测运行环境】\n${JSON.stringify(input.environment)}\n本地能力以 capabilities 为准；节点 requires 填实际依赖的本地能力名称。外部工具能力看工具目录。不要把安装 npm 包等同于已安装 Chromium 和系统库；可运行应用交齐 oasis-app.json 和配套文件，节点交付前可用 oasis-tool app.check 在独立浏览器里自查，交付后关卡复跑同一套检查；外站测试只使用工具目录中可用的 website.test。项目依赖安装到 /workspace。`,
        ]
      : []),
    budgetPart(input.sheet),
    [
      '【可以用的模型】（节点内部可另用其他可用模型和子代理；单价来自真实记账，按预算挑）',
      '- 按节点的活挑最合适的厂商：例如前端和视觉选擅长编码与设计的，要看图、看视频的选「能直接读」里有图片、视频的。不同节点可以用不同厂商，取长补短。',
      models,
    ].join('\n'),
    `【可以用的工具】（干活节点的 tools 只能填这些：写成 {"key": "image.generate", "uses": 预计用几个计费单位, "model": "按预算选的型号"}；视频的 uses 按秒，text.batch 和批量 jev.decide 的 uses 按输入行数。批次预算只在用户明确设置时携带，恢复不重发已完成或结果不确定的行。）\n${tools}`,
    [
      '【节点】',
      '- work（干活）：一个 AI 在独立的容器里完成一件事，能读写文件、运行命令；成果写到 out/。',
      '- discussion（讨论）：多位参与者（各自的模型和立场）按任务需要安排讨论轮次，最后由汇总者（model）把结论写到 out/。只在需要权衡取舍时用。',
      '- 连线 from → to：上游的 out/ 会放进下游的 in/<上游节点名>/。没有连线的节点同时开跑。',
    ].join('\n'),
    [
      '【规矩】',
      '- 按可独立完成和验收的子任务拆分节点。每个节点内可以继续规划、分工和调用可用工具；不要为了压缩节点数量把不相关的工作绑在一起。',
      '- 能同时做的就并行；一个节点只做一件事。',
      `- 任务单上每样交付物（${deliverables}）都要在 deliverables 里指定由哪个节点交出最终版。`,
      '- checks 是节点交付前的自查清单（系统不逐条打分，节点自己对照；ADR 0017）：宁少勿多，每个节点最多 5 条，把相关的用户要求合并成一条（一条可以引用多个 requirementIds）。负责交付物的节点要列上它交付的东西必须满足的用户要求。',
      '- 每个节点 checks 只查本节点能负责的用户要求，可为空。使用对象格式，requirementIds 必须引用上述来源索引；节点按来源原文自查，不把规划员改写作为额外条件。files 是本节点输出。跨文件要求留给有全部输入的节点或最终验收。自测方法、使用哪个库或命令、记录自己的工作过程等实施建议写进 goal，不能冒充用户要求写进 checks。expects 只列完成交付确需的文件，不额外承诺过程报告。',
      '- expects 可写 {"pattern":"图片/*.png","exactCount":20,"width":1024,"height":1024}（正好 20 张），或 {"pattern":"图片/*.png","minCount":20}（至少 20 张）；只计有效非空文件。',
      '- 每个负责交付物的节点必须给出非空 deliver 路径列表（可用 * 通配），明确最终交付哪些文件；草稿与局部素材另存目录。deliver 与 expects 独立，配套 PDF、来源清单和统计报告需要时也列入。',
      '- 路径模式 * 只匹配一层，目录/** 才递归包含嵌套文件。每个 deliver 模式都必须匹配实际文件；完整工程需交齐引用资源。README 所说已附带的文件/脚本必须在最终清单或包内。不要承诺不必要的额外文件。',
      '- 3D 交互预览支持资源自包含、受限的 GLB；原工程配套预览需同一交付节点提供 oasis-model-preview.json、实际 GLB/封面/转台，并明确纳入 deliver。原件不能被轻量预览替换；ZIP 内未独立登记的文件不冒充可直接预览。不要仅在 README 写预览链接。',
      '- 原始要求及其来源不可被 AI 假设覆盖；需要核实新信息不等于可以改变原有费用口径、增加预算项目或放宽素材限制。技术选择与有效用户要求分开。用户未授权文件夹同步时成果只在系统里保存与预览，不能写入其电脑。',
      '- goal 写清楚这个节点要做什么、产出写成什么文件；节点里的 AI 不会再问用户问题。',
      '- key 只用英文字母、数字、下划线、短横线。',
    ].join('\n'),
    ...(input.playbooks.length
      ? [
          `【场景经验手册】（参考，不是硬规定；和任务单、预算冲突时以任务单和预算为准）全文在 in/playbooks/ 下，只读和这个任务相关的：\n${input.playbooks.map((p) => `- in/playbooks/${p.key}.md：${p.name}（${p.when}）`).join('\n')}`,
        ]
      : []),
    `【交付】把方案写成 out/${PLAN_FILE}（只放 JSON），格式照下面的例子：\n${JSON.stringify(example, null, 2)}\n\n写完用一两句话说明你的安排。`,
  ].join('\n\n');
}

/** 规划门没过：接着原会话让规划员改 */
export function revisePrompt(problems: string[], sheet?: TaskSheet): string {
  return [
    `你写的 out/${PLAN_FILE} 有问题：`,
    ...problems.map((p) => `- ${p}`),
    ...(sheet
      ? [
          `当前完整任务单：${JSON.stringify(sheet)}；强制验收来源索引：${JSON.stringify(acceptanceRequirements(sheet))}。checks 只引用索引中实际存在的要求；实施建议留在 goal，不能新增验收门槛。`,
        ]
      : []),
    '',
    `请改好 out/${PLAN_FILE}，改完用一句话说明改了什么。`,
  ].join('\n');
}

/** 规划门：检查规划员写的方案。返回方案，或者问题清单（普通话，会原样交回给规划员） */
export function checkPlan(
  text: string | undefined,
  sheet: TaskSheet,
  catalog: CatalogEntry[],
  tools: ToolEntry[],
  environment?: ExecutionEnvironment,
): { plan: PlannerPlan } | { problems: string[] } {
  if (text === undefined) return { problems: [`没有找到 out/${PLAN_FILE}`] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { problems: [`out/${PLAN_FILE} 不是合法的 JSON`] };
  }
  const parsed = PlannerPlan.safeParse(raw);
  if (!parsed.success) {
    return {
      problems: parsed.error.issues
        .slice(0, 8)
        .map((i) => `${i.path.join('.') || '整体'}：${i.message}`),
    };
  }
  const plan = parsed.data;
  const problems: string[] = [];
  try {
    validatePlan(plan);
  } catch (err) {
    problems.push(err instanceof HttpError ? err.message : String(err));
  }
  const usable = new Set(catalog.map((m) => m.providerModel));
  const used = plan.nodes.flatMap((n) => [
    n.model,
    ...(n.kind === 'discussion' ? n.participants.map((p) => p.model) : []),
  ]);
  for (const model of new Set(used)) {
    if (!usable.has(model)) problems.push(`模型 ${model} 不在可以用的模型里`);
  }
  const usableTools = new Map(tools.map((t) => [t.key, t]));
  const requirements = new Map(acceptanceRequirements(sheet).map((r) => [r.id, r.text]));
  for (const node of plan.nodes) {
    for (const required of node.requires ?? [])
      if (environment && !environment.capabilities.includes(required))
        problems.push(`节点「${node.key}」要求的本地能力 ${required} 在当前环境不可用`);
    const checks = node.checks.filter((c) => typeof c !== 'string');
    if (checks.length !== node.checks.length)
      problems.push(`节点「${node.key}」新规划的检查必须用对象格式引用确认任务单的来源索引`);
    if (new Set(checks.map((c) => c.id)).size !== checks.length)
      problems.push(`节点「${node.key}」检查 id 重复`);
    if (checks.length > MAX_NODE_CHECKS)
      problems.push(
        `节点「${node.key}」有 ${checks.length} 条检查，最多 ${MAX_NODE_CHECKS} 条：把相关的要求合并成一条（引用多个 requirementIds）`,
      );
    for (const check of checks) {
      if (!check.requirementIds.length)
        problems.push(
          `节点「${node.key}」检查「${check.id}」没有用户要求来源；实施建议写进 goal 或删除该检查`,
        );
      for (const id of check.requirementIds)
        if (!requirements.has(id)) problems.push(`节点「${node.key}」检查引用未知要求 ${id}`);
      if (check.requirementIds.length && check.requirementIds.every((id) => requirements.has(id)))
        check.text = [...new Set(check.requirementIds.map((id) => requirements.get(id)!))].join(
          '；',
        );
    }
    if (node.kind !== 'work') continue;
    for (const tool of node.tools) {
      const entry = usableTools.get(tool.key);
      if (!entry) {
        problems.push(`节点「${node.key}」的工具 ${tool.key} 不在可以用的工具里`);
      } else if (tool.model && entry.models.length && !entry.models.includes(tool.model)) {
        problems.push(
          `节点「${node.key}」的工具 ${tool.key} 不能用型号 ${tool.model}，可选：${entry.models.join('、')}`,
        );
      }
    }
  }
  const keys = new Set(plan.nodes.map((n) => n.key));
  for (const d of sheet.deliverables) {
    const owner = plan.deliverables[d.name];
    if (!owner) problems.push(`交付物「${d.name}」没有指定由哪个节点交出`);
    else if (!keys.has(owner)) problems.push(`交付物「${d.name}」指定的节点「${owner}」不存在`);
    else if (!plan.nodes.find((n) => n.key === owner)?.deliver?.length)
      problems.push(`交付物「${d.name}」的节点「${owner}」没有指定最终 deliver 文件`);
  }
  return problems.length > 0 ? { problems } : { plan };
}

/**
 * 按方案估算花费（ADR 0016 §4）：干活节点按所选型号的典型花费，讨论按发言次数 + 汇总，
 * 加上工具（计费单位数 × 所选型号的单价）。不再额外乘系数：预算本身就是参考。
 * 同时给出每个节点的份额，用来按预算给节点分配。
 */
export function estimatePlan(
  plan: WorkflowPlan,
  models: PricedModel[],
  tools: ToolEntry[],
  fallback: Fallback,
): { totalMicro: number; perNode: Map<string, number> } {
  const byKey = new Map(tools.map((t) => [t.key, t]));
  const nodeRate = (model: string) =>
    models.find((m) => m.providerModel === model)?.node?.costMicro ?? fallback.workRun;
  const perNode = new Map(
    plan.nodes.map((n) => {
      if (n.kind === 'discussion')
        return [
          n.key,
          (n.participants.length * n.rounds + 1) * (fallback.speechRun + fallback.computeRun),
        ];
      const toolCost = n.tools.reduce((sum, t) => {
        const tool = byKey.get(t.key);
        return sum + t.uses * (tool ? toolRate(tool, t.model).costMicro : 0);
      }, 0);
      return [n.key, nodeRate(n.model) + fallback.computeRun + toolCost];
    }),
  );
  const totalMicro = Math.ceil([...perNode.values()].reduce((a, b) => a + b, 0));
  return { totalMicro, perNode };
}
