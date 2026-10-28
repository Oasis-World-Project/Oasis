import { MODEL_PREVIEW_LIMITS as L } from '@oasis/contracts/model-preview';

self.onmessage = async (event: MessageEvent<{ bytes: ArrayBuffer; sha256: string }>) => {
  try {
    const { bytes, sha256 } = event.data;
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength < 28 || bytes.byteLength > L.bytes)
      throw new Error('模型超过预览大小上限');
    const view = new DataView(bytes);
    if (
      view.getUint32(0, true) !== 0x46546c67 ||
      view.getUint32(4, true) !== 2 ||
      view.getUint32(8, true) !== bytes.byteLength ||
      view.getUint32(16, true) !== 0x4e4f534a
    )
      throw new Error('模型文件头无效');
    const jsonBytes = view.getUint32(12, true);
    if (jsonBytes > 4 * 1024 ** 2 || jsonBytes + 28 > bytes.byteLength)
      throw new Error('模型 JSON 超过上限');
    const data = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes, 20, jsonBytes)),
    ) as Record<string, unknown>;
    const stack: unknown[] = [data];
    let count = 0;
    while (stack.length) {
      if (++count > 200000) throw new Error('模型结构超过上限');
      const item = stack.pop();
      if (item && typeof item === 'object')
        for (const [key, value] of Object.entries(item)) {
          if (
            key === 'uri' ||
            (key === 'extensions' && value && Object.keys(value as object).length)
          )
            throw new Error('模型包含外部资源或不支持的扩展');
          stack.push(value);
        }
    }
    if (
      !Array.isArray(data.nodes) ||
      data.nodes.length > L.nodes ||
      (Array.isArray(data.images) && data.images.length > L.images) ||
      (Array.isArray(data.animations) && data.animations.length > L.clips)
    )
      throw new Error('模型资源超过预览上限');
    const actual = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('');
    if (actual !== sha256) throw new Error('模型摘要与服务端检查结果不一致');
    self.postMessage({ bytes }, { transfer: [bytes] });
  } catch {
    self.postMessage({ error: '模型未通过客户端安全检查，请使用配套预览。' });
  }
};
