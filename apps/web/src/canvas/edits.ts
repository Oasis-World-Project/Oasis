// 成果页的「编辑」：一处要改的地方记的是在哪（第几页、第几秒、画面上的一个点或一个框、引用的原文、选中的是什么）
// 和要怎么改。这里是它的规则：编号、位置怎么写成一句话、发给 AI 的那段话。纯逻辑，方便单测。
import {
  MAX_ANNOTATIONS,
  type Annotation,
  type AnnotationShape,
  type ArtifactBody,
} from '@oasis/contracts/canvas';
import type { PreviewKind } from '../chat/files.ts';
import type { RevisionParameter } from './parameters.ts';

/** 发给 AI 时怎么称呼这个成果：应用用它的目录名，不用内部的 oasis-app.json */
export const reviewName = (artifact: Pick<ArtifactBody, 'name' | 'application'>) =>
  artifact.application ? artifact.application.root : artifact.name;

/** 演示文稿和 Word 的配套 PDF：同一话题里同名的 .pdf（交付时系统配好；成果页预览用同一份） */
export function pdfCompanion(
  artifact: Pick<ArtifactBody, 'path' | 'sessionId'>,
  siblings: ArtifactBody[],
): ArtifactBody | undefined {
  const office = /\.(pptx?|docx?)$/i;
  if (!office.test(artifact.path)) return undefined;
  const found = siblings.filter(
    (item) =>
      item.path === artifact.path.replace(office, '.pdf') && item.sessionId === artifact.sessionId,
  );
  return found.length === 1 ? found[0] : undefined;
}

/**
 * 成果怎么指着改：图片、PDF 页（Word、PPT 用配套的 PDF）、视频的一帧能在画面上点或拖框；音频记第几秒；
 * live 是运行着的网页、应用、3D 模型（切到「选取」再点）；其余（文字、表格）选一段原文。
 */
export type Surface = 'image' | 'pdf' | 'video' | 'audio' | 'live' | 'text';

export function surfaceOf(kind: PreviewKind, hasPdf: boolean, live: boolean): Surface {
  if (live || kind === 'page' || kind === 'model') return 'live';
  if (kind === 'image' || kind === 'video' || kind === 'audio') return kind;
  if (kind === 'pdf' || ((kind === 'presentation' || kind === 'document') && hasPdf)) return 'pdf';
  return 'text';
}

/** 进了「编辑」画面下面那句提示 */
export const HINTS: Record<Surface, string> = {
  image: '在图上点一下或拖一个框，说这一块怎么改',
  pdf: '点一处或拖一个框，然后说怎么改',
  video: '暂停在要改的那一帧，在画面上点一下或拖一个框',
  audio: '播放到要改的地方暂停，再点「改这里」',
  live: '切到「选取」再点页面里要改的地方；切回「操作」可以照常点着用',
  text: '选中一段原文，再点「改这一段」',
};

/** 弹出来的「这里要怎么改？」下面几个常用的说法，点一下填进去 */
export const CHIPS: Record<Surface, string[]> = {
  image: ['去掉', '换成别的', '调亮一点'],
  pdf: ['改短', '换个说法', '删掉'],
  video: ['换个镜头', '调亮一点', '放慢'],
  audio: ['重录这一句', '放慢', '删掉'],
  live: ['去掉', '改文案', '挪个位置'],
  text: ['改短', '换个说法', '删掉'],
};

/** 下一个编号：用掉的最小空位，满了返回 null */
export function nextNumber(list: Annotation[]): number | null {
  if (list.length >= MAX_ANNOTATIONS) return null;
  const used = new Set(list.map((a) => a.number));
  for (let n = 1; n <= 99; n++) if (!used.has(n)) return n;
  return null;
}

export function formatTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** 编号画在哪：点就在点上，框在左上角 */
export const anchorOf = (shape: AnnotationShape): [number, number] => [shape.x, shape.y];

/** 形状中心落在画面九宫格的哪一格 */
function regionOf(shape: AnnotationShape): string {
  const x = shape.kind === 'pin' ? shape.x : shape.x + shape.w / 2;
  const y = shape.kind === 'pin' ? shape.y : shape.y + shape.h / 2;
  const col = x < 1 / 3 ? '左' : x > 2 / 3 ? '右' : '';
  const row = y < 1 / 3 ? '上' : y > 2 / 3 ? '下' : '';
  return `画面${col + row || '中间'}`;
}

/** 给人和 AI 看的位置：第 2 页 · 画面左上、0:12 · 画面中间、按钮「立即预约」、整体 */
export function whereOf(a: Pick<Annotation, 'page' | 'time' | 'shape' | 'target' | 'quote'>) {
  return (
    [
      a.page !== null ? `第 ${a.page} 页` : '',
      a.time !== null ? formatTime(a.time) : '',
      a.target ?? (a.shape ? regionOf(a.shape) : ''),
    ]
      .filter(Boolean)
      .join(' · ') || (a.quote ? '选中的一段' : '整体')
  );
}

/** 「让 AI 改」的那段话：整体的要求，加上每处一行、每项参数一行 */
export function revisionText(
  request: string,
  files: { name: string; annotations: Annotation[] }[],
  parameters: RevisionParameter[] = [],
): string {
  const lines = files.flatMap((file) =>
    [...file.annotations]
      .sort((a, b) => a.number - b.number)
      .map(
        (a) =>
          `${a.number}.「${file.name}」${whereOf(a)}：${a.note}${a.quote ? `（原文「${a.quote}」）` : ''}`,
      ),
  );
  const params = parameters.map((p) => `「${p.file}」${p.name}：${p.value}`);
  return [
    request,
    ...(lines.length ? ['要改的地方：', ...lines] : []),
    ...(params.length ? ['参数：', ...params] : []),
  ]
    .filter(Boolean)
    .join('\n');
}
