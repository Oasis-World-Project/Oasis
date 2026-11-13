// 提出调整（ADR 0030 §3.7）：做成果的 AI 发现要动别的成果才做得好时提一次（要什么、为什么），
// task 让规划员答一次，答复写回这个长任务，沙箱里用 oasis-tool wait 取。
// 网关不调 task（服务调用只往一个方向走）：提交时发事件，答复由 task 调回来写。
import { AdjustmentRequested } from '@oasis/contracts/events';
import { ADJUST_TOOL } from '@oasis/contracts/model-gateway';
import { z } from 'zod';
import type { ToolDef } from './kit.ts';

const AdjustArgs = z.object({
  want: z.string().trim().min(1).max(2000),
  why: z.string().trim().min(1).max(2000),
});

export const adjust: ToolDef = {
  key: ADJUST_TOOL,
  name: '提出调整',
  description:
    '要动别的成果才做得好时（缺一样成果、别的成果的说明要改、有一样成果不用做了），向规划员提一次：要什么、为什么。规划员答一次（同意、改、不同意，附理由），同意的改动马上生效。自己这样成果里怎么做不用提。',
  usage:
    'oasis-tool workflow.adjust --want "要调整什么" --why "为什么"；会等一会儿规划员的答复，没等到就接着干活，过后按提示 oasis-tool wait <任务号> 取',
  unit: '次',
  estimateMicro: 0,
  // 平台自己答复，不花钱：冻结一个最小金额只为和别的工具走同一套记录，结算为 0、全数退回
  holdMicro: () => 1,
  long: true,
  provider: 'task',
  models: () => [],
  args: AdjustArgs,
  cli: [
    {
      name: 'want',
      kind: 'text',
      description: '要调整什么：加一样成果、改某样成果的说明、停掉某样成果',
    },
    { name: 'why', kind: 'text', description: '为什么要调整' },
  ],
  modelOf: () => '',
  async start(deps, args) {
    const request = AdjustArgs.parse(args);
    if (!deps.jobId || !deps.emit) throw new Error('提出调整要有任务号和事件通道');
    await deps.emit(AdjustmentRequested.type, {
      jobId: deps.jobId,
      taskId: deps.taskId,
      nodeId: deps.nodeId,
      runId: deps.runId,
      ...request,
    });
    return deps.jobId;
  },
  // 答复由 task 写进这个长任务的回执；还没写就是还在等规划员
  check: async (deps) => {
    const answer = (deps.receipt?.saved as { answer?: unknown } | undefined)?.answer;
    return typeof answer === 'string'
      ? {
          state: 'completed',
          outcome: { text: answer, files: [], cost: { costMicro: 0, source: 'provider' } },
        }
      : { state: 'pending' };
  },
  // 提出调整的那次运行结束了也照样等答复：改动是对整个工作流的，不跟着那次运行作废
  cancel: async () => undefined,
};
