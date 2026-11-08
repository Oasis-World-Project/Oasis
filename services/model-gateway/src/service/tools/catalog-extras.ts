// 工具目录里不由网关调用的两类条目：text.batch（沙箱里的 oasis-tool 逐行调模型）和沙箱里的本地操作
// op.*（ADR 0025：oasis-op 用 ffmpeg 做，不调供应商、不花工具钱，只占沙箱算力）。
import type { ToolEntry } from '@oasis/contracts/model-gateway';
import { OPS } from '@oasis/contracts/ops';
import { MODEL_ARG } from './kit.ts';

export function textBatchEntry(available: boolean): ToolEntry {
  return {
    key: 'text.batch',
    name: '批量生成文字',
    description:
      '逐行生成文字，可用 --model 选择模型；uses 按输入行数估计，支持停止和恢复。预算/token/超时只在显式传入时生效，实际按 token 计费。',
    usage:
      'oasis-tool text.batch --in 提示.jsonl --out out/结果.jsonl（每行 {"id":"1","prompt":"要求"}；--resume true 恢复）',
    unit: '行',
    estimateMicro: 2_000,
    long: false,
    available,
    models: [],
    defaultModel: null,
    rates: [],
    args: [
      {
        name: 'in',
        kind: 'path',
        required: true,
        description: '每行 {"id":"1","prompt":"要求"} 的 JSONL',
      },
      { ...MODEL_ARG, description: '用哪个模型（工具节点里必须写）' },
      { name: 'budget_micro', kind: 'number', min: 1, description: '整批的花费上限（微美元）' },
      { name: 'row_budget_micro', kind: 'number', min: 1, description: '每行的花费上限（微美元）' },
      { name: 'max_tokens', kind: 'number', min: 1, description: '每行最多生成多少 token' },
      { name: 'concurrency', kind: 'number', min: 1, max: 16, description: '同时跑几行' },
      { name: 'timeout_ms', kind: 'number', min: 1, description: '每行最多等多久（毫秒）' },
      { name: 'resume', kind: 'flag', description: '中断后接着做' },
    ],
    local: false,
  };
}

/** op.* 一律可用：沙箱镜像里带着 ffmpeg 和 oasis-op */
export function localOpEntries(): ToolEntry[] {
  return OPS.map((op) => ({
    key: op.key,
    name: op.name,
    description: op.description,
    usage: `${op.usage}（也可以写 oasis-tool ${op.key} …）`,
    unit: '次',
    estimateMicro: 0,
    long: false,
    available: true,
    models: [],
    defaultModel: null,
    rates: [],
    args: op.args,
    local: true,
  }));
}
