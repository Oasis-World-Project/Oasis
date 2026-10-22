// 节点出口的轻量关卡（ADR 0004 §2，参考 dsh 的门控设计：能用规则判断的用代码，需要语义判断时才问 Jev）。
// 1. 规则检查（不花钱）：out/ 里有产出；方案里写明的文件都在且不是空的。
// 2. 验收点检查（Jev，几乎不花钱）：每条验收点问一个「是否满足」，概率低于阈值算没满足。
// 检查本身出错（Jev 连不上等）就放行，不卡用户。
import { RunTextsBody, type RunOutputFile } from '@oasis/contracts/harness';
import { OASIS_HEADERS } from '@oasis/contracts/common';
import type { Logger, ServiceClient } from '@oasis/service-kit';
import { z } from 'zod';

export interface GateResult {
  /** 没满足的地方（普通话，会原样交给节点去改、也会作为提醒给用户看）；为空表示通过 */
  unmet: string[];
}

/** 简单通配：* 匹配一段路径里的任意字符 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

/** 规则检查 */
export function checkRules(outputs: RunOutputFile[], expects: string[]): string[] {
  if (outputs.length === 0) return ['out/ 里没有任何产出文件'];
  const unmet: string[] = [];
  for (const pattern of expects) {
    const re = globToRegExp(pattern);
    const matched = outputs.filter((f) => re.test(f.path));
    if (matched.length === 0) unmet.push(`缺少文件 out/${pattern}`);
    else if (matched.every((f) => f.size === 0)) unmet.push(`文件 out/${pattern} 是空的`);
  }
  return unmet;
}

const DecisionAnswers = z.object({
  answers: z.record(z.string(), z.object({ noul: z.number().optional() }).loose()),
});

export function createGate(deps: {
  harness: ServiceClient;
  modelGateway: ServiceClient;
  /** 判断验收点用的决策模型，如 typesafe/jev-1.14 */
  model: string;
  /** 「满足」的概率低于这个值就算没满足 */
  threshold: number;
  logger: Logger;
}) {
  const { harness, modelGateway, logger } = deps;

  /** 验收点检查：把节点要做的事、最后一句话和文字产出交给 Jev，每条验收点一个问题 */
  async function checkPoints(input: {
    payerId: string;
    taskId: string;
    nodeId: string;
    runId: string;
    goal: string;
    summary: string | null;
    outputs: RunOutputFile[];
    checks: string[];
  }): Promise<string[]> {
    const texts = await harness.json('GET', `/internal/runs/${input.runId}/texts?maxChars=8000`, {
      schema: RunTextsBody,
    });
    const state = [
      `节点要做的事：${input.goal}`,
      `它交付时说：${input.summary ?? '（没说）'}`,
      `产出文件：${input.outputs.map((f) => f.path).join('、')}`,
      ...texts.files.map((f) => `文件 ${f.path} 的内容：\n${f.text}`),
    ];
    const questions = Object.fromEntries(
      input.checks.map((check, i) => [
        `c${i}`,
        {
          type: 'noul',
          instructions: `这份产出是否满足这条要求：${check}`,
          criteria: { true: '满足这条要求', false: '不满足，或者从产出里看不出满足' },
        },
      ]),
    );
    const { answers } = await modelGateway.json('POST', '/internal/v1/decisions', {
      body: { model: deps.model, state, questions },
      // 花费记在付费人账上，并计入这个任务和节点
      headers: {
        [OASIS_HEADERS.payerId]: input.payerId,
        [OASIS_HEADERS.taskId]: input.taskId,
        [OASIS_HEADERS.nodeId]: input.nodeId,
      },
      schema: DecisionAnswers,
    });
    return input.checks.filter((_, i) => (answers[`c${i}`]?.noul ?? 1) < deps.threshold);
  }

  return {
    async check(input: {
      payerId: string;
      taskId: string;
      nodeId: string;
      runId: string;
      goal: string;
      summary: string | null;
      outputs: RunOutputFile[];
      checks: string[];
      expects: string[];
    }): Promise<GateResult> {
      const unmet = checkRules(input.outputs, input.expects);
      // 规则没过就不用再问 Jev 了（连产出都没有，验收点无从谈起）
      if (unmet.length > 0 || input.checks.length === 0) return { unmet };
      try {
        return { unmet: await checkPoints(input) };
      } catch (err) {
        logger.warn({ err, runId: input.runId }, '验收点检查出错，放行');
        return { unmet: [] };
      }
    },
  };
}

export type Gate = ReturnType<typeof createGate>;
