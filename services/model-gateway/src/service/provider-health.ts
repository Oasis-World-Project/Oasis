// 哪个型号在哪家供应商那里丢内容。同一型号在 OpenRouter 上有好几家在跑，网关把同一段会话固定在一家
// （吃缓存），那一家要是不把内容交给模型，整轮都在空转：2026-11-26 Kimi K2.5 在 Amazon Bedrock 上丢工具结果，
// 一轮空转了 83 次调用。办法：每次调用拿发出去的字符数对着供应商报回的输入 token，少得不可能的记下来；
// 同一型号在同一家一段时间里出现两次，这段时间不再送它（实测有问题的直接写在 adapters/openrouter.ts 的 PROVIDERS_TO_AVOID）。
import type { Logger } from '@oasis/service-kit';
import type { CallsRepo } from '../repo/calls-repo.ts';
import { PROMPT_SHORTFALL, promptFellShort } from './pricing.ts';

/** 出现这么多次才避开：一次可能只是那份输入特别省 token */
const MIN_CALLS = 2;

export function createProviderHealth(deps: {
  repo: Pick<CallsRepo, 'promptShortfalls'>;
  logger: Logger;
  /** 往回看多久；过了这么久没再出现就重新送它（那家可能修好了） */
  windowMs?: number;
  /** 多久从调用记录里重新数一遍（别的服务实例见到的、重启前见到的从这里来） */
  refreshMs?: number;
  now?: () => number;
}) {
  const windowMs = deps.windowMs ?? 6 * 3600_000;
  const refreshMs = deps.refreshMs ?? 5 * 60_000;
  const now = deps.now ?? Date.now;
  /** 「型号 供应商」→ 次数：上次从调用记录里数的，加上之后这个实例自己见到的 */
  let counts = new Map<string, number>();
  let loadedAt: number | undefined;
  let loading: Promise<void> | undefined;
  const keyOf = (model: string, provider: string) => `${model}\n${provider}`;

  function reload(): Promise<void> {
    loading ??= deps.repo
      .promptShortfalls(new Date(now() - windowMs), PROMPT_SHORTFALL)
      .then((rows) => {
        counts = new Map(rows.map((row) => [keyOf(row.model, row.provider), row.calls]));
      })
      .catch((err: unknown) =>
        deps.logger.warn({ err }, '读不到各家供应商丢内容的记录，先用手上的'),
      )
      .finally(() => {
        loadedAt = now();
        loading = undefined;
      });
    return loading;
  }

  return {
    /** 这个型号眼下先不送的供应商（OpenRouter 回的名字） */
    async suspects(model: string): Promise<string[]> {
      if (loadedAt === undefined) await reload();
      else if (now() - loadedAt > refreshMs) void reload();
      const prefix = keyOf(model, '');
      return [...counts]
        .filter(([key, calls]) => calls >= MIN_CALLS && key.startsWith(prefix))
        .map(([key]) => key.slice(prefix.length));
    },

    /** 一次调用结束：这家报回的输入 token 对不对得上发出去的字符数 */
    observe(call: { model: string; provider: string; inputChars: number; promptTokens?: number }) {
      if (!promptFellShort(call.inputChars, call.promptTokens)) return;
      const key = keyOf(call.model, call.provider);
      const calls = (counts.get(key) ?? 0) + 1;
      counts.set(key, calls);
      deps.logger.warn(
        { ...call, calls, avoided: calls >= MIN_CALLS },
        '供应商报回的输入 token 少得不可能：有内容没送到模型',
      );
    },
  };
}

export type ProviderHealth = ReturnType<typeof createProviderHealth>;
