// canvas 的接口：用户上传的素材（ADR 0007 §3）。5.5c 再加成果登记。
import { z } from 'zod';

/** 文件名：不能带路径、控制字符，也不能是 . 或 .. */
export const FileName = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    // eslint-disable-next-line no-control-regex
    (name) => !/[/\\\u0000-\u001f]/.test(name) && name !== '.' && name !== '..',
    '文件名不能包含路径或控制字符',
  );

/** POST /v1/uploads?name=…：请求体就是文件本身 */
export const UploadQuery = z.object({ name: FileName });

export const UploadBody = z.object({
  id: z.uuid(),
  name: z.string(),
  size: z.number().int().nonnegative(),
  contentType: z.string(),
  createdAt: z.iso.datetime(),
});
export type UploadBody = z.infer<typeof UploadBody>;

/** 内部：按 id 查文件，并核对是不是这个人的（conversation 收附件时用） */
export const UploadLookupBody = z.object({
  ownerId: z.uuid(),
  ids: z.array(z.uuid()).min(1).max(20),
});
export const UploadLookupResult = z.object({ uploads: z.array(UploadBody) });

/** 交给工作流的素材：任务上记着，规划员和每个节点运行时放进沙箱的 materials/ 下 */
export const Material = z.object({
  uploadId: z.uuid(),
  name: z.string(),
  size: z.number().int().nonnegative(),
});
export type Material = z.infer<typeof Material>;

/** 成果的类别（照原型 ⑧），由 canvas 按扩展名定 */
export const ArtifactCategory = z.enum(['doc', 'media', 'threed', 'app', 'data']);
export type ArtifactCategory = z.infer<typeof ArtifactCategory>;

/**
 * 画布里的一个成果（ADR 0007 §8）：任务完成时，负责交付物的节点交出的一个文件，复制进画布。
 */
export const ArtifactBody = z.object({
  id: z.uuid(),
  /** 文件名（不含目录） */
  name: z.string(),
  /** 节点产出里的相对路径，如 site/index.html */
  path: z.string(),
  size: z.number().int().nonnegative(),
  contentType: z.string(),
  category: ArtifactCategory,
  /** 属于任务单里的哪样交付物 */
  deliverable: z.string(),
  taskId: z.uuid(),
  /** 新成果带节点来源；历史响应可省略 */
  nodeId: z.string().optional(),
  taskTitle: z.string(),
  /** 任务是在哪个私聊里交代的（回到私聊用）；没有为 null */
  conversationId: z.uuid().nullable(),
  /** 做它的模型（供应商型号；讨论节点是每位参与者和写结论的） */
  models: z.array(z.string()),
  /** 同步到电脑时放在哪：相对同步文件夹的路径，如 小木屋民宿官网首页/首页文案.md */
  syncPath: z.string(),
  createdAt: z.iso.datetime(),
});
export type ArtifactBody = z.infer<typeof ArtifactBody>;

export const ArtifactList = z.object({ artifacts: z.array(ArtifactBody) });

/** 列表筛选：类别、某个任务 */
export const ArtifactQuery = z.object({
  category: ArtifactCategory.optional(),
  taskId: z.uuid().optional(),
});

const PreviewCell = z.union([z.string().max(20_000), z.number().finite(), z.boolean(), z.null()]);
export const FilePreviewBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('html'), html: z.string().max(2 * 1024 * 1024) }),
  z.object({
    kind: z.literal('table'),
    sheets: z
      .array(
        z.object({
          name: z.string().max(200),
          rows: z.array(z.array(PreviewCell).max(100)).max(1000),
          truncated: z.boolean(),
        }),
      )
      .max(20),
    warning: z.string().optional(),
  }),
]);
export type FilePreviewBody = z.infer<typeof FilePreviewBody>;

/** 单文件看板的数据契约；不接受 ECharts 配置或可执行表达式。 */
export const DashboardData = z.object({
  title: z.string().max(200),
  charts: z
    .array(
      z
        .object({
          title: z.string().max(200),
          type: z.enum(['bar', 'line', 'pie']),
          labels: z.array(z.string().max(200)).min(1).max(200),
          series: z
            .array(
              z.object({
                name: z.string().max(200),
                values: z.array(z.number().finite()).min(1).max(200),
              }),
            )
            .min(1)
            .max(10),
        })
        .refine(
          (c) => c.series.every((s) => s.values.length === c.labels.length),
          '图表数据长度不一致',
        ),
    )
    .min(1)
    .max(20),
});
export type DashboardData = z.infer<typeof DashboardData>;
