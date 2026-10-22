// 沙箱拷文件进出用的 tar 小工具（Docker 的 archive 接口只收发 tar）。
import type { Readable } from 'node:stream';
import { extract, pack } from 'tar-stream';

/** 沙箱用户（镜像里的 node 用户）的 uid/gid：放进沙箱的文件和目录都归它，dsh 才能写 */
const SANDBOX_UID = 1000;

/**
 * 把若干文件打成 tar 包（路径相对于解包目录）。上级目录也作为条目写进去，
 * 否则 Docker 会以 root 身份建这些目录，沙箱用户就写不进去了。
 */
export async function packFiles(files: { path: string; content: Buffer }[]): Promise<Buffer> {
  const owner = { uid: SANDBOX_UID, gid: SANDBOX_UID };
  const dirs = new Set<string>();
  for (const file of files) {
    const parts = file.path.split('/').slice(0, -1);
    parts.forEach((_, i) => dirs.add(parts.slice(0, i + 1).join('/')));
  }
  const archive = pack();
  for (const dir of [...dirs].sort()) {
    archive.entry({ name: `${dir}/`, type: 'directory', mode: 0o755, ...owner });
  }
  for (const file of files) {
    archive.entry(
      { name: file.path, size: file.content.length, mode: 0o644, ...owner },
      file.content,
    );
  }
  archive.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of archive) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** 把流读成 Buffer；超过 maxBytes 就中止并报错。 */
export async function readLimited(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += (chunk as Buffer).length;
    if (total > maxBytes) {
      stream.destroy();
      throw new Error(`产出超过上限 ${Math.round(maxBytes / 1024 / 1024)} MB`);
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * 取出 tar 包里的文件（不含目录）。Docker 取出的 tar 以被取目录的名字开头（如 out/），
 * 这里去掉这一层，得到相对路径。
 */
export async function extractFiles(tar: Buffer): Promise<{ path: string; content: Buffer }[]> {
  const files: { path: string; content: Buffer }[] = [];
  const reader = extract();
  const done = new Promise<void>((resolve, reject) => {
    reader.on('entry', (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: unknown) => chunks.push(chunk as Buffer));
      stream.on('end', () => {
        const path = header.name.split('/').slice(1).join('/');
        if (header.type === 'file' && path) files.push({ path, content: Buffer.concat(chunks) });
        next();
      });
    });
    reader.on('finish', resolve);
    reader.on('error', reject);
  });
  reader.end(tar);
  await done;
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** 列出 tar 包里的文件和大小（路径规则同 extractFiles）。 */
export async function listFiles(tar: Buffer): Promise<{ path: string; size: number }[]> {
  return (await extractFiles(tar)).map((f) => ({ path: f.path, size: f.content.length }));
}
