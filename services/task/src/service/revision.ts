// 修改成果（ADR 0012；2026-11-05 起直接交给 AI 团队）：用户在画布上写的修改意见、批注和参数整理成一段文字，
// 附件在 canvas 核对后并进任务素材，交给原任务接着改。不经过私聊：做出这一版的私聊删了也照样能改，
// 私聊里的 AI 只在用户问起时查进度。
import { UploadLookupResult } from '@oasis/contracts/canvas';
import type {
  RevisionNote,
  RevisionParameter,
  TaskBody,
  TaskRevisionBody,
} from '@oasis/contracts/task';
import { HttpError, type ServiceClient } from '@oasis/service-kit';
import type { z } from 'zod';
import type { WorkflowService } from './workflow-service.ts';

/** 修改意见的完整文字：用户写的话，加上每条批注一行（ADR 0012 §9）、每项参数一行 */
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

export function createRevisions(deps: {
  workflows: Pick<WorkflowService, 'revise'>;
  /** 核对附件是不是这个人的，并标成已用上（canvas 的清扫不再删它） */
  canvas: ServiceClient;
}) {
  return {
    async revise(
      ownerId: string,
      taskId: string,
      body: z.infer<typeof TaskRevisionBody>,
      requestId: string,
    ): Promise<TaskBody> {
      let uploads: { id: string; name: string; size: number }[] = [];
      if (body.attachments.length)
        try {
          ({ uploads } = await deps.canvas.json('POST', '/internal/uploads/lookup', {
            body: { ownerId, ids: body.attachments, claim: true },
            requestId,
            schema: UploadLookupResult,
          }));
        } catch (err) {
          if (err instanceof HttpError && err.statusCode === 404)
            throw new HttpError(400, 'attachment_not_found', '有文件没找到，请重新添加');
          throw err;
        }
      return deps.workflows.revise(taskId, {
        ownerId,
        request: revisionText(body.request, body.annotations, body.parameters),
        materials: uploads.map(({ id, name, size }) => ({ uploadId: id, name, size })),
        nodeIds: body.nodeIds,
      });
    },
  };
}
export type Revisions = ReturnType<typeof createRevisions>;
