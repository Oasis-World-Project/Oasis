// 快速判断：让 Jev 对材料做结构化判断并给出概率。
import { z } from 'zod';
import { estimate, provider, type ToolDef } from './kit.ts';

const DecideArgs = z.object({
  question: z.string().trim().min(1).max(1000),
  /** 选一个：给出选项 */
  options: z.array(z.string().trim().min(1).max(200)).min(2).max(10).optional(),
  /** 打分：从低到高的刻度 */
  scale: z.array(z.string().trim().min(1).max(200)).min(2).max(10).optional(),
  /** 要判断的材料 */
  context: z.string().max(20_000).optional(),
});

const DecisionResponse = z.looseObject({
  answers: z.record(z.string(), z.looseObject({})),
  usage: z.looseObject({ cost: z.number().optional() }).optional(),
});

export const decide: ToolDef = {
  key: 'jev.decide',
  name: '快速判断',
  description:
    '让 Jev 对材料做一个结构化判断并给出概率：是否满足某条件、从几个选项里选一个、或按刻度打分。几乎不花钱，适合挑最好的版本、检查是否达标。',
  usage:
    'oasis-tool jev.decide --question "哪个标题更好" --options "标题A,标题B" [--context "材料"]（或 --scale "差,一般,好"）；批量：--in 问题.jsonl --out out/评分.jsonl --budget_micro 1000000，每行 {id,question,context?,scale?}，uses 按行数计；--resume true 恢复',
  unit: '次',
  estimateMicro: 100,
  holdMicro: (args) => 2_000 + String(args.context ?? '').length,
  long: false,
  provider: 'openrouter',
  models: (config) => [config.jevModel],
  args: DecideArgs,
  cli: [
    { name: 'question', kind: 'text', description: '要判断的问题（批量时用 in）' },
    { name: 'options', kind: 'list', min: 2, max: 10, description: '从这几个里选一个' },
    { name: 'scale', kind: 'list', min: 2, max: 10, description: '按这个刻度打分（从低到高）' },
    { name: 'context', kind: 'text', description: '要判断的材料' },
    {
      name: 'in',
      kind: 'path',
      description: '批量：每行 {id,question,context?,options?,scale?} 的 JSONL，结果写到 out',
    },
    { name: 'budget_micro', kind: 'number', min: 1, description: '批量的花费上限（微美元）' },
    { name: 'resume', kind: 'flag', description: '批量中断后接着做' },
  ],
  modelOf: (_args, models) => models[0] ?? '',
  async run(deps, args, model) {
    const a = DecideArgs.parse(args);
    const question = a.options
      ? {
          type: 'choice',
          instructions: a.question,
          criteria: Object.fromEntries(a.options.map((o) => [o, o])),
        }
      : a.scale
        ? { type: 'score', instructions: a.question, criteria: a.scale }
        : {
            type: 'noul',
            instructions: a.question,
            criteria: { true: '是', false: '不是' },
          };
    const response = await deps.upstream(() =>
      deps.openrouter.decisions(
        { model, state: [a.context ?? a.question], questions: { q: question } },
        deps.signal,
      ),
    );
    const body = DecisionResponse.parse(await response.json());
    const answer = body.answers.q ?? {};
    return {
      text: JSON.stringify(answer),
      data: answer,
      files: [],
      cost: typeof body.usage?.cost === 'number' ? provider(body.usage.cost) : estimate(100),
    };
  },
};
