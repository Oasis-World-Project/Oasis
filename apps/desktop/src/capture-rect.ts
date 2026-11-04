// 批注截图的区域检查（ADR 0009 §18）：页面传来的矩形不可信，主进程只截本窗口可视区内的一块。

/** 截图区域：数字、在窗口范围内、有大小；取整后交给 capturePage */
export function captureRect(
  rect: unknown,
  view: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  if (!rect || typeof rect !== 'object') throw new Error('参数不合格');
  const { x, y, width, height } = rect as Record<string, unknown>;
  if (![x, y, width, height].every((v) => typeof v === 'number' && Number.isFinite(v)))
    throw new Error('参数不合格');
  const left = Math.max(0, Math.floor(x as number));
  const top = Math.max(0, Math.floor(y as number));
  const right = Math.min(view.width, Math.ceil((x as number) + (width as number)));
  const bottom = Math.min(view.height, Math.ceil((y as number) + (height as number)));
  if (right - left < 1 || bottom - top < 1) throw new Error('截图区域不在窗口里');
  return { x: left, y: top, width: right - left, height: bottom - top };
}
