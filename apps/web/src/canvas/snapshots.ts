// 发给 AI 修改时的标注截图（ADR 0012 §9）：把画面（图片、PDF 页、视频帧、运行中应用的截图）和圈画、编号合成一张 PNG。
// 画面只有浏览器里有，所以在这里合成；同一张画面上的批注合成一张，总数有上限，合成失败的那张就不带。
import type { Annotation, ArtifactBody } from '@oasis/contracts/canvas';
import { artifactContentUrl } from '../api/queries.ts';
import { uploadUrl } from '../api/upload.ts';
import { previewKindOf } from '../chat/files.ts';
import { drawAnnotations, frameKey, frameOrder, surfaceOf } from './annotations.ts';

/** 发给 AI 时怎么称呼这个成果：应用用它的目录名，不用内部的 oasis-app.json */
export const reviewName = (artifact: Pick<ArtifactBody, 'name' | 'application'>) =>
  artifact.application ? artifact.application.root : artifact.name;

const MAX_SIDE = 1600;

/** 演示文稿的配套 PDF：同一任务、同一节点、同名的 .pdf（和成果页预览用的是同一份） */
export function pdfCompanion(
  artifact: Pick<ArtifactBody, 'path' | 'taskId' | 'nodeId'>,
  siblings: ArtifactBody[],
): ArtifactBody | undefined {
  if (!/\.pptx?$/i.test(artifact.path)) return undefined;
  const found = siblings.filter(
    (item) =>
      item.path === artifact.path.replace(/\.pptx?$/i, '.pdf') &&
      item.taskId === artifact.taskId &&
      (!artifact.nodeId || item.nodeId === artifact.nodeId),
  );
  return found.length === 1 ? found[0] : undefined;
}

function sized(width: number, height: number) {
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  return canvas;
}

const toFile = (canvas: HTMLCanvasElement, name: string) =>
  new Promise<File>((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(new File([blob], name, { type: 'image/png' }))
          : reject(new Error('合成失败')),
      'image/png',
    ),
  );

function finish(canvas: HTMLCanvasElement, list: Annotation[], name: string) {
  drawAnnotations(canvas.getContext('2d')!, canvas.width, canvas.height, list);
  return toFile(canvas, name);
}

async function imageFrame(url: string, list: Annotation[], name: string) {
  const img = new Image();
  img.src = url;
  await img.decode();
  const canvas = sized(img.naturalWidth, img.naturalHeight);
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return finish(canvas, list, name);
}

async function videoFrames(url: string, groups: [number, Annotation[], string][]) {
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.src = url;
  await new Promise((resolve, reject) => {
    video.onloadeddata = resolve;
    video.onerror = reject;
  });
  const out: [string, File][] = [];
  for (const [time, list, name] of groups) {
    video.currentTime = time;
    await new Promise((resolve) => (video.onseeked = resolve));
    const canvas = sized(video.videoWidth, video.videoHeight);
    canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
    out.push([name, await finish(canvas, list, name)]);
  }
  video.removeAttribute('src');
  video.load();
  return out;
}

async function pdfPages(url: string, groups: [number, Annotation[], string][]) {
  const { openPdf, renderPage } = await import('./pdf.ts');
  const opened = openPdf(url);
  try {
    const doc = await opened.promise;
    const out: [string, File][] = [];
    for (const [page, list, name] of groups) {
      const canvas = document.createElement('canvas');
      await renderPage(doc, page, canvas, MAX_SIDE);
      out.push([name, await finish(canvas, list, name)]);
    }
    return out;
  } finally {
    opened.destroy();
  }
}

/**
 * 合成这些成果上有画面的批注截图，最多 limit 张。
 * 返回截图文件，以及「某个文件的某条批注见哪张截图」。
 */
export async function buildSnapshots(
  artifacts: ArtifactBody[],
  siblings: ArtifactBody[],
  limit: number,
): Promise<{ files: File[]; nameOf: (file: string, a: Annotation) => string | undefined }> {
  const names = new Map<string, string>();
  const files: File[] = [];
  const taken = new Set<string>();
  for (const artifact of artifacts) {
    const pdf = pdfCompanion(artifact, siblings);
    // 运行中的网页和应用：画在截图上的批注按截图合成
    const live = !!artifact.application || previewKindOf(artifact.path) === 'page';
    const surface = live ? 'app' : surfaceOf(previewKindOf(artifact.path), !!pdf);
    const drawn = artifact.annotations.filter((a) => a.shape && (!live || a.frame));
    const order = frameOrder(artifact.annotations);
    if (!drawn.length || surface === 'text' || surface === 'audio') continue;
    const stem = artifact.name.replace(/\.[^.]+$/, '');
    const groups = new Map<string, Annotation[]>();
    for (const a of drawn) groups.set(frameKey(a), [...(groups.get(frameKey(a)) ?? []), a]);
    const planned: [number, Annotation[], string][] = [];
    for (const list of groups.values()) {
      if (files.length + planned.length >= limit) break;
      const first = list[0]!;
      const suffix = first.frame
        ? `-截图${order.indexOf(first.frame) + 1}`
        : first.page !== null
          ? `-第${first.page}页`
          : first.time !== null
            ? `-${Math.round(first.time)}秒`
            : '';
      let name = `批注-${stem}${suffix}.png`;
      for (let n = 2; taken.has(name); n++) name = `批注-${stem}${suffix}-${n}.png`;
      taken.add(name);
      planned.push([first.page ?? first.time ?? 0, list, name]);
      for (const a of list) names.set(`${artifact.name}#${a.id}`, name);
    }
    if (!planned.length) continue;
    try {
      const url = artifactContentUrl((pdf ?? artifact).id);
      const [, imageList, imageName] = planned[0]!;
      const made: [string, File][] = [];
      if (surface === 'app')
        for (const [, list, name] of planned)
          made.push([name, await imageFrame(uploadUrl(list[0]!.frame!), list, name)]);
      else
        made.push(
          ...(surface === 'image'
            ? [[imageName, await imageFrame(url, imageList, imageName)] as [string, File]]
            : surface === 'video'
              ? await videoFrames(url, planned)
              : await pdfPages(url, planned)),
        );
      files.push(...made.map(([, file]) => file));
    } catch {
      // 合成失败：这些批注照样带上，只是没有截图
      for (const [, list] of planned)
        for (const a of list) names.delete(`${artifact.name}#${a.id}`);
    }
  }
  return { files, nameOf: (file, a) => names.get(`${file}#${a.id}`) };
}
