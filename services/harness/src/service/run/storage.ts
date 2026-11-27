// 一轮和外面之间的文件：每轮结束列出 out/ 的清单（路径、大小、摘要）记在这一轮上——文件留在工作目录里，
// 画布登记成果时要哪个再来取哪个（outputs.ts），平台不另存一份；开跑时把用户随消息发的文件、要改的
// 成果放进沙箱。每轮结束还把 dsh 的会话记录存一版在我们这边（撤回最后一句时退回上一版）。
import { Readable } from 'node:stream';
import { ArtifactLookupResult, UploadLookupResult } from '@oasis/contracts/canvas';
import {
  listFiles,
  onlyFile,
  packFiles,
  readLimited,
  rewriteArchive,
  scanArchive,
} from '@oasis/service-kit';
import { isSessionArchive, SANDBOX_PATHS } from '../../adapter/dsh.ts';
import type { Executor } from '../../executor/executor.ts';
import { StopRun, type RunContext } from './shared.ts';

/**
 * 给成果里的 Word、PPT 各配一份同名 PDF，画布按 PDF 预览。工作目录一轮轮接着用，所以同名 PDF
 * 比原件新就不动（AI 自己导出的、上一轮配好且原件没再改的），原件改过就重新转。
 * 以前只有 PPT 靠 AI 自觉配，Word 转成网页预览，版式和图片大小都丢了（2026-11-13 简报）。
 * 用沙箱里装好的 LibreOffice；单个文件最多转 2 分钟，转不了就算了，不挡产出。
 * soffice 会读标准输入，不重定向的话会吃掉 find 列出的其余文件名（实测只转了一部分）。
 */
const companionPdfs = (dir: string) =>
  `cd ${dir} 2>/dev/null || exit 0
find . -type f \\( -iname '*.docx' -o -iname '*.pptx' \\) ! -path '*/.*' | while IFS= read -r f; do
  [ "\${f%.*}.pdf" -nt "$f" ] && continue
  timeout 120 soffice --headless --norestore --convert-to pdf --outdir "$(dirname "$f")" "$f" </dev/null >/dev/null 2>&1 || true
done
exit 0`;

/** 一份会话记录最多存多大：再大就不存这一版（撤回时退不回这一轮结束的地方） */
const SESSION_MAX_BYTES = 64 * 1024 * 1024;

/**
 * 这份会话现在的 dsh 会话记录，打成能直接解到 dsh 用户目录下的 tar 包（sessions/<dsh 按工作目录起的
 * 目录>/<会话 ID>/session.*）。它引用的附件不带：按内容摘要存、只增不减，留在原地就行。
 * 还没有会话记录返回 undefined。
 */
async function sessionArchive(executor: Executor, workspaceId: string) {
  const mine = (path: string) => isSessionArchive(path, workspaceId);
  if (executor.listWorkspace) {
    // 文件不在平台这边（用户电脑、E2B）：先列出来，只取会话记录，不把附件搬一遍
    const files: { path: string; content: Buffer }[] = [];
    for (const { path } of await executor.listWorkspace(workspaceId, SANDBOX_PATHS.sessions)) {
      if (!mine(path)) continue;
      const source = await executor.readWorkspace(workspaceId, `${SANDBOX_PATHS.sessions}/${path}`);
      if (!source) return undefined;
      const file = await onlyFile(source, SESSION_MAX_BYTES);
      files.push({
        path: `sessions/${path}`,
        content: await readLimited(file.content, SESSION_MAX_BYTES),
      });
    }
    return files.length ? packFiles(files) : undefined;
  }
  const source = await executor.readWorkspace(workspaceId, SANDBOX_PATHS.sessions);
  if (!source) return undefined;
  const tar = await readLimited(
    rewriteArchive(source, 'sessions', mine, undefined),
    SESSION_MAX_BYTES,
  );
  return (await listFiles(tar)).length ? tar : undefined;
}

export function createStorage(
  ctx: RunContext,
): Pick<RunContext, 'save' | 'materialFiles' | 'restoreSession'> {
  const { deps } = ctx;

  return {
    async save(row, sandbox) {
      await sandbox
        ?.exec(['sh', '-c', companionPdfs(SANDBOX_PATHS.outputs)])
        .catch((err: unknown) =>
          deps.logger.warn({ runId: row.id, err }, '给 Word/PPT 配 PDF 没做完，照常记产出'),
        );
      const executor = ctx.executorOf(row);
      const workspaceId = row.sessionId ?? row.id;
      // 会话记录存一版：没存成不挡这一轮（只是撤回最后一句时退不回这里）
      await sessionArchive(executor, workspaceId)
        .then((archive) => archive && deps.repo.saveVersion(row, archive))
        .catch((err: unknown) =>
          deps.logger.warn({ runId: row.id, err }, '这一轮结束时的会话记录没存下来'),
        );
      if (executor.listWorkspace)
        return { outputs: await executor.listWorkspace(workspaceId, SANDBOX_PATHS.outputs) };
      const archive = await executor.readWorkspace(workspaceId, SANDBOX_PATHS.outputs);
      return { outputs: archive ? await scanArchive(archive, deps.outputMaxBytes) : [] };
    },

    async restoreSession(row, sandbox) {
      if (!row.continueFrom) return;
      const version = await deps.repo.version(row.continueFrom);
      if (!version?.restore) return;
      await sandbox.put(SANDBOX_PATHS.dshHome, version.archive);
      await deps.repo.setRestore(row.continueFrom, false);
    },

    /** 用户发的文件和要改的成果：路径已由 conversation 定好、契约校验过 */
    async materialFiles(materials, runId, ownerId) {
      if (!materials.length) return [];
      const metadata = new Map<string, { size: number; sha256?: string | null | undefined }>();
      // 按是谁名下的分开查（群里的文件在传的人、群主名下，不在这一轮替他做的那个人名下）
      const uploadIds = new Map<string, string[]>();
      const artifactIds = new Map<string, string[]>();
      for (const m of materials) {
        const owner = m.ownerId ?? ownerId;
        const [ids, id] = 'uploadId' in m ? [uploadIds, m.uploadId] : [artifactIds, m.artifactId];
        ids.set(owner, [...(ids.get(owner) ?? []), id]);
      }
      // 查询一次最多 20 个（几条消息合成一轮时可能更多）
      for (const [owner, ids] of uploadIds)
        for (let i = 0; i < ids.length; i += 20) {
          const { uploads } = await deps.canvas.json('POST', '/internal/uploads/lookup', {
            body: { ownerId: owner, ids: ids.slice(i, i + 20) },
            schema: UploadLookupResult,
            requestId: runId,
          });
          for (const file of uploads) metadata.set(file.id, file);
        }
      for (const [owner, ids] of artifactIds) {
        const { artifacts } = await deps.canvas.json('POST', '/internal/artifacts/lookup', {
          body: { ownerId: owner, ids },
          schema: ArtifactLookupResult,
          requestId: runId,
        });
        for (const file of artifacts) metadata.set(file.id, file);
      }
      let total = 0;
      return materials.map((m) => {
        const [id, kind] = 'uploadId' in m ? [m.uploadId, 'uploads'] : [m.artifactId, 'artifacts'];
        const info = metadata.get(id);
        if (!info) throw new Error('素材元数据缺失');
        total += info.size;
        if (deps.materialsMaxBytes !== undefined && total > deps.materialsMaxBytes)
          throw new StopRun('failed', '素材加起来超过运行上限');
        return {
          path: m.path,
          size: info.size,
          sha256: info.sha256,
          open: async () => {
            const response = await deps.canvas.stream(
              'GET',
              `/internal/${kind}/${encodeURIComponent(id)}/content`,
              {
                requestId: runId,
                signal: AbortSignal.timeout(deps.transferTimeoutMs ?? 600_000),
              },
            );
            if (!response.body) throw new Error('素材没有内容流');
            return Readable.fromWeb(response.body);
          },
        };
      });
    },
  };
}
