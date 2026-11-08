// 容器拷文件进出、运行产出归档用的 tar 小工具（Docker 的 archive 接口只收发 tar）。
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { extract, pack } from 'tar-stream';

/** 容器里普通用户（镜像里的 node 用户）的 uid/gid：放进容器的文件和目录都归它，容器里的程序才能写 */
const CONTAINER_UID = 1000;

export interface StreamFile {
  path: string;
  size: number;
  sha256?: string | null;
  open(): Promise<Readable>;
}

function safePath(path: string) {
  if (
    !path ||
    // eslint-disable-next-line no-control-regex
    /[\\:\u0000-\u001f]/.test(path) ||
    path.startsWith('/') ||
    path.split('/').some((p) => !p || p === '.' || p === '..')
  )
    throw new Error('归档包含不安全路径');
  return path;
}

async function* entries(source: Readable) {
  const reader = extract();
  const pumping = pipeline(source, reader);
  void pumping.catch(() => undefined);
  try {
    for await (const entry of reader) yield entry;
    await pumping;
  } finally {
    reader.destroy();
    source.destroy();
    await pumping.catch(() => undefined);
  }
}

/** 扫描/提取时逐条消费，目录之外只接受普通文件，绝不跟随符号链接。 */
export async function scanArchive(
  source: Readable,
  maxBytes: number | undefined,
  consume?: (path: string, size: number, stream: Readable) => Promise<void>,
) {
  const files: { path: string; size: number; sha256: string }[] = [];
  const seen = new Set<string>();
  let total = 0;
  for await (const entry of entries(source)) {
    const header = entry.header;
    const name = header.name.replace(/\/$/, '');
    safePath(name);
    const path = name.split('/').slice(1).join('/');
    if (header.type === 'directory') {
      entry.resume();
      continue;
    }
    if (header.type !== 'file') throw new Error('归档包含非常规文件');
    safePath(path);
    const size = header.size ?? 0;
    total += size;
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      (maxBytes !== undefined && total > maxBytes) ||
      seen.has(path)
    )
      throw new Error('归档大小、数量或文件名不合格');
    seen.add(path);
    const hash = createHash('sha256');
    let actual = 0;
    const checked = Readable.from(
      (async function* () {
        for await (const value of entry) {
          const chunk = Buffer.from(value as Uint8Array);
          actual += chunk.length;
          if (actual > size) throw new Error('归档文件大小不一致');
          hash.update(chunk);
          yield chunk;
        }
        if (actual !== size) throw new Error('归档文件大小不一致');
      })(),
    );
    if (consume) await consume(path, size, checked);
    else
      for await (const _chunk of checked) {
        /* 只计算摘要 */
      }
    if (!checked.readableEnded)
      for await (const _chunk of checked) {
        /* 消费跳过的正文 */
      }
    files.push({ path, size, sha256: hash.digest('hex') });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function archiveFile(source: Readable, target: string): Readable {
  return Readable.from(
    (async function* () {
      let found = false;
      for await (const entry of entries(source)) {
        const path = entry.header.name.split('/').slice(1).join('/');
        if (entry.header.type === 'file' && path === target) {
          found = true;
          for await (const chunk of entry) yield chunk;
          break;
        }
        entry.resume();
      }
      if (!found) throw new Error('归档中没有这个文件');
    })(),
  );
}

/** 大素材只在真正写入 Docker 时打开。 */
export function packStreams(files: StreamFile[]): Readable {
  const archive = pack();
  void (async () => {
    const dirs = new Set<string>();
    for (const file of files) {
      safePath(file.path);
      const parts = file.path.split('/').slice(0, -1);
      for (let i = 0; i < parts.length; i++) {
        const dir = parts.slice(0, i + 1).join('/');
        if (!dirs.has(dir)) {
          dirs.add(dir);
          archive.entry({
            name: `${dir}/`,
            type: 'directory',
            mode: 0o755,
            uid: CONTAINER_UID,
            gid: CONTAINER_UID,
          });
        }
      }
      const source = await file.open();
      const hash = createHash('sha256');
      let size = 0;
      const stop = () => source.destroy();
      archive.once('close', stop);
      const check = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          size += chunk.length;
          if (size > file.size) return done(new Error('输入文件大小不一致'));
          hash.update(chunk);
          done(null, chunk);
        },
      });
      try {
        await pipeline(
          source,
          check,
          archive.entry({
            name: file.path,
            size: file.size,
            mode: 0o644,
            uid: CONTAINER_UID,
            gid: CONTAINER_UID,
          }),
        );
        if (size !== file.size || (file.sha256 && file.sha256 !== hash.digest('hex')))
          throw new Error('输入文件大小或校验和不一致');
      } finally {
        archive.off('close', stop);
        source.destroy();
      }
    }
    archive.finalize();
  })().catch((error: unknown) =>
    archive.destroy(error instanceof Error ? error : new Error(String(error))),
  );
  return Readable.from(archive);
}

export function rewriteArchive(
  source: Readable,
  prefix: string,
  keep: (path: string) => boolean,
  maxBytes: number | undefined,
  readonly = false,
): Readable {
  const archive = pack();
  archive.on('close', () => source.destroy());
  void scanArchive(source, maxBytes, async (path, size, stream) => {
    if (!keep(path)) {
      stream.resume();
      return;
    }
    const name = safePath(`${prefix}/${path}`);
    const parts = name.split('/').slice(0, -1);
    for (let i = 0; i < parts.length; i++)
      archive.entry({
        name: `${parts.slice(0, i + 1).join('/')}/`,
        type: 'directory',
        mode: readonly ? 0o550 : 0o755,
        uid: readonly ? 0 : CONTAINER_UID,
        gid: CONTAINER_UID,
      });
    await pipeline(
      stream,
      archive.entry({
        name,
        size,
        mode: readonly ? 0o440 : 0o644,
        uid: readonly ? 0 : CONTAINER_UID,
        gid: CONTAINER_UID,
      }),
    );
  })
    .then(() => archive.finalize())
    .catch((error: unknown) =>
      archive.destroy(error instanceof Error ? error : new Error(String(error))),
    );
  return Readable.from(archive);
}

/**
 * 把若干文件打成 tar 包（路径相对于解包目录）。上级目录也作为条目写进去，
 * 否则 Docker 会以 root 身份建这些目录，容器里的普通用户就写不进去了。
 */
export async function packFiles(files: { path: string; content: Buffer }[]): Promise<Buffer> {
  const owner = { uid: CONTAINER_UID, gid: CONTAINER_UID };
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
export async function extractFiles(
  tar: Buffer | Readable,
): Promise<{ path: string; content: Buffer }[]> {
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
  if (Buffer.isBuffer(tar)) reader.end(tar);
  else tar.pipe(reader);
  await done;
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** 列出 tar 包里的文件和大小（路径规则同 extractFiles）。 */
export async function listFiles(tar: Buffer): Promise<{ path: string; size: number }[]> {
  return (await scanArchive(Readable.from([tar]), tar.length)).map(({ path, size }) => ({
    path,
    size,
  }));
}
