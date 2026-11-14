// 沙箱和对象存储之间搬文件：每轮结束把 out/ 打包存进对象存储（画布从这里登记成果），
// 开跑时把用户随消息发的文件、要改的成果放进沙箱。会话和工作目录在持久卷里，不经对象存储。
import { PassThrough, Readable } from 'node:stream';
import { ArtifactLookupResult, UploadLookupResult } from '@oasis/contracts/canvas';
import { scanArchive } from '@oasis/service-kit';
import { SANDBOX_PATHS } from '../../adapter/dsh.ts';
import type { Sandbox } from '../../executor/executor.ts';
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

export function createStorage(ctx: RunContext): Pick<RunContext, 'save' | 'materialFiles'> {
  const { deps } = ctx;
  const { store } = deps;

  /** 把沙箱里的目录打包存进对象存储；目录不存在或为空时返回 undefined */
  async function archive(sandbox: Pick<Sandbox, 'readArchive'>, path: string, key: string) {
    const stream = await sandbox.readArchive(path);
    if (!stream) return undefined;
    const upload = new PassThrough();
    const index = new PassThrough();
    const fail = (error: Error) => {
      stream.destroy(error);
      upload.destroy(error);
      index.destroy(error);
    };
    stream.on('error', fail);
    const storing = store.putStream(key, upload, 'application/x-tar', {
      maxBytes: deps.outputMaxBytes,
    });
    const scanning = scanArchive(index, deps.outputMaxBytes);
    stream.pipe(upload);
    stream.pipe(index);
    try {
      const [, files] = await Promise.all([storing, scanning]);
      if (!files.length) {
        await store.delete(key);
        return undefined;
      }
      return { key, files };
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
      await Promise.allSettled([storing, scanning]);
      await store.delete(key);
      throw error;
    }
  }

  return {
    async save(sandbox, id, options = {}) {
      if (options.companions)
        await sandbox
          .exec?.(['sh', '-c', companionPdfs(SANDBOX_PATHS.outputs)])
          .catch((err: unknown) =>
            deps.logger.warn({ runId: id, err }, '给 Word/PPT 配 PDF 没做完，照常存产出'),
          );
      return { outputs: await archive(sandbox, SANDBOX_PATHS.outputs, `runs/${id}/outputs.tar`) };
    },

    /** 用户发的文件和要改的成果：路径已由 conversation 定好、契约校验过 */
    async materialFiles(materials, runId, ownerId) {
      if (!materials.length) return [];
      const metadata = new Map<string, { size: number; sha256?: string | null | undefined }>();
      const uploadIds = materials.flatMap((m) => ('uploadId' in m ? [m.uploadId] : []));
      const artifactIds = materials.flatMap((m) => ('artifactId' in m ? [m.artifactId] : []));
      // 查询一次最多 20 个（几条消息合成一轮时可能更多）
      for (let i = 0; i < uploadIds.length; i += 20) {
        const { uploads } = await deps.canvas.json('POST', '/internal/uploads/lookup', {
          body: { ownerId, ids: uploadIds.slice(i, i + 20) },
          schema: UploadLookupResult,
          requestId: runId,
        });
        for (const file of uploads) metadata.set(file.id, file);
      }
      if (artifactIds.length) {
        const { artifacts } = await deps.canvas.json('POST', '/internal/artifacts/lookup', {
          body: { ownerId, ids: artifactIds },
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
