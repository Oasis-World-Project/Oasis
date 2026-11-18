// canvas 的接口：用户上传的文件，以及对话里 AI 做出的成果。
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
  /** 只返回还在的，不因为少了某个就报错（筛掉已随上一版删除的修订素材） */
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

/** 随消息交给 AI 的素材：harness 运行时放进沙箱的 materials/ 下 */
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

/** 成果上的一条批注：编号、意见，以及在哪（第几页、几秒、引用的原文、画的形状） */
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
  /** 运行中应用的批注画在哪张截图上（上传文件 id）；其他成果为 null */
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

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * 画布里的一个成果：对话里 AI 在沙箱 out/ 里做出的一个文件，做好一个就复制进画布，一直留着。
 * 同一个话题里同一个路径只有一份：后来的一轮改了它，原地换成新版（链接和同步路径不变），归到那一轮的任务下。
 */
export const ArtifactBody = z.object({
  sha256: Sha256.nullable().optional(),
  id: z.uuid(),
  /** 文件名（不含目录） */
  name: z.string(),
  /** out/ 里的相对路径，如 site/index.html */
  path: z.string(),
  size: z.number().int().nonnegative(),
  contentType: z.string(),
  category: ArtifactCategory,
  /** 只有通过检查的 oasis-app.json 才带这个字段。 */
  application: ApplicationSpec.nullable().optional(),
  /** 数字人配置；有它时成果页能开实时对话 */
  avatar: AvatarSpec.nullable().optional(),
  modelPreview: ModelPreviewHint.optional(),
  /** 在哪个对话里做的（回到对话用） */
  conversationId: z.uuid(),
  /** 哪个话题（同一个会话）：开新话题后是新的 */
  sessionId: z.uuid(),
  /** 最近一次做出或改了它的那一轮（画布上按它分任务） */
  runId: z.uuid(),
  /** 那一轮的任务名（画布上任务框的标题）；任务做出的成果在电脑上放在同名文件夹里 */
  task: z.string(),
  /** 做它的模型（供应商型号） */
  models: z.array(z.string()),
  /** 同步到电脑时放在哪：相对同步文件夹的路径，如 小木屋民宿官网首页/首页文案.md */
  syncPath: z.string(),
  /** 改出的新版：同一同步路径上被它替换的旧文件摘要（桌面端据此判断能不能覆盖） */
  replacesSha256: Sha256.nullable().optional(),
  /** 用户的批注；旧响应缺省为没有 */
  annotations: z.array(Annotation).default([]),
  /** 用户点了「批准」的时间；没批准为 null */
  approvedAt: z.iso.datetime().nullable().default(null),
  createdAt: z.iso.datetime(),
});
export type ArtifactBody = z.infer<typeof ArtifactBody>;

export const ArtifactList = z.object({ artifacts: z.array(ArtifactBody) });

/** 列表筛选：类别、某个对话、某个话题 */
export const ArtifactQuery = z.object({
  category: ArtifactCategory.optional(),
  conversationId: z.uuid().optional(),
  sessionId: z.uuid().optional(),
});

/**
 * 内部：按 id 查成果，核对是不是这个人的（「让 AI 改」时 conversation 收消息、harness 拷文件用）；
 * 有一个不在或不是他的就整个 404。
 * withFiles：再列出改它们要用到的全部文件——应用是整个应用目录，网页是它所在目录里的文件
 * （页面按相对地址引用它们），其他成果就是它自己。
 */
export const ArtifactLookupBody = z.object({
  ownerId: z.uuid(),
  ids: z.array(z.uuid()).min(1).max(1000),
  withFiles: z.boolean().default(false),
});
export const ArtifactLookupResult = z.object({
  /** 按请求的顺序 */
  artifacts: z.array(ArtifactBody),
  /** withFiles 时才有：改它们要用到的全部文件（包括它们自己），按路径排 */
  files: z.array(ArtifactBody).default([]),
});
export type ArtifactLookupResult = z.infer<typeof ArtifactLookupResult>;

/**
 * 内部：把对话里一轮 out/ 里的文件登记进画布（conversation 调）：一轮进行中做好一个登记一个，
 * 结束时再按产出清单登记一遍。canvas 按 sha256 和已登记的比，只留下变了的；重复调用不会重复登记。
 */
export const RegisterRunArtifactsBody = z.object({
  ownerId: z.uuid(),
  conversationId: z.uuid(),
  sessionId: z.uuid(),
  runId: z.uuid(),
  /** 任务名：这一轮第一次有成果时，用它给电脑上的文件夹起名 */
  task: z.string().trim().min(1).max(200),
  models: z.array(z.string().max(200)).max(10),
  /** out/ 里的文件：进行中登记的没有大小和摘要（从沙箱里读）；结束时是 harness 的产出清单 */
  outputs: z
    .array(
      z.object({
        path: z.string().min(1).max(500),
        size: z.number().int().nonnegative().optional(),
        sha256: Sha256.optional(),
      }),
    )
    .max(2000),
});
export type RegisterRunArtifactsBody = z.infer<typeof RegisterRunArtifactsBody>;

/** 内部：删对话、删任务（真删除）时删掉这个人名下对应的成果和批注截图 */
export const PurgeArtifactsBody = z.object({ ownerId: z.uuid() });

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
