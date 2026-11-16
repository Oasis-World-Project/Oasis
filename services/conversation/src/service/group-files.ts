// 群文件：AI 交的和人传的，一个群里同一个路径只有一份，再交、再传就是新版本（旧的不留）。
// 各个 AI 各有各的工作目录，靠群文件交接：开一轮时，别人交的新文件和新版本拷进它的 materials/group/。
// 人和人的私聊里发的文件不进群文件，只跟着那条消息。文件本身都存在 canvas。
import type { UploadBody } from '@oasis/contracts/canvas';
import { UploadLookupResult } from '@oasis/contracts/canvas';
import type { MessageAttachment } from '@oasis/contracts/conversation';
import type { GroupFile } from '@oasis/contracts/group';
import type { StartRunBody } from '@oasis/contracts/harness';
import { HttpError, type Logger, type ServiceClient } from '@oasis/service-kit';
import type { Conversation } from '../repo/conversation-repo.ts';
import type { FileRow, GroupFilesRepo } from '../repo/group-files-repo.ts';
import type { SeatBrief } from './group-hearing.ts';

type Materials = Required<StartRunBody>['materials'];
/** 别人交的文件拷进席位工作目录的这个目录下 */
const GROUP_DIR = 'materials/group';
/** 工作台「任务」页签看最近多少轮 */
const WORK_RUNS = 40;
/** 说明里最多列多少个文件名 */
const NOTE_FILES = 30;

const sizeText = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
/** 人传的文件在群文件里的路径就是文件名：去掉目录分隔和换行 */
const pathOf = (name: string) => {
  const safe = name.replace(/[\\/\r\n]/g, '_').trim();
  return safe === '' || safe === '.' || safe === '..' ? '_' : safe;
};

const toBody = (row: FileRow): GroupFile => ({
  id: row.id,
  path: row.path,
  name: row.name,
  size: Number(row.size),
  madeBy: { kind: row.made_kind, id: row.made_by },
  changedBy: { kind: row.changed_kind, id: row.changed_by },
  runId: row.run_id,
  updatedAt: row.updated_at.toISOString(),
});

export function createGroupFiles(deps: {
  repo: GroupFilesRepo;
  canvas: ServiceClient;
  /** 群里别的 AI 正在干活时，新交的群文件直接放进它们的工作目录；不给就等它们下一轮再拿 */
  harness?: ServiceClient;
  logger: Logger;
  /** 一个群最多多少个群文件 */
  maxFiles: number;
  /** 一轮最多往 AI 的工作目录里拷多少字节的群文件 */
  handoverBytes: number;
}) {
  const { repo, canvas, logger } = deps;

  async function group(userId: string, id: string) {
    const room = await repo.room(userId, id);
    if (room.kind !== 'group') throw new HttpError(404, 'group_not_found', '没有这个群');
    return room;
  }

  /** 被换下、被删掉的那一版是人传的：canvas 里那份也删掉（AI 交的还在它的工作目录里，跟着席位走） */
  async function drop(row: Pick<FileRow, 'source' | 'ref_id' | 'ref_owner'>, requestId?: string) {
    if (row.source !== 'upload') return;
    await canvas
      .json('POST', '/internal/uploads/delete', {
        body: { ownerId: row.ref_owner, ids: [row.ref_id] },
        ...(requestId ? { requestId } : {}),
      })
      .catch((err: unknown) => logger.warn({ err, uploadId: row.ref_id }, '换下的群文件没删掉'));
  }

  /**
   * 新交的这一版放进群里正在干活的别的 AI 的工作目录（materials/group/ 下）：它们不用等下一轮。
   * 不打断它们（说明里写了别人交的文件随时会出现在那里）；放不进去就算了，下一轮开工时照常拿到。
   */
  async function push(groupId: string, next: Parameters<GroupFilesRepo['put']>[1]) {
    if (!deps.harness) return;
    const path = `${GROUP_DIR}/${next.path}`;
    const material =
      next.source === 'artifact'
        ? { artifactId: next.refId, path }
        : { uploadId: next.refId, ownerId: next.refOwner, path };
    for (const runId of (await repo.people(groupId)).running) {
      if (runId === next.runId) continue;
      await deps.harness
        .json('POST', `/internal/runs/${runId}/materials`, { body: { materials: [material] } })
        .catch((err: unknown) => logger.debug({ err, runId, path }, '群文件没能放进正在跑的一轮'));
    }
  }

  async function put(
    groupId: string,
    next: Parameters<GroupFilesRepo['put']>[1],
    requestId?: string,
  ) {
    const result = await repo.put(groupId, next, deps.maxFiles);
    if (result.status === 'changed') await drop(result.replaced, requestId);
    if (result.status === 'changed' || result.status === 'added') await push(groupId, next);
    if (result.status === 'full')
      logger.warn({ groupId, path: next.path }, '群文件已满，这个文件没进群文件');
    return result.status;
  }

  async function stream(kind: 'artifacts' | 'uploads', id: string) {
    const response = await canvas.stream(
      'GET',
      `/internal/${kind}/${encodeURIComponent(id)}/content`,
    );
    return {
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      size: response.headers.get('content-length'),
      body: response.body,
    };
  }

  /** 这些文件拷进席位的工作目录：从新的往旧的拷，拷到字节上限为止；说明里写明拷了哪些、哪些太大没拷 */
  function handOver(rows: FileRow[], names: Map<string, string>) {
    const materials: Materials = [];
    const copied: string[] = [];
    const skipped: string[] = [];
    let total = 0;
    for (const row of rows) {
      const size = Number(row.size);
      if (total + size > deps.handoverBytes || materials.length >= 1500) {
        skipped.push(`${row.path}（${sizeText(size)}）`);
        continue;
      }
      total += size;
      const path = `${GROUP_DIR}/${row.path}`;
      materials.push(
        row.source === 'artifact'
          ? { artifactId: row.ref_id, path }
          : { uploadId: row.ref_id, ownerId: row.ref_owner, path },
      );
      const who =
        names.get(row.changed_by) ?? (row.changed_kind === 'ai' ? row.changed_by : '成员');
      copied.push(
        `${path}（${who}${row.changed_kind === 'ai' ? ' 交的' : ' 传的'}，${sizeText(size)}）`,
      );
    }
    const list = (items: string[]) =>
      items.length > NOTE_FILES
        ? `${items.slice(0, NOTE_FILES).join('、')} 等 ${items.length} 个`
        : items.join('、');
    const note = [
      copied.length
        ? `群文件里别人新交、新改的文件已经放进你的工作目录：${list(copied)}。要改其中一个，把改好的存到 out/ 下、去掉「${GROUP_DIR}/」这一段的同一个路径（${GROUP_DIR}/a.md 改好后存成 out/a.md），它就是群文件里的新版本`
        : '',
      skipped.length ? `这些群文件太大，没有拷进来：${list(skipped)}` : '',
    ]
      .filter(Boolean)
      .map((text) => `（${text}）`)
      .join('\n');
    return { materials, note };
  }

  return {
    /** 群文件列表 */
    async list(userId: string, groupId: string): Promise<GroupFile[]> {
      await group(userId, groupId);
      return (await repo.list(groupId)).map(toBody);
    },

    /** 一个群文件的内容（成员都能读） */
    async content(userId: string, groupId: string, fileId: string) {
      await group(userId, groupId);
      const row = await repo.find(groupId, fileId);
      if (!row) throw new HttpError(404, 'file_not_found', '这个文件已经不在群文件里');
      const file = await stream(row.source === 'artifact' ? 'artifacts' : 'uploads', row.ref_id);
      return { ...file, name: row.name };
    },

    /** 这段聊天（群，或两个好友的私聊）里一条消息带的文件 */
    async attachment(userId: string, roomId: string, uploadId: string) {
      await repo.room(userId, roomId);
      const found = await repo.attachment(roomId, uploadId);
      if (!found) throw new HttpError(404, 'file_not_found', '没有这个文件');
      return { ...(await stream('uploads', uploadId)), name: found.name };
    },

    /** 核对随消息发的文件都在 canvas 里、都是这个人传的，并记下它们被用上了（清扫不再删） */
    async resolve(userId: string, ids: string[], requestId: string): Promise<UploadBody[]> {
      if (!ids.length) return [];
      try {
        const { uploads } = await canvas.json('POST', '/internal/uploads/lookup', {
          body: { ownerId: userId, ids, claim: true },
          requestId,
          schema: UploadLookupResult,
        });
        return uploads;
      } catch (err) {
        if (err instanceof HttpError && err.statusCode === 404)
          throw new HttpError(400, 'attachment_not_found', '有文件没找到，请重新添加');
        throw err;
      }
    },

    /** 一句话引用的群文件：都得还在群文件里 */
    async refs(groupId: string, paths: string[]) {
      const unique = [...new Set(paths)];
      if (!unique.length) return [];
      const rows = await repo.byPaths(groupId, unique);
      if (rows.length !== unique.length)
        throw new HttpError(400, 'file_not_found', '引用的文件已经不在群文件里');
      return unique.map((path) => ({ path, name: rows.find((row) => row.path === path)!.name }));
    },

    /** 人在群里发了文件：进群文件（同名的换成这一版） */
    async uploaded(groupId: string, userId: string, uploads: UploadBody[], requestId: string) {
      for (const file of uploads)
        await put(
          groupId,
          {
            path: pathOf(file.name),
            name: file.name,
            size: file.size,
            version: file.sha256 ?? `upload:${file.id}`,
            source: 'upload',
            refId: file.id,
            refOwner: userId,
            by: { kind: 'user', id: userId },
            runId: null,
          },
          requestId,
        );
    },

    /** 群里的 AI 这一轮交了文件（已经登记进 canvas）：进群文件 */
    async delivered(
      seat: Pick<Conversation, 'parentId' | 'modelKey' | 'ownerId'>,
      runId: string,
      artifacts: {
        id: string;
        path: string;
        name: string;
        size: number;
        sha256?: string | null | undefined;
      }[],
    ) {
      if (!seat.parentId || !seat.modelKey) return;
      for (const file of artifacts)
        await put(seat.parentId, {
          // 改别人的文件时有的 AI 会连目录一起照搬成 out/materials/group/a.md：还是算 a.md 的新版本
          path: file.path.startsWith(`${GROUP_DIR}/`)
            ? file.path.slice(GROUP_DIR.length + 1)
            : file.path,
          name: file.name,
          size: file.size,
          version: file.sha256 ?? `size:${file.size}`,
          source: 'artifact',
          refId: file.id,
          refOwner: seat.ownerId,
          by: { kind: 'ai', id: seat.modelKey },
          runId,
        });
    },

    /**
     * 给席位这一轮带上群文件：它没拿到过的、别人交的新文件和新版本（files）；原来的工作目录接不上、
     * 要从头开始时是全部群文件（allFiles）。记下它拿到第几版了。
     */
    async attach(
      seat: Pick<Conversation, 'id' | 'parentId' | 'modelKey' | 'lastRunId' | 'options'>,
      brief: SeatBrief,
    ): Promise<SeatBrief> {
      if (!seat.parentId) return brief;
      const rows = await repo.list(seat.parentId);
      if (!rows.length) return brief;
      const { names } = await repo.people(seat.parentId);
      const seen = seat.lastRunId ? Number(seat.options.filesSeen ?? 0) : 0;
      const mine = (row: FileRow) =>
        row.source === 'artifact' && row.changed_kind === 'ai' && row.changed_by === seat.modelKey;
      const fresh = rows.filter((row) => Number(row.rev) > seen && !(seat.lastRunId && mine(row)));
      await repo.setSeen(seat.id, Number(rows[0]!.rev));
      return { ...brief, files: handOver(fresh, names), allFiles: handOver(rows, names) };
    },

    /**
     * 从群文件里删掉一个：传它的人和群主可以，AI 交的只有群主可以。做它的 AI 那一轮还没结束时不能删
     * （它收尾时会再交一遍）。人传的连 canvas 里那份一起删；AI 交的那份还在它的工作目录里。
     */
    async remove(userId: string, groupId: string, fileId: string, requestId: string) {
      const room = await group(userId, groupId);
      const row = await repo.find(groupId, fileId);
      if (!row) return;
      if (room.ownerId !== userId && !(row.made_kind === 'user' && row.made_by === userId))
        throw new HttpError(403, 'file_delete_not_allowed', '只有传这个文件的人和群主可以删');
      if (row.run_id && (await repo.people(groupId)).running.has(row.run_id))
        throw new HttpError(409, 'file_in_use', '它还在做这个文件，等它这一轮做完再删');
      const removed = await repo.remove(groupId, fileId);
      if (removed) await drop(removed, requestId);
    },

    /** 解散群、删好友之前：这段聊天里消息带的文件从 canvas 删掉（可以重复调用） */
    async purge(roomId: string, requestId: string) {
      const owners = new Map<string, string[]>();
      for (const file of await repo.uploads(roomId))
        owners.set(file.owner_id, [...(owners.get(file.owner_id) ?? []), file.id]);
      for (const [ownerId, ids] of owners)
        for (let i = 0; i < ids.length; i += 1000)
          await canvas.json('POST', '/internal/uploads/delete', {
            body: { ownerId, ids: ids.slice(i, i + 1000) },
            requestId,
          });
    },

    /** 工作台「任务」页签要的消息 */
    async work(userId: string, groupId: string) {
      await group(userId, groupId);
      return { messages: await repo.work(groupId, WORK_RUNS) };
    },
  };
}
export type GroupFiles = ReturnType<typeof createGroupFiles>;

/** 存进消息里的附件（不带摘要） */
export const toAttachment = ({ id, name, size, contentType }: UploadBody): MessageAttachment => ({
  id,
  name,
  size,
  contentType,
});
