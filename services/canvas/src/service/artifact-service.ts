// 成果（ADR 0007 §8）：任务完成时把负责交付物的节点交出的文件复制进画布；给前端列出、读取。
import { randomUUID } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { once } from 'node:events';
import { Zip, ZipPassThrough } from 'fflate';
import { ApplicationSpec, type ArtifactBody, type ArtifactCategory } from '@oasis/contracts/canvas';
import type { TaskStatusChangedData } from '@oasis/contracts/events';
import { TaskBody } from '@oasis/contracts/task';
import {
  contentTypeOf,
  HttpError,
  type Logger,
  type ObjectStore,
  type ServiceClient,
} from '@oasis/service-kit';
import type { Artifact, ArtifactsRepo } from '../repo/artifacts-repo.ts';
import { categoryOf, safePath, safeSegment, uniqueName } from './naming.ts';

const toBody = (row: Artifact): ArtifactBody => ({
  id: row.id,
  name: row.name,
  path: row.path,
  size: row.size,
  sha256: row.sha256,
  contentType: row.contentType,
  category: row.category,
  application: row.appSpec,
  deliverable: row.deliverable,
  taskId: row.taskId,
  nodeId: row.nodeId,
  taskTitle: row.taskTitle,
  conversationId: row.conversationId,
  models: row.models,
  syncPath: row.syncPath,
  createdAt: row.createdAt.toISOString(),
});

interface DeliveredFile {
  deliverable: string;
  nodeId: string;
  path: string;
  models: string[];
}

/** 负责交付物的节点交出的文件，和交付消息列的是同一批；同一个文件只算一次（记在第一样交付物下） */
function deliveredFiles(task: TaskBody): DeliveredFile[] {
  const byId = new Map(task.nodes.map((n) => [n.id, n]));
  if (task.deliveryFiles !== undefined)
    return task.deliveryFiles.map((file) => {
      const node = byId.get(file.nodeId);
      return {
        ...file,
        models: [
          ...new Set([
            ...(node?.discussion?.participants.map((p) => p.model) ?? []),
            ...(node ? [node.model] : []),
          ]),
        ],
      };
    });
  const seen = new Set<string>();
  const files: DeliveredFile[] = [];
  for (const d of task.deliverables) {
    const node = d.nodeId ? byId.get(d.nodeId) : undefined;
    if (!node) continue;
    const models = [
      ...new Set([...(node.discussion?.participants.map((p) => p.model) ?? []), node.model]),
    ];
    for (const output of node.outputs) {
      const key = `${node.id}/${output.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      files.push({ deliverable: d.name, nodeId: node.id, path: output.path, models });
    }
  }
  return files;
}

const LIST_LIMIT = 1000;
const APP_MAX_FILES = 1000;
const APP_MAX_BYTES = 100 * 1024 * 1024;

function safeApplicationMember(path: string): boolean {
  return (
    /^[\p{L}\p{N}_.-]+(?:\/[\p{L}\p{N}_.-]+)*$/u.test(path) &&
    path.split('/').every((part) => !part.startsWith('.'))
  );
}

export function createArtifactService(deps: {
  repo: ArtifactsRepo;
  store: ObjectStore;
  task: ServiceClient;
  logger: Logger;
  maxFileBytes?: number;
  transferTimeoutMs?: number;
}) {
  const { repo, store, task, logger } = deps;

  /** 这个任务在同步文件夹里用哪个目录：已经登记过的沿用，没有就用任务名，和别的任务重名就加序号 */
  async function taskDir(event: TaskStatusChangedData, existing: Artifact[]): Promise<string> {
    const used = existing[0]?.syncPath.split('/')[0];
    if (used) return used;
    const taken = new Set(
      (await repo.syncDirs(event.ownerId, event.taskId)).map((d) => d.toLowerCase()),
    );
    return uniqueName(safeSegment(event.title), taken, false);
  }

  return {
    /** 任务状态变了：完成的就登记成果（幂等：已经登记过的跳过；出错抛出，事件会重投） */
    async onTaskStatus(event: TaskStatusChangedData): Promise<void> {
      if (event.status !== 'succeeded') return;
      const detail = await task.json('GET', `/internal/tasks/${event.taskId}`, {
        schema: TaskBody,
      });
      const existing = await repo.listByTask(event.taskId);
      const done = new Set(existing.map((a) => `${a.nodeId}/${a.path}`));
      const files = deliveredFiles(detail).filter((f) => !done.has(`${f.nodeId}/${f.path}`));
      const dir = files.length ? await taskDir(event, existing) : '';
      const takenInDir = new Set(
        existing.map((a) => a.syncPath.slice(dir.length + 1).toLowerCase()),
      );
      for (const file of files) {
        const response = await task.stream(
          'GET',
          `/internal/tasks/${event.taskId}/files/${file.nodeId}/${file.path.split('/').map(encodeURIComponent).join('/')}`,
          { signal: AbortSignal.timeout(deps.transferTimeoutMs ?? 600_000) },
        );
        if (!response.body) throw new Error('成果文件没有内容流');
        const contentType = contentTypeOf(file.path);
        // 键由任务、节点、路径决定：事件重投时覆盖同一个对象，不会留下孤儿
        const objectKey = `artifacts/${event.taskId}/${file.nodeId}/${file.path}`;
        const saved = await store.putStream(
          objectKey,
          Readable.fromWeb(response.body),
          contentType,
          {
            maxBytes: deps.maxFileBytes ?? 512 * 1024 * 1024,
            ...(response.headers.get('content-length')
              ? { size: Number(response.headers.get('content-length')) }
              : {}),
            ...(response.headers.get('x-oasis-file-sha256')
              ? { sha256: response.headers.get('x-oasis-file-sha256')! }
              : {}),
          },
        );
        const relative = uniqueName(safePath(file.path), takenInDir, true);
        takenInDir.add(relative.toLowerCase());
        const inserted = await repo.insert({
          id: randomUUID(),
          ownerId: event.ownerId,
          taskId: event.taskId,
          taskTitle: event.title,
          conversationId: event.conversationId,
          nodeId: file.nodeId,
          path: file.path,
          name: file.path.split('/').at(-1) ?? file.path,
          deliverable: file.deliverable,
          ...saved,
          contentType,
          category: categoryOf(file.path),
          appSpec: null,
          models: file.models,
          objectKey,
          syncPath: `${dir}/${relative}`,
        });
        if (inserted) logger.info({ taskId: event.taskId, path: file.path }, '成果已登记进画布');
      }
      // 事件重投时还会执行：文件已经登记、应用描述尚未写入时可继续补齐。
      const all = await repo.listByTask(event.taskId);
      for (const manifest of all.filter((row) => row.name === 'oasis-app.json' && !row.appSpec)) {
        if (manifest.size > 16_384) continue;
        const raw = await store.get(manifest.objectKey);
        if (raw.length > 16_384) continue;
        let data: unknown;
        try {
          data = JSON.parse(raw.toString('utf8'));
        } catch {
          continue;
        }
        const parsed = ApplicationSpec.safeParse(data);
        if (!parsed.success) continue;
        const spec = parsed.data;
        if (manifest.path !== `${spec.root}/oasis-app.json`) continue;
        const members = all.filter(
          (row) =>
            row.ownerId === manifest.ownerId &&
            row.nodeId === manifest.nodeId &&
            row.path.startsWith(`${spec.root}/`) &&
            row.size > 0,
        );
        if (
          members.length > APP_MAX_FILES ||
          members.reduce((sum, row) => sum + row.size, 0) > APP_MAX_BYTES ||
          members.some((row) => !safeApplicationMember(row.path.slice(spec.root.length + 1)))
        )
          continue;
        if (!members.some((row) => row.path === `${spec.root}/${spec.entry}` && row.size > 0))
          continue;
        await repo.setApplication(manifest.id, spec);
      }
    },

    async list(
      ownerId: string,
      filter: { category?: ArtifactCategory; taskId?: string },
    ): Promise<ArtifactBody[]> {
      return (await repo.list(ownerId, filter, LIST_LIMIT)).map(toBody);
    },

    async get(ownerId: string, id: string): Promise<Artifact> {
      const row = await repo.find(id);
      if (row?.ownerId !== ownerId) throw new HttpError(404, 'artifact_not_found', '没有这个成果');
      return row;
    },

    async family(ownerId: string, id: string): Promise<Artifact[]> {
      const source = await this.get(ownerId, id);
      return (await repo.listByTask(source.taskId)).filter(
        (row) => row.ownerId === ownerId && row.nodeId === source.nodeId,
      );
    },

    /** 只从同任务同节点、已登记的最终成果组装离线运行包。 */
    async application(ownerId: string, id: string) {
      const manifest = await this.get(ownerId, id);
      if (!manifest.appSpec) throw new HttpError(422, 'not_application', '这个成果不是可运行应用');
      const { root, entry } = manifest.appSpec;
      const rows = (await repo.listByTask(manifest.taskId)).filter(
        (row) =>
          row.ownerId === ownerId &&
          row.nodeId === manifest.nodeId &&
          row.path.startsWith(`${root}/`) &&
          row.size > 0,
      );
      if (
        rows.length > APP_MAX_FILES ||
        rows.reduce((sum, row) => sum + row.size, 0) > APP_MAX_BYTES
      )
        throw new HttpError(413, 'application_size', '应用文件超过运行上限');
      if (!rows.some((row) => row.path === `${root}/${entry}`))
        throw new HttpError(422, 'application_entry', '应用入口文件缺失');
      const files = [];
      for (const row of rows) {
        const path = row.path.slice(root.length + 1);
        if (!safeApplicationMember(path))
          throw new HttpError(422, 'application_path', '应用文件路径不安全');
        const content = await store.get(row.objectKey);
        if (content.length !== row.size)
          throw new HttpError(422, 'application_content', '应用文件大小不一致');
        files.push({ path, contentBase64: content.toString('base64') });
      }
      return { spec: manifest.appSpec, files };
    },

    /** 和桌面同步使用完全相同的最终文件集合与 syncPath。 */
    async archive(ownerId: string, taskId: string, limits: { bytes: number; files: number }) {
      const rows = (await repo.listByTask(taskId)).filter((row) => row.ownerId === ownerId);
      if (!rows.length) throw new HttpError(404, 'artifact_not_found', '没有这个任务的成果');
      if (rows.length > limits.files || rows.reduce((n, row) => n + row.size, 0) > limits.bytes)
        throw new HttpError(413, 'archive_size', '成果超过打包上限，请分别下载');
      const seen = new Set<string>();
      for (const row of rows) {
        const name = row.syncPath;
        if (
          !name ||
          name.includes('\\') ||
          name.startsWith('/') ||
          name
            .split('/')
            // eslint-disable-next-line no-control-regex
            .some((p) => !p || p === '.' || p === '..' || /[:\u0000-\u001f]/.test(p)) ||
          seen.has(name.toLowerCase())
        )
          throw new HttpError(422, 'archive_path', '成果目录异常，不能安全打包');
        seen.add(name.toLowerCase());
      }
      const content = new PassThrough();
      const cancel = new AbortController();
      const zip = new Zip((error, bytes, final) => {
        if (error) content.destroy(error);
        else {
          content.write(bytes);
          if (final) content.end();
        }
      });
      content.on('close', () => {
        cancel.abort();
        zip.terminate();
      });
      void (async () => {
        let total = 0;
        for (const row of rows) {
          if (content.destroyed) return;
          const file = new ZipPassThrough(row.syncPath);
          zip.add(file);
          const source = await store.read(row.objectKey);
          let size = 0;
          try {
            for await (const chunk of source) {
              const bytes = Buffer.from(chunk as Uint8Array);
              size += bytes.length;
              total += bytes.length;
              if (size > row.size || total > limits.bytes) throw new Error('成果内容大小不一致');
              file.push(bytes);
              if (content.writableNeedDrain)
                await once(content, 'drain', { signal: cancel.signal });
              if (content.destroyed) return;
            }
            if (size !== row.size) throw new Error('成果内容大小不一致');
            file.push(new Uint8Array(), true);
          } finally {
            source.destroy();
          }
        }
        zip.end();
      })().catch((error: unknown) =>
        content.destroy(error instanceof Error ? error : new Error(String(error))),
      );
      return {
        name: `${safeSegment(rows[0]!.taskTitle)}.zip`,
        content,
      };
    },

    toBody,
  };
}

export type ArtifactService = ReturnType<typeof createArtifactService>;
