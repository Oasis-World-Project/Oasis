// 工具节点的一步（ADR 0025）：task 的方案和节点配置、harness 的工具运行共用同一个格式。
import { z } from 'zod';
import { STEP_OUT } from './tool-args.ts';

export const ToolStep = z.object({
  /** 工具目录里的工具：外部工具如 image.generate，沙箱里的本地操作如 op.video.concat */
  tool: z
    .string()
    .regex(/^[a-z0-9]+(\.[a-z0-9_-]+)+$/, '工具名形如 image.generate、op.video.concat'),
  /**
   * 参数：和 `oasis-tool <工具> --名字 值` 一样（工具目录里每个工具都列了参数）；文件写沙箱里的路径：
   * 上游交来的在 in/<上游节点>/，用户素材在 materials/，前面步骤的结果在 out/。
   */
  args: z
    .record(
      z
        .string()
        .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/, '参数名只用字母、数字、下划线')
        .refine((name) => name !== 'out', '结果路径写在步骤的 out 里，不写在参数里')
        .refine((name) => name !== 'new', '工具步骤失败重试会接着原来的提交，不能强制重新提交'),
      z.unknown(),
    )
    .default({})
    .refine((args) => JSON.stringify(args).length <= 50_000, '参数太长（最多 5 万字）'),
  /** 结果存到哪（out/ 下的路径）；文字结果的工具（搜索、看图、转写）给了 out 就把结果文字存进去 */
  out: z.string().max(300).regex(STEP_OUT, '结果要存到 out/ 下，不能有 ..、反斜线和 *').optional(),
});
export type ToolStep = z.infer<typeof ToolStep>;

/** 一个工具节点最多几步：步骤多了就该拆成几个节点，让中间结果能单独查看、沿用 */
export const ToolSteps = z.array(ToolStep).min(1).max(12);
