// 用户随消息发的文件（存在 canvas）：给 AI 看的说明、汇总成任务的素材（ADR 0007 §4）。
import type { Material } from '@oasis/contracts/canvas';
import type { MessageAttachment } from '@oasis/contracts/conversation';
import type { Message } from '../repo/conversation-repo.ts';

export function attachmentsOf(message: Pick<Message, 'kind' | 'data'>): MessageAttachment[] {
  if (message.kind !== 'text') return [];
  const list = (message.data as { attachments?: MessageAttachment[] }).attachments;
  return Array.isArray(list) ? list : [];
}

const sizeText = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** 给模型看的文字：AI 看不到文件内容，只知道有这些文件 */
export function withAttachmentNote(content: string, attachments: MessageAttachment[]): string {
  if (attachments.length === 0) return content;
  const names = attachments.map((a) => `${a.name}（${sizeText(a.size)}）`).join('、');
  return `${content}\n（随消息附了文件：${names}）`;
}

/** 合并素材，按上传 id 去重，保持先来后到 */
export function mergeMaterials(existing: Material[], more: MessageAttachment[]): Material[] {
  const seen = new Set(existing.map((m) => m.uploadId));
  const added = more
    .filter((a) => !seen.has(a.id))
    .map((a) => ({ uploadId: a.id, name: a.name, size: a.size }));
  return [...existing, ...added];
}

/** 素材清单（给接需求的 AI 看） */
export const materialsText = (materials: Material[]) =>
  materials.map((m) => `- ${m.name}（${sizeText(m.size)}）`).join('\n');
