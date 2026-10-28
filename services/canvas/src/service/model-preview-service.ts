// Associations come from owned formal artifacts and an explicit hash-bound sidecar, never README URLs.
import { Readable } from 'node:stream';
import { posix } from 'node:path';
import type { ArtifactBody } from '@oasis/contracts/canvas';
import {
  MODEL_PREVIEW_LIMITS as L,
  ModelInspectionResult,
  ModelPosterResult,
  ModelPreviewSpec,
  type ModelPreviewSource,
  type ModelPreviewBody,
} from '@oasis/contracts/model-preview';
import { checkedParts, HttpError, type ObjectStore, type ServiceClient } from '@oasis/service-kit';
import type { ArtifactService } from './artifact-service.ts';
import type { UploadService } from './upload-service.ts';
import type { Artifact } from '../repo/artifacts-repo.ts';

export function createModelPreviewService(deps: {
  artifacts: ArtifactService;
  uploads: UploadService;
  store: ObjectStore;
  task: ServiceClient;
  harness?: ServiceClient;
}) {
  const cache = new Map<string, Promise<ReturnType<typeof ModelInspectionResult.parse>>>();
  const posters = new Map<string, Promise<ReturnType<typeof ModelPosterResult.parse>>>();
  let reading = 0;
  async function bytes(
    row: { size: number; sha256?: string | null },
    source: () => Promise<Readable>,
    maxBytes = L.bytes,
  ) {
    if (row.size > maxBytes) throw new HttpError(413, 'model_preview_size', '文件超过交互预览上限');
    if (reading >= 2) throw new HttpError(503, 'model_preview_busy', '模型预览读取正忙');
    reading++;
    let stream: Readable | undefined,
      expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          const opened = await source();
          if (expired) {
            opened.destroy();
            throw new Error('Preview read expired');
          }
          stream = opened;
          const parts = checkedParts(stream, {
            maxBytes,
            size: row.size,
            ...(row.sha256 ? { sha256: row.sha256 } : {}),
          });
          const chunks: Buffer[] = [];
          for (;;) {
            const part = await parts.next();
            if (part.done) return { content: Buffer.concat(chunks), ...part.value };
            chunks.push(part.value);
          }
        })(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            expired = true;
            stream?.destroy(new Error('Preview read timeout'));
            reject(new Error('Preview read timeout'));
          }, 15000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      stream?.destroy();
      reading--;
    }
  }
  const ref = (row: Artifact) => ({
    url: `/api/canvas/v1/artifacts/${row.id}/content`,
    sha256: row.sha256!,
    size: row.size,
    name: row.name,
  });
  async function links(user: string, id: string) {
    const source = await deps.artifacts.get(user, id);
    const family = await deps.artifacts.family(user, id);
    const matches: {
      glb?: Artifact;
      poster?: Artifact;
      turntable?: Artifact;
      simplified: boolean;
    }[] = [];
    const manifests = family
      .filter((r) => r.name === 'oasis-model-preview.json' && r.size <= 16384)
      .slice(0, 8);
    for (const manifest of manifests) {
      try {
        const saved = await bytes(manifest, () => deps.store.read(manifest.objectKey), 16384);
        const parsed = ModelPreviewSpec.safeParse(JSON.parse(saved.content.toString('utf8')));
        if (!parsed.success) continue;
        const base = posix.dirname(manifest.path);
        const full = (path: string) => (base === '.' ? path : `${base}/${path}`);
        if (
          full(parsed.data.source.path) !== source.path ||
          parsed.data.source.sha256 !== source.sha256
        )
          continue;
        const linked = (part: { path: string; sha256: string } | undefined, ext: RegExp) => {
          if (!part) return undefined;
          return family.find(
            (row) =>
              row.path === full(part.path) &&
              row.sha256 === part.sha256 &&
              row.size > 0 &&
              ext.test(row.path),
          );
        };
        const glb = linked(parsed.data.glb, /\.glb$/i),
          poster = linked(parsed.data.poster, /\.(png|jpe?g|webp)$/i),
          turntable = linked(parsed.data.turntable, /\.(mp4|webm)$/i);
        if (
          (parsed.data.glb && !glb) ||
          (parsed.data.poster && !poster) ||
          (parsed.data.turntable && !turntable)
        )
          continue;
        matches.push({ glb, poster, turntable, simplified: parsed.data.simplified });
      } catch {
        /* Invalid/missing sidecars never authorize another file. */
      }
    }
    return { source, ...(matches.length === 1 ? matches[0] : { simplified: false }) };
  }
  async function posterFile(user: string, id: string) {
    const linked = await links(user, id),
      row = linked.poster;
    if (!row || !deps.harness)
      throw new HttpError(404, 'model_poster_missing', '没有可用的配套封面');
    const saved = await bytes(row, () => deps.store.read(row.objectKey));
    let pending = posters.get(saved.sha256);
    if (!pending) {
      if (posters.size >= 32) posters.delete(posters.keys().next().value!);
      pending = deps.harness.json('POST', '/internal/models/poster', {
        body: {
          name: `poster${posix.extname(row.name).toLowerCase()}`,
          sha256: saved.sha256,
          contentBase64: saved.content.toString('base64'),
        },
        schema: ModelPosterResult,
      });
      posters.set(saved.sha256, pending);
      void pending.catch(() => posters.delete(saved.sha256));
    }
    if ((await pending).sha256 !== saved.sha256)
      throw new HttpError(422, 'model_preview_hash', '封面检查摘要不符');
    return { row, ...saved };
  }
  async function describe(user: string, source: ModelPreviewSource): Promise<ModelPreviewBody> {
    let original: ModelPreviewBody['source'];
    let model:
      | {
          name: string;
          size: number;
          sha256?: string | null;
          read(): Promise<Readable>;
          url: string;
        }
      | undefined;
    let poster: ModelPreviewBody['poster'], turntable: ModelPreviewBody['turntable'];
    let simplified = false;
    if (source.kind === 'artifact') {
      const linked = await links(user, source.id),
        row = linked.source;
      if (!row.sha256)
        throw new HttpError(422, 'model_preview_hash', '旧成果缺少摘要，请下载原件查看');
      original = ref(row);
      const glb = linked.glb ?? (/\.glb$/i.test(row.path) ? row : undefined);
      if (glb) model = { ...glb, url: ref(glb).url, read: () => deps.store.read(glb.objectKey) };
      if (linked.poster && linked.poster.size <= L.bytes) {
        try {
          await posterFile(user, source.id);
          poster = {
            ...ref(linked.poster),
            url: `/api/canvas/v1/artifacts/${source.id}/model-poster`,
          };
        } catch {
          /* Unsafe posters are not adopted. */
        }
      }
      if (linked.turntable && linked.turntable.size <= 128 * 1024 ** 2)
        turntable = ref(linked.turntable);
      simplified = linked.simplified ?? false;
    } else if (source.kind === 'upload') {
      const row = await deps.uploads.owned(user, source.id);
      if (!row.sha256) throw new HttpError(422, 'model_preview_hash', '素材缺少摘要');
      original = {
        name: row.name,
        size: row.size,
        sha256: row.sha256,
        url: `/api/canvas/v1/uploads/${row.id}`,
      };
      if (/\.glb$/i.test(row.name))
        model = { ...row, url: original.url, read: () => deps.store.read(row.objectKey) };
    } else {
      const registered = (await deps.artifacts.list(user, { taskId: source.taskId })).filter(
        (row) => row.nodeId === source.nodeId && row.path === source.path,
      );
      if (registered.length === 1)
        return describe(user, { kind: 'artifact', id: registered[0]!.id });
      const encoded = source.path.split('/').map(encodeURIComponent).join('/');
      const response = await deps.task.stream(
        'GET',
        `/v1/tasks/${source.taskId}/files/${source.nodeId}/${encoded}`,
        { headers: { 'x-oasis-user-id': user }, signal: AbortSignal.timeout(15000) },
      );
      if (!response.body) throw new HttpError(422, 'model_preview_empty', '模型内容为空');
      const row = {
        size: Number(response.headers.get('content-length')),
        sha256: response.headers.get('x-oasis-file-sha256'),
      };
      if (
        !Number.isSafeInteger(row.size) ||
        row.size <= 0 ||
        !/^[a-f0-9]{64}$/.test(row.sha256 ?? '')
      ) {
        await response.body.cancel();
        throw new HttpError(422, 'model_preview_hash', '模型内容缺少可信大小或摘要');
      }
      const read = async () => Readable.fromWeb(response.body!);
      original = {
        name: posix.basename(source.path),
        size: row.size,
        sha256: row.sha256!,
        url: `/api/task/v1/tasks/${source.taskId}/files/${source.nodeId}/${encoded}`,
      };
      if (/\.glb$/i.test(source.path) && row.size <= L.bytes)
        model = { ...row, name: original.name, url: original.url, read };
      else await response.body.cancel();
    }
    const result: ModelPreviewBody = {
      source: original,
      simplified,
      ...(poster ? { poster } : {}),
      ...(turntable ? { turntable } : {}),
    };
    if (!model || !deps.harness || model.size > L.bytes)
      return { ...result, warning: '此原件暂不支持交互预览，可查看配套图片/视频或手动下载原件。' };
    try {
      const saved = await bytes(model, model.read);
      let pending = cache.get(saved.sha256);
      if (!pending) {
        if (cache.size >= 32) cache.delete(cache.keys().next().value!);
        pending = deps.harness.json('POST', '/internal/models/inspect', {
          body: { sha256: saved.sha256, contentBase64: saved.content.toString('base64') },
          schema: ModelInspectionResult,
        });
        cache.set(saved.sha256, pending);
        void pending.catch(() => cache.delete(saved.sha256));
      }
      const inspection = await pending;
      if (inspection.sha256 !== saved.sha256) throw new Error('Inspection identity mismatch');
      if (inspection.status !== 'ready') return { ...result, warning: inspection.reason };
      return {
        ...result,
        glb: {
          name: model.name,
          url: model.url,
          size: saved.size,
          sha256: saved.sha256,
          report: inspection.report,
        },
      };
    } catch {
      return {
        ...result,
        warning: '模型未能通过安全预览检查，原件保持不变，可稍后重试或手动下载。',
      };
    }
  }
  return {
    describe,
    poster: posterFile,
    async decorate(user: string, row: ArtifactBody): Promise<ArtifactBody> {
      if (!/\.(glb|gltf|blend|obj|fbx|stl|usdz|ply|zip)$/i.test(row.path)) return row;
      const linked = await links(user, row.id);
      if (
        !linked.glb &&
        !linked.poster &&
        !linked.turntable &&
        !/\.(glb|gltf|blend|obj|fbx|stl|usdz|ply)$/i.test(row.path)
      )
        return row;
      return {
        ...row,
        modelPreview: { kind: 'model', ...(linked.poster ? { posterId: linked.poster.id } : {}) },
      };
    },
  };
}
