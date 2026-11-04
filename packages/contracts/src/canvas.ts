// canvas 的接口：用户上传的素材（ADR 0007 §3）。5.5c 再加成果登记。
import { AvatarSpec } from './avatar.ts';
import { z } from 'zod';
import { ModelPreviewHint } from './model-preview.ts';

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
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable()
    .optional(),
  createdAt: z.iso.datetime(),
});
export type UploadBody = z.infer<typeof UploadBody>;

/** 内部：按 id 查文件，并核对是不是这个人的（conversation 收附件时用） */
export const UploadLookupBody = z.object({
  ownerId: z.uuid(),
  ids: z.array(z.uuid()).min(1).max(20),
  /** 只返回还在的，不因为少了某个就报错（ADR 0012：筛掉已随上一版删除的修订素材） */
  partial: z.boolean().default(false),
  /** 随消息发出：记下文件被用上了，清扫不再删它（2026-11-05 真删除） */
  claim: z.boolean().default(false),
});
/** 内部：彻底删除这个人的这些文件（消息被删、群被解散时） */
export const UploadDeleteBody = z.object({
  ownerId: z.uuid(),
  ids: z.array(z.uuid()).min(1).max(1000),
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

/** out/<root>/oasis-app.json：只描述可运行文件，不允许产物指定命令或权限。 */
const AppPath = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (value) =>
      value.split('/').every(
        (part) =>
          // Windows 同步路径和容器路径都必须安全；不接受隐式路径与 URL。
          /^[\p{L}\p{N}_.-]+$/u.test(part) && !part.startsWith('.'),
      ),
    '应用路径不安全',
  );
export const ApplicationSpec = z
  .object({
    version: z.literal(1),
    kind: z.enum(['static', 'node']),
    root: AppPath,
    entry: AppPath,
  })
  .refine(
    (spec) =>
      spec.kind === 'static' ? /\.html?$/i.test(spec.entry) : /\.[cm]?js$/i.test(spec.entry),
    '应用入口类型不匹配',
  );
export type ApplicationSpec = z.infer<typeof ApplicationSpec>;
export const ApplicationBundle = z.object({
  spec: ApplicationSpec,
  files: z
    .array(z.object({ path: AppPath, contentBase64: z.string() }))
    .min(2)
    .max(1000),
});
export type ApplicationBundle = z.infer<typeof ApplicationBundle>;

/** 批注坐标：相对画面（图片、PDF 页、视频帧）的 0–1 */
const Unit = z.number().min(0).max(1);
export const AnnotationShape = z.discriminatedUnion('kind', [
  /** 编号点 */
  z.object({ kind: z.literal('pin'), x: Unit, y: Unit }),
  /** 圈：左上角和宽高 */
  z.object({ kind: z.literal('ellipse'), x: Unit, y: Unit, w: Unit, h: Unit }),
  /** 画笔 */
  z.object({
    kind: z.literal('pen'),
    points: z
      .array(z.tuple([Unit, Unit]))
      .min(2)
      .max(400),
  }),
]);
export type AnnotationShape = z.infer<typeof AnnotationShape>;

/** 成果上的一条批注（ADR 0012 §9）：编号、意见，以及在哪（第几页、几秒、引用的原文、画的形状） */
export const Annotation = z.object({
  id: z.uuid(),
  number: z.number().int().min(1).max(99),
  note: z.string().trim().min(1).max(500),
  /** PDF / PPT 的第几页（从 1 开始） */
  page: z.number().int().min(1).max(10_000).nullable(),
  /** 音视频的第几秒 */
  time: z.number().min(0).max(86_400).nullable(),
  /** 文档里引用的原文 */
  quote: z.string().trim().max(300).nullable(),
  shape: AnnotationShape.nullable(),
  /** 运行中应用的批注画在哪张截图上（上传文件 id，ADR 0009 §18）；其他成果为 null */
  frame: z.uuid().nullable().default(null),
});
export type Annotation = z.infer<typeof Annotation>;

/** 一份成果的批注最多这么多条 */
export const MAX_ANNOTATIONS = 50;

/** PUT /v1/artifacts/:id/annotations：整份替换 */
export const AnnotationList = z
  .object({ annotations: z.array(Annotation).max(MAX_ANNOTATIONS) })
  .refine(
    ({ annotations }) =>
      new Set(annotations.map((a) => a.id)).size === annotations.length &&
      new Set(annotations.map((a) => a.number)).size === annotations.length,
    '批注编号不能重复',
  );

/**
 * 画布里的一个成果（ADR 0007 §8）：任务完成时，负责交付物的节点交出的一个文件，复制进画布。
 */
export const ArtifactBody = z.object({
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable()
    .optional(),
  id: z.uuid(),
  /** 文件名（不含目录） */
  name: z.string(),
  /** 节点产出里的相对路径，如 site/index.html */
  path: z.string(),
  size: z.number().int().nonnegative(),
  contentType: z.string(),
  category: ArtifactCategory,
  /** 只有经过完整交付文件检查的 oasis-app.json 才带这个字段。 */
  application: ApplicationSpec.nullable().optional(),
  /** 数字人配置（ADR 0013）；有它时成果页能开实时对话 */
  avatar: AvatarSpec.nullable().optional(),
  modelPreview: ModelPreviewHint.optional(),
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
  /** 修改出的新版：同一同步路径上被它替换的旧文件摘要（桌面端据此判断能不能覆盖，ADR 0012） */
  replacesSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable()
    .optional(),
  /** 用户的批注（ADR 0012 §9）；旧响应缺省为没有 */
  annotations: z.array(Annotation).default([]),
  /** 用户点了「批准」的时间；没批准为 null */
  approvedAt: z.iso.datetime().nullable().default(null),
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
