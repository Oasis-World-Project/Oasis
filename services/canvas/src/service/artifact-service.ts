// 成果：对话里一轮 out/ 里做好的文件从 harness 复制进画布（进行中做好一个进一个，结束时再登记一遍），
// 按任务（一轮）归好；给前端列出、读取、打包下载。
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  ApplicationSpec,
  type Annotation,
  type ArtifactBody,
  type ArtifactCategory,
  type RegisterRunArtifactsBody,
} from '@oasis/contracts/canvas';
import {
  contentTypeOf,
  HttpError,
  type Logger,
  type ObjectStore,
  type ServiceClient,
} from '@oasis/service-kit';
import { AVATAR_SPEC_SUFFIX, AvatarSpec } from '@oasis/contracts/avatar';
import type { Artifact, ArtifactsRepo, NewArtifact } from '../repo/artifacts-repo.ts';
import type { UploadsRepo } from '../repo/uploads-repo.ts';
import { zipArtifacts, type ArchiveLimits } from './archive.ts';
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
  conversationId: row.conversationId,
  sessionId: row.sessionId,
  runId: row.runId,
  task: row.task,
  models: row.models,
  syncPath: row.syncPath,
  replacesSha256: row.replacesSha256,
  annotations: row.annotations,
  approvedAt: row.approvedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

type RunOutput = RegisterRunArtifactsBody['outputs'][number];

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
  /** 批注截图存成上传记录，成果换新版或删除时一起删 */
  uploads: UploadsRepo;
  store: ObjectStore;
  /** 一轮的产出文件在 harness */
  harness: ServiceClient;
  logger: Logger;
  maxFileBytes?: number;
  transferTimeoutMs?: number;
}) {
  const { repo, uploads, store, harness, logger } = deps;

  /** 运行中应用的批注截图：只被批注引用 */
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

  /**
   * 这个任务（一轮）的成果在同步文件夹里放哪个目录：这一轮已经登记过的沿用（目录名是任务名，重名时
   * 带序号；这一轮改了的旧成果留在原来任务的目录里，不算）；没有就用任务名，和已有的重名就加序号
   */
  async function taskDir(run: RegisterRunArtifactsBody, existing: Artifact[]): Promise<string> {
    const base = safeSegment(run.task);
    const ours = (dir: string) =>
      dir === base || (dir.startsWith(`${base} (`) && /^ \(\d+\)$/.test(dir.slice(base.length)));
    const used = existing
      .filter((row) => row.runId === run.runId)
      .map((row) => row.syncPath.split('/')[0] ?? '')
      .find(ours);
    if (used) return used;
    const taken = new Set((await repo.syncDirs(run.ownerId)).map((d) => d.toLowerCase()));
    return uniqueName(base, taken, false);
  }

  /** 从 harness 复制这一轮的一个产出文件进画布，返回要登记的行（同步路径另定） */
  async function copyFile(
    run: RegisterRunArtifactsBody,
    file: RunOutput,
  ): Promise<Omit<NewArtifact, 'syncPath' | 'replacesSha256'>> {
    const response = await harness.stream(
      'GET',
      `/internal/runs/${run.runId}/files/${file.path.split('/').map(encodeURIComponent).join('/')}`,
      { signal: AbortSignal.timeout(deps.transferTimeoutMs ?? 600_000) },
    );
    if (!response.body) throw new Error('成果文件没有内容流');
    const contentType = contentTypeOf(file.path);
    // 键由话题和路径决定：后来的一轮改了它、重复登记时都覆盖同一个对象，不会留下孤儿
    const objectKey = `artifacts/${run.sessionId}/${file.path}`;
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
      ownerId: run.ownerId,
      conversationId: run.conversationId,
      sessionId: run.sessionId,
      runId: run.runId,
      task: run.task,
      path: file.path,
      name: file.path.split('/').at(-1) ?? file.path,
      ...saved,
      contentType,
      category: categoryOf(file.path),
      appSpec: null,
      avatarSpec: null,
      models: run.models,
      objectKey,
    };
  }

  /** 应用描述：文件已经登记、描述还没写入的补齐（重复登记时也会执行） */
  async function registerApplications(sessionId: string) {
    const all = await repo.listBySession(sessionId);
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
          row.ownerId === manifest.ownerId && row.path.startsWith(`${spec.root}/`) && row.size > 0,
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

  /** 数字人配置：`*.oasis-avatar.json` 校验通过的记下来；不合格的照普通文件留着 */
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
    /**
     * 对话里一轮 out/ 里的文件登记进画布：一轮进行中做好一个登记一个，结束时按产出清单再登记一遍。
     * 新的登记进来，放进这个任务的同步目录；改过的原地换成新版、归到这一轮（链接和同步路径不变；批注
     * 针对的是旧内容，连同截图一起清掉）；内容没变的不动。重复调用不会重复登记。
     * 返回这一轮的全部成果（之前几次登记的也在内），这次交来的按交来的顺序在前。
     */
    async registerRun(run: RegisterRunArtifactsBody): Promise<ArtifactBody[]> {
      const existing = await repo.listBySession(run.sessionId);
      if (existing.some((row) => row.ownerId !== run.ownerId))
        throw new HttpError(409, 'session_owner', '这个话题不属于这个用户');
      const byPath = new Map(existing.map((row) => [row.path, row]));
      for (const file of run.outputs) {
        const old = byPath.get(file.path);
        if (!old) continue;
        // 进行中登记的没有摘要：拷过来比一比才知道变没变
        if (file.sha256 && file.sha256 === old.sha256) continue;
        const row = await copyFile(run, file);
        if (row.sha256 && row.sha256 === old.sha256) continue;
        const frames = framesOf([old]);
        await repo.replaceContent(old.id, {
          size: row.size,
          sha256: row.sha256,
          contentType: row.contentType,
          models: row.models,
          replacesSha256: old.sha256,
          runId: run.runId,
          task: run.task,
        });
        await dropFrames(run.ownerId, frames);
        logger.info({ runId: run.runId, path: file.path }, '成果已换成新版');
      }
      const added = run.outputs.filter((file) => !byPath.has(file.path));
      const dir = added.length ? await taskDir(run, existing) : '';
      const takenInDir = new Set(
        existing
          .filter((row) => row.syncPath.startsWith(`${dir}/`))
          .map((row) => row.syncPath.slice(dir.length + 1).toLowerCase()),
      );
      for (const file of added) {
        const row = await copyFile(run, file);
        const relative = uniqueName(safePath(file.path), takenInDir, true);
        takenInDir.add(relative.toLowerCase());
        if (await repo.insert({ ...row, syncPath: `${dir}/${relative}`, replacesSha256: null }))
          logger.info({ runId: run.runId, path: file.path }, '成果已登记进画布');
      }
      await registerApplications(run.sessionId);
      const order = new Map(run.outputs.map((file, index) => [file.path, index]));
      const rank = (row: Artifact) => order.get(row.path) ?? run.outputs.length;
      return (await repo.listBySession(run.sessionId))
        .filter((row) => row.runId === run.runId)
        .sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path))
        .map(toBody);
    },

    /** 删对话（真删除）：删掉它的成果和批注截图。先删对象再删行；重复调用时没有可删的。 */
    async purgeConversation(ownerId: string, conversationId: string): Promise<void> {
      const rows = (await repo.listByConversation(conversationId)).filter(
        (row) => row.ownerId === ownerId,
      );
      for (const row of rows) await store.delete(row.objectKey);
      await repo.removeRows(rows.map((row) => row.id));
      await dropFrames(ownerId, framesOf(rows));
      if (rows.length)
        logger.info({ conversationId, files: rows.length }, '对话已删除，成果一并清理');
    },

    async list(
      ownerId: string,
      filter: { category?: ArtifactCategory; conversationId?: string; sessionId?: string },
    ): Promise<ArtifactBody[]> {
      return (await repo.list(ownerId, filter, LIST_LIMIT)).map(toBody);
    },
    async get(ownerId: string, id: string): Promise<Artifact> {
      const row = await repo.find(id);
      if (row?.ownerId !== ownerId) throw new HttpError(404, 'artifact_not_found', '没有这个成果');
      return row;
    },

    /**
     * 内部：「让 AI 改」时查这些成果，必须都在且都是这个人的。
     * withFiles 时再列出改它们要用到的全部文件：应用是整个应用目录，网页是它所在目录里的文件
     * （页面按相对地址引用它们），其他成果就是它自己。
     */
    async lookup(ownerId: string, ids: string[], withFiles: boolean) {
      const unique = [...new Set(ids)];
      const rows = await repo.findMany(unique);
      if (rows.length !== unique.length || rows.some((row) => row.ownerId !== ownerId))
        throw new HttpError(404, 'artifact_not_found', '有成果找不到了');
      const files = new Map<string, Artifact>();
      if (withFiles) {
        const sessions = new Map<string, Artifact[]>();
        for (const row of rows) {
          let all = sessions.get(row.sessionId);
          if (!all) sessions.set(row.sessionId, (all = await repo.listBySession(row.sessionId)));
          const dir = row.appSpec
            ? `${row.appSpec.root}/`
            : /\.html?$/i.test(row.path)
              ? row.path.slice(0, row.path.lastIndexOf('/') + 1)
              : undefined;
          const needed =
            dir === undefined
              ? [row]
              : all.filter((file) => file.ownerId === ownerId && file.path.startsWith(dir));
          for (const file of needed) files.set(file.id, file);
        }
      }
      const order = new Map(unique.map((id, index) => [id, index]));
      return {
        artifacts: rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!).map(toBody),
        files: [...files.values()]
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
          .map(toBody),
      };
    },

    /** 内部：成果文件的内容（harness 拷进工作目录；是不是这个人的，lookup 时已经核对过） */
    async internalContent(id: string) {
      const row = await repo.find(id);
      if (!row) throw new HttpError(404, 'artifact_not_found', '没有这个成果');
      return { row, content: await store.read(row.objectKey) };
    },

    /**
     * 批注整份替换：编号不能重复，最多 50 条（契约已校验）。
     * 新引用的截图必须是这个人自己上传的；不再被引用的截图随之删除。
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

    /** 同一个话题的成果（应用的文件、模型配套的图和视频都在里面） */
    async family(ownerId: string, id: string): Promise<Artifact[]> {
      const source = await this.get(ownerId, id);
      return (await repo.listBySession(source.sessionId)).filter((row) => row.ownerId === ownerId);
    },

    /** 一个任务（一轮）的成果打包下载：包里的路径和桌面同步用的 syncPath 一样 */
    async archive(ownerId: string, runId: string, limits: ArchiveLimits) {
      const rows = await repo.list(ownerId, { runId }, LIST_LIMIT);
      if (!rows.length) throw new HttpError(404, 'artifact_not_found', '这个任务还没有成果');
      return {
        name: `${safeSegment(rows[0]!.task)}.zip`,
        content: zipArtifacts(store, rows, (row) => row.syncPath, limits),
      };
    },

    /** 下载整个应用：应用目录里的全部文件（不管是哪一轮做的），包里按 out/ 里的路径 */
    async appArchive(ownerId: string, id: string, limits: ArchiveLimits) {
      const app = (await service.get(ownerId, id)).appSpec;
      if (!app) throw new HttpError(404, 'artifact_not_found', '这不是一个应用');
      const rows = (await service.family(ownerId, id)).filter((row) =>
        row.path.startsWith(`${app.root}/`),
      );
      return {
        name: `${safeSegment(app.root)}.zip`,
        content: zipArtifacts(store, rows, (row) => row.path, limits),
      };
    },

    toBody,
  };
  return service;
}

export type ArtifactService = ReturnType<typeof createArtifactService>;
