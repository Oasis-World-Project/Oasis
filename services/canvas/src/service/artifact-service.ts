// 成果（ADR 0007 §8）：任务完成时把负责交付物的节点交出的文件复制进画布；给前端列出、读取。
import { randomUUID } from 'node:crypto';
import type { ArtifactBody, ArtifactCategory } from '@oasis/contracts/canvas';
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
  contentType: row.contentType,
  category: row.category,
  deliverable: row.deliverable,
  taskId: row.taskId,
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

const LIST_LIMIT = 500;

export function createArtifactService(deps: {
  repo: ArtifactsRepo;
  store: ObjectStore;
  task: ServiceClient;
  logger: Logger;
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
      if (files.length === 0) return;

      const dir = await taskDir(event, existing);
      const takenInDir = new Set(
        existing.map((a) => a.syncPath.slice(dir.length + 1).toLowerCase()),
      );
      for (const file of files) {
        const response = await task.stream(
          'GET',
          `/internal/tasks/${event.taskId}/files/${file.nodeId}/${file.path.split('/').map(encodeURIComponent).join('/')}`,
        );
        const content = Buffer.from(await response.arrayBuffer());
        const contentType = contentTypeOf(file.path);
        // 键由任务、节点、路径决定：事件重投时覆盖同一个对象，不会留下孤儿
        const objectKey = `artifacts/${event.taskId}/${file.nodeId}/${file.path}`;
        await store.put(objectKey, content, contentType);
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
          size: content.length,
          contentType,
          category: categoryOf(file.path),
          models: file.models,
          objectKey,
          syncPath: `${dir}/${relative}`,
        });
        if (inserted) logger.info({ taskId: event.taskId, path: file.path }, '成果已登记进画布');
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

    toBody,
  };
}

export type ArtifactService = ReturnType<typeof createArtifactService>;
