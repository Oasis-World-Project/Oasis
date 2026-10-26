// 由 harness 通过独立 Docker exec 执行；输出来自受信脚本，不读取应用写出的自检结论。
import { readdir, lstat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import process from 'node:process';
const exec = promisify(execFile);
const root = process.argv[1];
const limits = JSON.parse(process.argv[2]);
const start = Date.now();
const result = { files: [], unchecked: [] };
const media = /\.(wav|mp3|m4a|flac|ogg|webm|aac)$/i;
async function walk(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (item.name.startsWith('.')) continue;
    const file = path.join(dir, item.name);
    if (item.isDirectory()) await walk(file);
    else if (item.isFile() && media.test(item.name)) {
      const relative = path.relative(root, file).split(path.sep).join('/');
      if (result.files.length >= limits.files || Date.now() - start >= limits.timeoutMs) {
        result.unchecked.push(relative);
        continue;
      }
      const report = { path: relative, valid: false };
      try {
        const size = (await lstat(file)).size;
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(file)) hash.update(chunk);
        report.size = size;
        report.sha256 = hash.digest('hex');
        const timeout = Math.max(1, Math.min(30_000, limits.timeoutMs - (Date.now() - start)));
        const options = {
          timeout,
          maxBuffer: 1024 * 1024,
          env: { PATH: process.env.PATH, LC_ALL: 'C' },
        };
        const probe = await exec(
          'ffprobe',
          [
            '-v',
            'error',
            '-protocol_whitelist',
            'file,pipe',
            '-show_format',
            '-show_streams',
            '-of',
            'json',
            file,
          ],
          options,
        );
        const info = JSON.parse(probe.stdout);
        const audio = info.streams?.find((stream) => stream.codec_type === 'audio');
        const durationMs = Math.round(Number(info.format?.duration) * 1000);
        if (
          !audio ||
          !Number.isFinite(durationMs) ||
          durationMs <= 0 ||
          durationMs > limits.durationMs
        )
          throw new Error('音轨或时长不合格');
        const decoded = await exec(
          'ffmpeg',
          [
            '-nostdin',
            '-hide_banner',
            '-xerror',
            '-protocol_whitelist',
            'file,pipe',
            '-i',
            file,
            '-map',
            '0:a:0',
            '-af',
            'volumedetect',
            '-f',
            'null',
            '-',
          ],
          options,
        );
        const peak = /max_volume:\s*(-?[\d.]+) dB/.exec(decoded.stderr);
        Object.assign(report, {
          valid: true,
          durationMs,
          codec: String(audio.codec_name),
          sampleRate: Number(audio.sample_rate),
          channels: Number(audio.channels),
          ...(peak ? { peakDb: Number(peak[1]) } : {}),
        });
      } catch {
        report.error = '音频探测或完整解码失败/超时';
      }
      result.files.push(report);
    }
  }
}
try {
  await walk(root);
  process.stdout.write(JSON.stringify(result));
} catch {
  process.stdout.write(JSON.stringify({ files: [], unchecked: ['音频检查进程未完成'] }));
}
