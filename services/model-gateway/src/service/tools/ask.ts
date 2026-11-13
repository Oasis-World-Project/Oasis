// 问另一个模型（ADR 0030 §3.5）：做成果的 AI 把一个问题和要看的材料交给另一个型号，拿回文字。
// 过程还握在做成果的 AI 手里：另一个型号只答这一次，看不到它的会话。
import { HttpError } from '@oasis/service-kit';
import { z } from 'zod';
import {
  clip,
  estimate,
  MODEL_ARG,
  optionalModel,
  pickModel,
  provider,
  type ToolDef,
} from './kit.ts';

const AskArgs = z.object({
  question: z.string().trim().min(1).max(8000),
  /** 要它看的材料（文字） */
  context: z.string().max(200_000).optional(),
  model: optionalModel,
});

/** 拿不到实际花费时一次按这么多估（微美元） */
const FALLBACK_MICRO = 20_000;

export const ask: ToolDef = {
  key: 'model.ask',
  name: '问另一个模型',
  description:
    '把一个问题和要看的材料（文字）交给另一个型号，拿回它的回答：要第二种意见、换个型号再查一遍、或交给它一小件事。它只答这一次，看不到你的会话。图片、视频、音频用 media.inspect。',
  usage:
    'oasis-tool model.ask --question "问题" [--context "$(cat 材料.md)"] [--model 型号]；回答打印出来，要留着就重定向到文件',
  unit: '次',
  estimateMicro: FALLBACK_MICRO,
  holdMicro: (args) => 200_000 + String(args.context ?? '').length * 2,
  long: false,
  provider: 'openrouter',
  models: (config) => config.askModels,
  speedNote: true,
  args: AskArgs,
  cli: [
    { name: 'question', kind: 'text', description: '要问的问题' },
    {
      name: 'context',
      kind: 'text',
      description: '要它看的材料（文字；文件用 "$(cat 文件)" 带进来）',
    },
    MODEL_ARG,
  ],
  modelOf: pickModel,
  async run(deps, args, model) {
    const a = AskArgs.parse(args);
    const response = await deps.upstream(() =>
      deps.openrouter.chatCompletions(
        {
          model,
          stream: false,
          // 推理型号的思考也占这个额度
          max_tokens: 8000,
          usage: { include: true },
          messages: [
            {
              role: 'user',
              content: `${a.context ? `材料：\n${a.context}\n\n` : ''}${a.question}`,
            },
          ],
        },
        deps.signal,
      ),
    );
    const body = z
      .object({
        choices: z
          .array(z.object({ message: z.object({ content: z.string().nullable() }) }))
          .min(1),
        usage: z.object({ cost: z.number().nonnegative().optional() }).optional(),
      })
      .parse(await response.json());
    const text = body.choices[0]!.message.content?.trim();
    if (!text) throw new HttpError(502, 'empty_answer', `${model} 没有给出回答`);
    return {
      text: clip(text),
      files: [],
      cost: body.usage?.cost !== undefined ? provider(body.usage.cost) : estimate(FALLBACK_MICRO),
    };
  },
};
