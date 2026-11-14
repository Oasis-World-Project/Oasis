// 开一轮时交给 AI 的文件：用户随消息发的文件、「让 AI 改」的画布成果，
// 以及接在用户的话后面、告诉 AI 文件在哪的说明。
import type { ArtifactBody, ArtifactLookupResult } from '@oasis/contracts/canvas';
import type { MessageArtifact, MessageAttachment } from '@oasis/contracts/conversation';
import type { StartRunBody } from '@oasis/contracts/harness';

const sizeText = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** 之前话题做的成果拷进 materials/ 下的这个目录，再按话题文件夹分开 */
const CANVAS_DIR = 'canvas';

/**
 * 用户发的文件放进 materials/（同名加序号）。「让 AI 改」的成果是这一轮接着的会话（sessionId）
 * 做的，就在工作目录 out/ 里直接改；之前话题做的，连同它用到的文件拷进 materials/canvas/<话题文件夹>/。
 */
export function handOver(
  attachments: MessageAttachment[],
  revising: ArtifactLookupResult | undefined,
  sessionId: string | undefined,
): { materials: Required<StartRunBody>['materials']; note: string } {
  const used = new Set([CANVAS_DIR]);
  const uploads = attachments.map((file) => {
    let name = file.name;
    for (let n = 2; used.has(name.toLowerCase()); n += 1) name = `${n}-${file.name}`;
    used.add(name.toLowerCase());
    return { uploadId: file.id, path: `materials/${name}`, size: file.size };
  });
  const copyOf = (a: ArtifactBody, path = a.path) =>
    `materials/${CANVAS_DIR}/${a.syncPath.split('/')[0]}/${path}`;
  // 应用说它的目录
  const shown = (a: ArtifactBody) => (a.application ? `${a.application.root}/` : a.path);
  const here = revising?.artifacts.filter((a) => a.sessionId === sessionId) ?? [];
  const away = revising?.artifacts.filter((a) => a.sessionId !== sessionId) ?? [];
  const notes = [
    uploads.length
      ? `随消息发来的文件，在工作目录里：${uploads.map((m) => `${m.path}（${sizeText(m.size)}）`).join('、')}`
      : '',
    here.length
      ? `要改的成果就在工作目录里，直接改：${here.map((a) => `out/${shown(a)}`).join('、')}`
      : '',
    away.length
      ? `要改的成果是之前的话题做的，已经连同它用到的文件拷进工作目录：${away.map((a) => copyOf(a, shown(a))).join('、')}；改好的放进 out/`
      : '',
  ].filter(Boolean);
  return {
    materials: [
      ...uploads.map(({ uploadId, path }) => ({ uploadId, path })),
      ...(revising?.files ?? [])
        .filter((file) => file.sessionId !== sessionId)
        .map((file) => ({ artifactId: file.id, path: copyOf(file) })),
    ],
    note: notes.map((text) => `（${text}）`).join('\n'),
  };
}

/** 这一轮用户说的话（几句连起来）、带的文件、要改的画布成果 */
export function gather(messages: { content: string; data: Record<string, unknown> }[]) {
  return {
    text: messages.map((m) => m.content).join('\n\n'),
    attachments: messages.flatMap(
      (m) => (m.data as { attachments?: MessageAttachment[] }).attachments ?? [],
    ),
    revisingIds: [
      ...new Set(
        messages.flatMap((m) =>
          ((m.data as { artifacts?: MessageArtifact[] }).artifacts ?? []).map((a) => a.id),
        ),
      ),
    ],
  };
}

/** 用户的话后面接上说明 */
export const withNote = (text: string, note: string) => (note ? `${text}\n\n${note}` : text);
