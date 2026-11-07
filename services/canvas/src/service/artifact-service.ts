// 成果（ADR 0007 §8）：任务完成时把负责交付物的节点交出的文件复制进画布；给前端列出、读取。
import { randomUUID } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { once } from 'node:events';
import { Zip, ZipPassThrough } from 'fflate';
import {
  ApplicationSpec,
  type Annotation,
  type ArtifactBody,
  type ArtifactCategory,
} from '@oasis/contracts/canvas';
import type { TaskDeletedData, TaskStatusChangedData } from '@oasis/contracts/events';
import { TaskBody } from '@oasis/contracts/task';
import {
  contentTypeOf,
  HttpError,
  type Logger,
  type ObjectStore,
  type ServiceClient,
} from '@oasis/service-kit';
import { AVATAR_SPEC_SUFFIX, AvatarSpec } from '@oasis/contracts/avatar';
import type { Artifact, ArtifactsRepo, NewArtifact } from '../repo/artifacts-repo.ts';
import type { Upload, UploadsRepo } from '../repo/uploads-repo.ts';
import { categoryOf, safePath, safeSegment, uniqueName } from './naming.ts';

/** 数字人配置文件上限（30,000 字知识要点加人设，JSON 转义后留足余量） */
const AVATAR_SPEC_MAX_BYTES = 256 * 1024;

const toBody = (row: Artifact): ArtifactBody => ({
  id: row.id,
  name: row.name,
  path: row.path,
  size: row.size,
  sha256: row.sha256,
  contentType: row.contentType,
  category: row.category,
  application: row.appSpec,
  avatar: row.avatarSpec,
  deliverable: row.deliverable,
  taskId: row.taskId,
  nodeId: row.nodeId,
  taskTitle: row.taskTitle,
  conversationId: row.conversationId,
  models: row.models,
  syncPath: row.syncPath,
  replacesSha256: row.replacesSha256,
  annotations: row.annotations,
  approvedAt: row.approvedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

interface DeliveredFile {
  deliverable: string;
  nodeId: string;
  path: string;
  models: string[];
  /** task 清单里记的内容摘要（旧任务没有） */
  sha256?: string;
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
/** 旧式修订任务的素材（ADR 0012 旧流程）：打包出来的有自己的对象；逐个登记的沿用成果的对象，随成果删除 */
const packed = (upload: Upload) => upload.objectKey.startsWith('uploads/');

function safeApplicationMember(path: string): boolean {
  return (
    /^[\p{L}\p{N}_.-]+(?:\/[\p{L}\p{N}_.-]+)*$/u.test(path) &&
    path.split('/').every((part) => !part.startsWith('.'))
  );
}

export function createArtifactService(deps: {
  repo: ArtifactsRepo;
  /** 修订素材登记成上传记录（ADR 0012） */
  uploads: UploadsRepo;
  store: ObjectStore;
  task: ServiceClient;
  logger: Logger;
  maxFileBytes?: number;
  transferTimeoutMs?: number;
}) {
  const { repo, uploads, store, task, logger } = deps;

  /** 运行中应用的批注截图（ADR 0009 §18）：只被批注引用 */
  const framesOf = (rows: { annotations: { frame?: string | null }[] }[]) => [
    ...new Set(rows.flatMap((row) => row.annotations.flatMap((a) => (a.frame ? [a.frame] : [])))),
  ];
  /** 批注删掉、成果被新版替换或删除时，截图一起删；重投时已经删掉的找不到，不重复删 */
  async function dropFrames(ownerId: string, ids: string[]) {
    if (!ids.length) return;
    for (const row of await uploads.findOwned(ownerId, ids)) {
      await store.delete(row.objectKey);
      await uploads.remove(row.id);
    }
  }

  /** 这个任务在同步文件夹里用哪个目录：已经登记过的沿用，没有就用任务名，和别的任务重名就加序号 */
  async function taskDir(event: TaskStatusChangedData, existing: Artifact[]): Promise<string> {
    const used = existing[0]?.syncPath.split('/')[0];
    if (used) return used;
    const taken = new Set(
      (await repo.syncDirs(event.ownerId, event.taskId)).map((d) => d.toLowerCase()),
    );
    return uniqueName(safeSegment(event.title), taken, false);
  }

  /** 从 task 复制一个交付文件进画布，返回要登记的行（同步路径另定） */
  async function copyFile(
    event: TaskStatusChangedData,
    file: DeliveredFile,
  ): Promise<Omit<NewArtifact, 'syncPath' | 'replacesSha256'>> {
    const response = await task.stream(
      'GET',
      `/internal/tasks/${event.taskId}/files/${file.nodeId}/${file.path.split('/').map(encodeURIComponent).join('/')}`,
      { signal: AbortSignal.timeout(deps.transferTimeoutMs ?? 600_000) },
    );
    if (!response.body) throw new Error('成果文件没有内容流');
    const contentType = contentTypeOf(file.path);
    // 键由任务、节点、路径决定：事件重投时覆盖同一个对象，不会留下孤儿
    const objectKey = `artifacts/${event.taskId}/${file.nodeId}/${file.path}`;
    const saved = await store.putStream(objectKey, Readable.fromWeb(response.body), contentType, {
      maxBytes: deps.maxFileBytes ?? 512 * 1024 * 1024,
      ...(response.headers.get('content-length')
        ? { size: Number(response.headers.get('content-length')) }
        : {}),
      ...(response.headers.get('x-oasis-file-sha256')
        ? { sha256: response.headers.get('x-oasis-file-sha256')! }
        : {}),
    });
    return {
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
      avatarSpec: null,
      models: file.models,
      objectKey,
    };
  }

  /**
   * 修改出的新版交付了（ADR 0012 §2）：新文件先写进对象存储，再删上一版的对象，
   * 然后一个事务里换行（沿用上一版的目录名），最后让 task 删掉上一版。每一步都幂等，事件重投时从头再走。
   */
  async function replace(event: TaskStatusChangedData, detail: TaskBody, oldTaskId: string) {
    const previous = (await repo.listByTask(oldTaskId)).filter((r) => r.ownerId === event.ownerId);
    const existing = await repo.listByTask(event.taskId);
    const done = new Set(existing.map((a) => `${a.nodeId}/${a.path}`));
    const files = deliveredFiles(detail).filter((f) => !done.has(`${f.nodeId}/${f.path}`));
    if (existing.length === 0 && files.length === 0) {
      logger.warn({ taskId: event.taskId, oldTaskId }, '新版没有交出文件，保留上一版');
      return;
    }
    const dir =
      existing[0]?.syncPath.split('/')[0] ??
      previous[0]?.syncPath.split('/')[0] ??
      (await taskDir(event, []));
    const relativeOf = (row: Artifact) =>
      row.syncPath.startsWith(`${dir}/`) ? row.syncPath.slice(dir.length + 1).toLowerCase() : '';
    const oldByPath = new Map(previous.map((row) => [relativeOf(row), row]));
    const taken = new Set(existing.map(relativeOf));
    const rows: NewArtifact[] = [];
    for (const file of files) {
      const row = await copyFile(event, file);
      const relative = uniqueName(safePath(file.path), taken, true);
      taken.add(relative.toLowerCase());
      rows.push({
        ...row,
        syncPath: `${dir}/${relative}`,
        replacesSha256: oldByPath.get(relative.toLowerCase())?.sha256 ?? null,
      });
    }
    const sources = await uploads.listBySourceTask(oldTaskId);
    for (const row of previous) await store.delete(row.objectKey);
    for (const source of sources.filter(packed)) await store.delete(source.objectKey);
    await repo.replaceTask(oldTaskId, rows);
    await dropFrames(event.ownerId, framesOf(previous));
    logger.info(
      { taskId: event.taskId, oldTaskId, files: rows.length },
      '新版已登记进画布，替换了上一版',
    );
    await registerApplications(event.taskId);
    await task.json('POST', `/internal/tasks/${oldTaskId}/retire`, {
      body: { replacedBy: event.taskId },
    });
  }

  /** 应用描述：文件已经登记、描述还没写入的补齐（事件重投时也会执行） */
  async function registerApplications(taskId: string) {
    const all = await repo.listByTask(taskId);
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
    await registerAvatars(all);
  }

  /** 数字人配置（ADR 0013）：`*.oasis-avatar.json` 校验通过的记下来；不合格的照普通文件留着 */
  async function registerAvatars(all: Artifact[]) {
    for (const file of all.filter(
      (row) => row.name.endsWith(AVATAR_SPEC_SUFFIX) && !row.avatarSpec,
    )) {
      if (file.size > AVATAR_SPEC_MAX_BYTES) continue;
      const raw = await store.get(file.objectKey);
      if (raw.length > AVATAR_SPEC_MAX_BYTES) continue;
      let data: unknown;
      try {
        data = JSON.parse(raw.toString('utf8'));
      } catch {
        continue;
      }
      const parsed = AvatarSpec.safeParse(data);
      if (!parsed.success) {
        logger.warn(
          { artifactId: file.id, issues: parsed.error.issues.slice(0, 3) },
          '数字人配置不合格，按普通文件登记',
        );
        continue;
      }
      await repo.setAvatar(file.id, parsed.data);
    }
  }

  const service = {
    /** 任务状态变了：完成的就登记成果（幂等：已经登记过的跳过；出错抛出，事件会重投） */
    async onTaskStatus(event: TaskStatusChangedData): Promise<void> {
      if (event.status !== 'succeeded') return;
      let detail: TaskBody;
      try {
        detail = await task.json('GET', `/internal/tasks/${event.taskId}`, { schema: TaskBody });
      } catch (err) {
        if (err instanceof HttpError && err.statusCode === 404) return; // 已经被删除了
        throw err;
      }
      // 旧式修订任务（2026-11-05 之前新建的）：交付后整体替换上一版
      if (detail.revisionOf) return replace(event, detail, detail.revisionOf);
      const existing = await repo.listByTask(event.taskId);
      const byKey = new Map(existing.map((a) => [`${a.nodeId}/${a.path}`, a]));
      const delivered = deliveredFiles(detail);
      // 同一任务修改后再次交付（ADR 0012，2026-11-05）：内容变了的原地换成新版，链接和同步路径不变；
      // 批注已经交给 AI 处理过，连同截图一起清掉。摘要相同的不再复制（事件重投时什么也不做）。
      // 只看在这一版登记之后才又交付的任务（修改过）；同一次交付的事件重投不再复制
      const finished = detail.finishedAt ? new Date(detail.finishedAt) : null;
      for (const file of delivered) {
        const old = byKey.get(`${file.nodeId}/${file.path}`);
        if (!old || !finished || finished <= old.createdAt) continue;
        if (file.sha256 && file.sha256 === old.sha256) continue;
        const row = await copyFile(event, file);
        if (row.sha256 && row.sha256 === old.sha256) continue;
        const frames = framesOf([old]);
        await repo.replaceContent(old.id, {
          size: row.size,
          sha256: row.sha256,
          contentType: row.contentType,
          models: row.models,
          replacesSha256: old.sha256,
        });
        await dropFrames(event.ownerId, frames);
        logger.info({ taskId: event.taskId, path: file.path }, '成果已换成修改后的新版');
      }
      const done = new Set(byKey.keys());
      const files = delivered.filter((f) => !done.has(`${f.nodeId}/${f.path}`));
      const dir = files.length ? await taskDir(event, existing) : '';
      const takenInDir = new Set(
        existing.map((a) => a.syncPath.slice(dir.length + 1).toLowerCase()),
      );
      for (const file of files) {
        const row = await copyFile(event, file);
        const relative = uniqueName(safePath(file.path), takenInDir, true);
        takenInDir.add(relative.toLowerCase());
        const inserted = await repo.insert({
          ...row,
          syncPath: `${dir}/${relative}`,
          replacesSha256: null,
        });
        if (inserted) logger.info({ taskId: event.taskId, path: file.path }, '成果已登记进画布');
      }
      await registerApplications(event.taskId);
    },

    /**
     * 任务被删除（用户删除，或被新版替换后）：删掉它剩下的成果和来自它的修订素材（ADR 0012）。
     * 先删对象再删行；重投时找不到的就没有可删的。
     */
    async onTaskDeleted(event: TaskDeletedData): Promise<void> {
      const rows = (await repo.listByTask(event.taskId)).filter((r) => r.ownerId === event.ownerId);
      const sources = await uploads.listBySourceTask(event.taskId);
      for (const row of rows) await store.delete(row.objectKey);
      for (const source of sources.filter(packed)) await store.delete(source.objectKey);
      await repo.removeRows(
        rows.map((r) => r.id),
        sources.map((s) => s.id),
      );
      await dropFrames(event.ownerId, framesOf(rows));
      if (rows.length || sources.length)
        logger.info({ taskId: event.taskId, files: rows.length }, '任务已删除，成果一并清理');
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

    /**
     * 批注整份替换（ADR 0012 §9）：编号不能重复，最多 50 条（契约已校验）。
     * 新引用的截图必须是这个人自己上传的；不再被引用的截图随之删除（ADR 0009 §18）。
     */
    async setAnnotations(ownerId: string, id: string, annotations: Annotation[]) {
      const current = await service.get(ownerId, id);
      const before = framesOf([current]);
      const after = framesOf([{ annotations }]);
      const added = after.filter((frame) => !before.includes(frame));
      if (added.length && (await uploads.findOwned(ownerId, added)).length !== added.length)
        throw new HttpError(422, 'annotation_frame', '批注截图不存在，请重新截图');
      const saved = toBody((await repo.setReview(id, { annotations }))!);
      // 截图被批注用上了，清扫不再删它
      await uploads.claim(ownerId, added);
      await dropFrames(
        ownerId,
        before.filter((frame) => !after.includes(frame)),
      );
      return saved;
    },

    /** 批准 / 取消批准：只是记号，不挡修改 */
    async setApproval(ownerId: string, id: string, approved: boolean) {
      const row = await service.get(ownerId, id);
      if (approved === (row.approvedAt !== null)) return toBody(row);
      return toBody((await repo.setReview(id, { approvedAt: approved ? new Date() : null }))!);
    },

    async family(ownerId: string, id: string): Promise<Artifact[]> {
      const source = await this.get(ownerId, id);
      return (await repo.listByTask(source.taskId)).filter(
        (row) => row.ownerId === ownerId && row.nodeId === source.nodeId,
      );
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
  return service;
}

export type ArtifactService = ReturnType<typeof createArtifactService>;
