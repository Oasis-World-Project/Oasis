// 成果：对话里一轮结束时，把 out/ 里新增和改过的文件从 harness 复制进画布；给前端列出、读取。
import { randomUUID } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { once } from 'node:events';
import { Zip, ZipPassThrough } from 'fflate';
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
  topic: row.topic,
  runId: row.runId,
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

  /** 这个话题在同步文件夹里用哪个目录：已经登记过的沿用，没有就用话题名，和别的话题重名就加序号 */
  async function topicDir(run: RegisterRunArtifactsBody, existing: Artifact[]): Promise<string> {
    const used = existing[0]?.syncPath.split('/')[0];
    if (used) return used;
    const taken = new Set(
      (await repo.syncDirs(run.ownerId, run.sessionId)).map((d) => d.toLowerCase()),
    );
    return uniqueName(safeSegment(run.topic), taken, false);
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
      topic: run.topic,
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
     * 对话里一轮结束了：out/ 里新增的文件登记进画布，改过的原地换成新版（链接和同步路径不变；
     * 批注针对的是旧内容，连同截图一起清掉）；内容没变的不动。重复调用不会重复登记。
     * 返回这一轮做出或改了的成果。
     */
    async registerRun(run: RegisterRunArtifactsBody): Promise<ArtifactBody[]> {
      const existing = await repo.listBySession(run.sessionId);
      if (existing.some((row) => row.ownerId !== run.ownerId))
        throw new HttpError(409, 'session_owner', '这个话题不属于这个用户');
      const byPath = new Map(existing.map((row) => [row.path, row]));
      const changed = new Set<string>();
      for (const file of run.outputs) {
        const old = byPath.get(file.path);
        if (!old) continue;
        // 这一轮已经登记过（重复调用）
        if (old.runId === run.runId) {
          changed.add(old.id);
          continue;
        }
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
        });
        await dropFrames(run.ownerId, frames);
        changed.add(old.id);
        logger.info({ runId: run.runId, path: file.path }, '成果已换成新版');
      }
      const added = run.outputs.filter((file) => !byPath.has(file.path));
      const dir = added.length ? await topicDir(run, existing) : '';
      const takenInDir = new Set(
        existing.map((row) => row.syncPath.slice(dir.length + 1).toLowerCase()),
      );
      for (const file of added) {
        const row = await copyFile(run, file);
        const relative = uniqueName(safePath(file.path), takenInDir, true);
        takenInDir.add(relative.toLowerCase());
        if (await repo.insert({ ...row, syncPath: `${dir}/${relative}`, replacesSha256: null })) {
          changed.add(row.id);
          logger.info({ runId: run.runId, path: file.path }, '成果已登记进画布');
        }
      }
      await registerApplications(run.sessionId);
      // 按这一轮交出文件的顺序返回
      const order = new Map(run.outputs.map((file, index) => [file.path, index]));
      return (await repo.listBySession(run.sessionId))
        .filter((row) => changed.has(row.id))
        .sort((a, b) => order.get(a.path)! - order.get(b.path)!)
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

    /** 一个话题的成果打包下载：和桌面同步使用完全相同的文件集合与 syncPath。 */
    async archive(ownerId: string, sessionId: string, limits: { bytes: number; files: number }) {
      const rows = (await repo.listBySession(sessionId)).filter((row) => row.ownerId === ownerId);
      if (!rows.length) throw new HttpError(404, 'artifact_not_found', '这个话题还没有成果');
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
        name: `${safeSegment(rows[0]!.topic)}.zip`,
        content,
      };
    },

    toBody,
  };
  return service;
}

export type ArtifactService = ReturnType<typeof createArtifactService>;
