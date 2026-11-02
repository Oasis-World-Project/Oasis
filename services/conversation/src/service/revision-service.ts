// 修改成果（ADR 0012）：把修改意见并进上一版的任务单，带着上一版的交付文件新建一条工作流。
// 不调用模型、不重新问需求；新版交付后由 canvas 整体替换上一版。
import {
  RevisionMaterialsResult,
  UploadLookupResult,
  type Material,
} from '@oasis/contracts/canvas';
import type {
  MessageAttachment,
  RevisionNote,
  RevisionParameter,
} from '@oasis/contracts/conversation';
import { TaskBody, type TaskSheet } from '@oasis/contracts/task';
import { HttpError, type Logger, type ServiceClient } from '@oasis/service-kit';
import { z } from 'zod';
import type { Conversation, ConversationRepo, Message } from '../repo/conversation-repo.ts';
import { mergeMaterials } from './attachments.ts';

const CreatedTask = z.object({ id: z.uuid() }).loose();
const BRIEF_MAX = 20_000;
const KEEP_SAME = '只改修改意见涉及的地方，其余与上一版保持一致';

type RevisionFiles = RevisionMaterialsResult['files'];

/**
 * 修订任务单里的验收点：一句短话。完整的意见和批注在要求原话和修订说明里，
 * 验收点只点明要核对什么（批注全文放进来太长，交付消息里的检查清单也难读）。
 */
export function revisionCriterion(request: string, noteCount: number, paramCount = 0): string {
  if (!noteCount && !paramCount)
    return `修改意见已落实：${request.length > 60 ? `${request.slice(0, 60)}…` : request}`;
  const parts = [
    request ? '修改意见' : '',
    noteCount ? `${noteCount} 条批注` : '',
    paramCount ? `${paramCount} 项参数` : '',
  ].filter(Boolean);
  const last = parts.at(-1)!;
  // 「和」后面接数字时空一格，和「2 条批注」的写法一致
  const joined =
    parts.length > 1
      ? `${parts.slice(0, -1).join('、')}和${/^\d/.test(last) ? ' ' : ''}${last}`
      : last;
  return `${joined}都已落实（见修改意见）`;
}

/** 上一版的任务单加上修改意见（ADR 0012 §3）；直接给方案建的任务没有任务单，按交付物补一张 */
export function revisedSheet(
  previous: Pick<TaskBody, 'title' | 'sheet' | 'deliverables'>,
  request: string,
  materials: Material[],
  criterion = revisionCriterion(request, 0),
): TaskSheet {
  const base: TaskSheet = previous.sheet ?? {
    title: previous.title.slice(0, 60),
    deliverables: previous.deliverables
      .slice(0, 10)
      .map((d) => ({ name: d.name.slice(0, 60), form: d.form.slice(0, 60) })),
    criteria: ['和上一版一样完整可用'],
    style: [],
    budgetMicro: null,
    assumptions: [],
    materials: [],
  };
  const requirements = base.requirements ?? [];
  const id = `revision-${requirements.filter((r) => r.id.startsWith('revision-')).length + 1}`;
  const quote = request.slice(0, 2000);
  return {
    ...base,
    criteria: [...base.criteria.slice(0, 7), criterion.slice(0, 200)],
    style: base.style.includes(KEEP_SAME) ? base.style : [...base.style.slice(0, 7), KEEP_SAME],
    // 有来源的要求最多 32 条：放不下时去掉最早的修改意见，原始要求保留
    requirements: [
      ...requirements.slice(-31),
      { id, text: request.slice(0, 1000), sources: [{ kind: 'revision', quote }] },
    ],
    materials: materials.map((m) => m.name),
  };
}

/**
 * 修改意见的完整文字：用户写的话，加上每条批注一行（ADR 0012 §9）。
 * 任务单的要求、验收点、说明和私聊里的消息都用它，保证各处说的是同一件事。
 */
export function revisionText(
  request: string,
  annotations: RevisionNote[],
  parameters: RevisionParameter[] = [],
): string {
  // 按用户看到的顺序（前端按文件、编号排好）
  const notes = annotations.map((a) => {
    const extra = [
      a.quote ? `原文「${a.quote}」` : '',
      a.snapshot ? `见截图 ${a.snapshot}` : '',
    ].filter(Boolean);
    return `${a.number}.「${a.file}」${a.where}：${a.note}${extra.length ? `（${extra.join('；')}）` : ''}`;
  });
  const params = parameters.map((p) => `「${p.file}」${p.name}：${p.value}`);
  return [
    request,
    ...(notes.length ? ['批注：', ...notes] : []),
    ...(params.length ? ['参数：', ...params] : []),
  ]
    .filter(Boolean)
    .join('\n');
}

/** 修订说明：上一版的说明 + 本次修改（超长时截短上一版说明的后部，修改部分完整保留） */
export function revisionBrief(
  previousBrief: string,
  request: string,
  files: RevisionFiles,
  attachments: Pick<Material, 'name'>[],
): string {
  const approved = files.filter((f) => f.approved);
  const lines = [
    '## 本次是修改',
    '用户看过上一版的成果，提出了下面的修改意见。请在上一版的基础上做出新版：',
    '- 只改修改意见涉及的地方，其余内容、结构和风格与上一版保持一致；',
    '- 新版会整体替换上一版，所以必须交齐任务单里的全部交付物；没要求改的文件从 materials/ 原样复制到交付位置。',
    '- 「保持一致」指内容、构图、主体和风格不变，不要求像素完全相同。图片、视频这类生成的画面，优先用支持参考图的工具在上一版上改（把上一版和标注截图作为参考图），比手工抠图、逐像素合成更快也更自然；改完核对没提到的地方没有明显变化即可。',
    '- 「参数：」里每一项是用户在参数面板里选定的新值（如字幕字号、配乐音量、材质、尺寸），按它改成品；没列出的参数保持不变。',
    '- 批注里的位置：「第 N 页」指 PDF 或演示文稿的页码，「m:ss」指音视频的时间，画面上的位置以随附的标注截图为准（截图上的编号和批注编号一致）。',
    '',
    '### 修改意见（用户原话）',
    request,
    '',
    '### 上一版的文件（在 materials/ 下）',
    ...files.map((f) => `- ${f.material}：上一版的 ${f.path}（交付物「${f.deliverable}」）`),
    ...(approved.length
      ? [
          '',
          '### 用户已批准的文件（除非修改意见或批注提到，否则原样保留）',
          ...approved.map((f) => `- ${f.material}`),
        ]
      : []),
    ...(attachments.length
      ? [
          '',
          '### 这次随修改意见附的文件（在 materials/ 下）',
          ...attachments.map((a) => `- ${a.name}`),
        ]
      : []),
  ];
  const revision = lines.join('\n');
  const room = BRIEF_MAX - revision.length - 2;
  if (room <= 0) return revision.slice(0, BRIEF_MAX);
  // 上一版说明的开头是用户最初的需求，最要紧；放不下时截掉后面的部分
  const earlier =
    previousBrief.length > room ? `${previousBrief.slice(0, room - 1)}…` : previousBrief;
  return `${earlier}\n\n${revision}`;
}

export function createRevisionService(deps: {
  repo: ConversationRepo;
  task: ServiceClient;
  canvas: ServiceClient;
  logger: Logger;
}) {
  const { repo, logger } = deps;

  return {
    /** 发起修改：返回这次新增的消息（用户的修改意见、新的任务卡） */
    async revise(input: {
      conversation: Conversation;
      ownerId: string;
      taskId: string;
      request: string;
      annotations: RevisionNote[];
      parameters?: RevisionParameter[];
      attachments: MessageAttachment[];
      requestId: string;
    }): Promise<Message[]> {
      const { ownerId, requestId } = input;
      const parameters = input.parameters ?? [];
      const text = revisionText(input.request, input.annotations, parameters);
      let previous: TaskBody;
      try {
        previous = await deps.task.json('GET', `/internal/tasks/${input.taskId}`, {
          schema: TaskBody,
          requestId,
        });
      } catch (err) {
        if (err instanceof HttpError && err.statusCode === 404)
          throw new HttpError(404, 'task_not_found', '没有这个任务');
        throw err;
      }
      if (previous.status !== 'succeeded')
        throw new HttpError(409, 'task_not_delivered', '这个任务还没有交付成果，不能修改');
      // 上一版的素材里，随更早的版本删掉的（上一轮的「上一版-…」）不再带上
      const kept = previous.materials.length
        ? (
            await deps.canvas.json('POST', '/internal/uploads/lookup', {
              body: { ownerId, ids: previous.materials.map((m) => m.uploadId), partial: true },
              schema: UploadLookupResult,
              requestId,
            })
          ).uploads.map((u) => ({ uploadId: u.id, name: u.name, size: u.size }))
        : [];
      const revision = await deps.canvas.json('POST', '/internal/revisions/materials', {
        body: { ownerId, taskId: input.taskId },
        schema: RevisionMaterialsResult,
        requestId,
      });
      const materials = mergeMaterials([...kept, ...revision.materials], input.attachments);
      const sheet = revisedSheet(
        previous,
        text,
        materials,
        revisionCriterion(input.request, input.annotations.length, parameters.length),
      );
      const created = await deps.task.json('POST', '/internal/tasks', {
        body: {
          ownerId,
          payerId: ownerId,
          conversationId: input.conversation.id,
          title: sheet.title,
          brief: revisionBrief(previous.brief, text, revision.files, input.attachments),
          sheet,
          materials,
          revisionOf: input.taskId,
        },
        schema: CreatedTask,
        requestId,
      });
      const userMessage = await repo.insertMessage({
        conversationId: input.conversation.id,
        authorKind: 'user',
        authorId: ownerId,
        content: `修改「${previous.title}」：${text}`,
        status: 'complete',
        kind: 'text',
        data: { intent: 'task', attachments: input.attachments },
      });
      const card = await repo.insertMessage({
        conversationId: input.conversation.id,
        authorKind: 'ai',
        authorId: input.conversation.modelKey ?? 'unknown',
        content: `好的，按你的意见改一版「${sheet.title}」。新版交付后会替换上一版，进度会显示在这里。`,
        status: 'complete',
        kind: 'task',
        data: { taskId: created.id, revisionOf: input.taskId },
      });
      await repo.touchConversation(input.conversation.id);
      logger.info({ taskId: created.id, revisionOf: input.taskId }, '发起修改，新建修订任务');
      return [userMessage, card];
    },
  };
}

export type RevisionService = ReturnType<typeof createRevisionService>;
