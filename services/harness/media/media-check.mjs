// 由 harness 通过独立 Docker exec 执行；输出来自受信脚本，不读取应用写出的自检结论。
import { readdir, lstat, readFile } from 'node:fs/promises';
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
const media = /\.(wav|mp3|m4a|flac|ogg|webm|aac|mp4|mov|mkv|avi|mlt|srt)$/i;
function intervals(log, kind) {
  if (kind === 'black')
    return [...log.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].slice(0, 200).map((m) => ({
      startMs: Math.round(Number(m[1]) * 1000),
      endMs: Math.round(Number(m[2]) * 1000),
    }));
  const values = [];
  let startMs;
  for (const match of log.matchAll(/silence_(start|end):\s*([\d.]+)/g)) {
    if (match[1] === 'start') startMs = Math.round(Number(match[2]) * 1000);
    else if (startMs !== undefined) {
      values.push({ startMs, endMs: Math.round(Number(match[2]) * 1000) });
      startMs = undefined;
    }
  }
  return values.slice(0, 200);
}
function subtitles(value) {
  let end = 0,
    count = 0;
  if (!value.trim()) return 0;
  const time = (h, m, s, ms) => {
    if (Number(m) > 59 || Number(s) > 59) throw new Error('字幕时间无效');
    return (Number(h) * 3600 + Number(m) * 60 + Number(s)) * 1000 + Number(ms);
  };
  for (const block of value
    .replaceAll('\r', '')
    .trim()
    .split(/\n\s*\n/)) {
    const match =
      /^\d+\n(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})\n([\s\S]+)$/.exec(
        block,
      );
    if (!match) throw new Error('字幕结构无效');
    const begin = time(...match.slice(1, 5)),
      finish = time(...match.slice(5, 9));
    if (begin < end || finish <= begin || finish > limits.durationMs)
      throw new Error('字幕时间越界或重叠');
    end = finish;
    count++;
    if (count > 1000) throw new Error('字幕条数超限');
  }
  return count;
}
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
        if (/\.mlt$/i.test(file)) {
          const checked = JSON.parse((await exec('oasis-media', ['check', file], options)).stdout);
          Object.assign(report, {
            valid: true,
            durationMs: Math.round((checked.durationFrames / checked.profile.fps) * 1000),
            width: checked.profile.width,
            height: checked.profile.height,
            frameRate: checked.profile.fps,
            projectSources: checked.sources,
            subtitleCues: checked.subtitleCues,
          });
          result.files.push(report);
          continue;
        }
        if (/\.srt$/i.test(file)) {
          if (size > 1024 * 1024) throw new Error('字幕过大');
          Object.assign(report, {
            valid: true,
            subtitleCues: subtitles(await readFile(file, 'utf8')),
          });
          result.files.push(report);
          continue;
        }
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
        const video = info.streams?.find(
          (stream) => stream.codec_type === 'video' && !stream.disposition?.attached_pic,
        );
        if (/\.(mp4|mov|mkv|avi)$/i.test(file) && !video) throw new Error('视频容器没有可播放画面');
        const durationMs = Math.round(Number(info.format?.duration) * 1000);
        if (
          (!audio && !video) ||
          !Number.isFinite(durationMs) ||
          durationMs <= 0 ||
          durationMs > limits.durationMs
        )
          throw new Error('音轨或时长不合格');
        if (
          video &&
          (!(video.width > 0 && video.height > 0) || video.width * video.height > 25000000)
        )
          throw new Error('视频尺寸超限');
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
            ...(video ? ['-map', '0:v:0', '-vf', 'blackdetect=d=0.3:pix_th=0.1'] : []),
            ...(audio
              ? ['-map', '0:a:0', '-af', 'volumedetect,silencedetect=noise=-50dB:d=0.5']
              : []),
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
          codec: String(video?.codec_name ?? audio?.codec_name),
          ...(audio
            ? { sampleRate: Number(audio.sample_rate), channels: Number(audio.channels) }
            : {}),
          ...(peak ? { peakDb: Number(peak[1]) } : {}),
        });
        if (audio) {
          report.audioCodec = audio.codec_name;
          if (Number.isFinite(Number(audio.duration))) {
            report.audioDurationMs = Math.round(Number(audio.duration) * 1000);
            report.avDeltaMs = durationMs - report.audioDurationMs;
          }
          report.silentIntervals = intervals(decoded.stderr, 'silence');
        }
        if (video) {
          const [n, d] = String(video.avg_frame_rate).split('/').map(Number);
          if (!Number.isFinite(n / d) || n / d <= 0 || n / d > 120)
            throw new Error('视频帧率无效或超限');
          Object.assign(report, {
            width: video.width,
            height: video.height,
            frameRate: n / d,
            blackIntervals: intervals(decoded.stderr, 'black'),
            samples: [],
          });
          for (const atMs of [0, Math.floor(durationMs / 2), Math.max(0, durationMs - 100)]) {
            const sample = await exec(
              'ffmpeg',
              [
                '-v',
                'error',
                '-protocol_whitelist',
                'file,pipe',
                '-ss',
                String(atMs / 1000),
                '-i',
                file,
                '-frames:v',
                '1',
                '-vf',
                'scale=320:-2',
                '-f',
                'image2pipe',
                '-vcodec',
                'png',
                'pipe:1',
              ],
              {
                ...options,
                timeout: Math.max(1, limits.timeoutMs - (Date.now() - start)),
                encoding: 'buffer',
              },
            );
            if (!sample.stdout.length) throw new Error('视频采样帧缺失');
            report.samples.push({
              atMs,
              sha256: createHash('sha256').update(sample.stdout).digest('hex'),
            });
          }
        }
      } catch {
        report.valid = false;
        report.error = '媒体探测、工程/字幕校验或完整解码失败/超时';
      }
      result.files.push(report);
    }
  }
}
try {
  await walk(root);
  process.stdout.write(JSON.stringify(result));
} catch {
  process.stdout.write(JSON.stringify({ files: [], unchecked: ['媒体检查进程未完成'] }));
}
