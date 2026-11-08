// oasis-op：沙箱里的本地确定性操作（ADR 0025）——拼视频、裁剪、抽帧、配音轨、拼音频、转格式，都用 ffmpeg。
// 不调外部供应商、不花工具钱，只占沙箱算力。工具目录里叫 op.*，参数定义在 packages/contracts/src/ops.ts
// （规划门、工具目录和这里共用一份）。工具节点的步骤执行器和节点里的 AI 都用它：
//   oasis-op list                                                     看有哪些操作
//   oasis-op video.concat --in in/镜头/1.mp4,in/镜头/2.mp4 --out out/成片.mp4
// 镜像里按仓库的相对位置放（infra/images/harness-sandbox-base/Dockerfile），import 路径两边一致。
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { OPS, type LocalOp } from '../../../packages/contracts/src/ops.ts';
import { checkToolArgs, listOf } from '../../../packages/contracts/src/tool-args.ts';

type Args = Record<string, string>;

const say = (text: string) => process.stdout.write(`${text}\n`);

/** 解析 --名字 值；--out 单独返回 */
export function parseOpArgs(argv: string[]): { args: Args; out?: string } {
  const args: Args = {};
  let out: string | undefined;
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] ?? '';
    const value = argv[i + 1];
    if (!flag.startsWith('--')) throw new Error(`看不懂参数「${flag}」，参数要写成 --名字 值`);
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} 后面缺少值`);
    if (flag === '--out') out = value;
    else args[flag.slice(2)] = value;
  }
  return { args, ...(out ? { out } : {}) };
}

/** 跑一个命令；失败时带上它最后几行输出 */
function exec(bin: string, argv: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (text: string) => {
      stdout += text;
    });
    child.stderr.setEncoding('utf8').on('data', (text: string) => {
      stderr = (stderr + text).slice(-4000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else {
        const tail = stderr.trim().split('\n').slice(-6).join('\n');
        reject(new Error(`${bin} 没做成（退出码 ${code}）：${tail || '没有输出'}`));
      }
    });
  });
}

const ffmpeg = (argv: string[]) =>
  exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...argv]);

export interface Probe {
  duration: number;
  video?: { width: number; height: number; fps: number; codec: string };
  audio: boolean;
}

/** ffprobe 的结果 → 时长、画面、有没有声音 */
export function probeOf(json: string): Probe {
  const info = JSON.parse(json) as {
    streams?: {
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
      duration?: string;
    }[];
    format?: { duration?: string };
  };
  const streams = info.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video' && s.width && s.height);
  const [num, den] = (video?.r_frame_rate ?? '30/1').split('/').map(Number);
  const rate = num && den ? num / den : 30;
  const duration = Number(info.format?.duration ?? video?.duration ?? 0);
  return {
    duration: Number.isFinite(duration) ? duration : 0,
    ...(video
      ? {
          video: {
            width: video.width!,
            height: video.height!,
            fps: Math.min(60, Math.max(1, Math.round(rate * 1000) / 1000)),
            codec: video.codec_name ?? '',
          },
        }
      : {}),
    audio: streams.some((s) => s.codec_type === 'audio'),
  };
}

const probe = async (file: string) =>
  probeOf(
    await exec('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_streams',
      '-show_format',
      file,
    ]),
  );

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const seconds = (n: number) => `${Math.round(n * 10) / 10} 秒`;

/** 按 --out 的后缀选编码 */
function videoCodec(ext: string): string[] {
  if (ext === '.webm')
    return [
      ...['-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-deadline', 'realtime'],
      ...['-cpu-used', '8', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-b:a', '128k'],
    ];
  return [
    ...['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p'],
    ...['-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart'],
  ];
}
const AUDIO_CODECS: Record<string, string[]> = {
  '.mp3': ['-c:a', 'libmp3lame', '-q:a', '2'],
  '.wav': ['-c:a', 'pcm_s16le'],
  '.m4a': ['-c:a', 'aac', '-b:a', '192k'],
  '.ogg': ['-c:a', 'libvorbis', '-q:a', '5'],
  '.flac': ['-c:a', 'flac'],
};
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp'];
/** 统一成 48 kHz 立体声，拼接、混音前都要 */
const NORMAL_AUDIO = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';

/** 画面缩放：只写一边按比例，两边都写就放进这个框里（不变形） */
function scaleOf(args: Args): string | undefined {
  const width = args.width ? even(Number(args.width)) : undefined;
  const height = args.height ? even(Number(args.height)) : undefined;
  if (width && height)
    return `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2`;
  if (width) return `scale=${width}:-2`;
  if (height) return `scale=-2:${height}`;
  return undefined;
}

type Run = (args: Args, out: string, temp: string) => Promise<string>;

const OPERATIONS: Record<string, Run> = {
  async 'video.concat'(args, out, temp) {
    const inputs = (listOf(args.in) ?? []).map(String);
    const probes = await Promise.all(inputs.map(probe));
    probes.forEach((p, i) => {
      if (!p.video) throw new Error(`${inputs[i]} 里没有画面`);
    });
    const first = probes[0]!.video!;
    const width = even(Number(args.width ?? first.width));
    const height = even(Number(args.height ?? first.height));
    const fps = Number(args.fps ?? first.fps);
    const sound = probes.some((p) => p.audio);
    const filters: string[] = [];
    const chain: string[] = [];
    probes.forEach((p, i) => {
      filters.push(
        `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
          `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},format=yuv420p[v${i}]`,
      );
      if (!sound) return chain.push(`[v${i}]`);
      // 没有声音的段补静音；每段的声音按画面长度补齐或截掉，拼起来不错位
      const length = Math.max(p.duration, 0.04);
      filters.push(
        p.audio
          ? `[${i}:a]${NORMAL_AUDIO},apad,atrim=0:${length}[a${i}]`
          : `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:${length},${NORMAL_AUDIO}[a${i}]`,
      );
      chain.push(`[v${i}][a${i}]`);
    });
    filters.push(
      `${chain.join('')}concat=n=${inputs.length}:v=1:a=${sound ? 1 : 0}[v]${sound ? '[a]' : ''}`,
    );
    await ffmpeg([
      ...inputs.flatMap((file) => ['-i', file]),
      ...['-filter_complex', filters.join(';'), '-map', '[v]'],
      ...(sound ? ['-map', '[a]'] : []),
      ...videoCodec(extname(out).toLowerCase()),
      temp,
    ]);
    const total = probes.reduce((sum, p) => sum + p.duration, 0);
    return `拼好了 ${inputs.length} 段视频，共约 ${seconds(total)}（${width}×${height}，${fps} fps${sound ? '' : '，没有声音'}）。`;
  },

  async 'video.trim'(args, out, temp) {
    const start = Number(args.start);
    if (args.end !== undefined && args.duration !== undefined)
      throw new Error('end 和 duration 只写一个');
    const end = args.end === undefined ? undefined : Number(args.end);
    if (end !== undefined && end <= start) throw new Error('end 要大于 start');
    const source = await probe(args.in!);
    if (!source.video) throw new Error(`${args.in} 里没有画面`);
    if (source.duration && start >= source.duration)
      throw new Error(`视频只有 ${seconds(source.duration)}，从第 ${start} 秒开始就没有内容了`);
    // -ss 放在 -i 后面：逐帧解码到起点，切点精确到帧
    const length = end !== undefined ? end - start : args.duration;
    await ffmpeg([
      ...['-i', args.in!, '-ss', String(start)],
      ...(length !== undefined ? ['-t', String(length)] : []),
      ...['-map', '0:v:0', '-map', '0:a:0?'],
      ...videoCodec(extname(out).toLowerCase()),
      temp,
    ]);
    const got = (await probe(temp)).duration;
    return `截好了：从第 ${start} 秒起，共 ${seconds(got)}。`;
  },

  async 'video.frames'(args, out, temp) {
    if (args.every !== undefined && args.at !== undefined) throw new Error('every 和 at 只写一个');
    const source = await probe(args.in!);
    if (!source.video) throw new Error(`${args.in} 里没有画面`);
    const ext = args.format === 'jpg' ? 'jpg' : 'png';
    const quality = ext === 'jpg' ? ['-q:v', '2'] : [];
    await mkdir(temp, { recursive: true });
    if (args.at !== undefined) {
      const times = (listOf(args.at) ?? []).map(Number);
      for (const [i, time] of times.entries()) {
        if (source.duration && time >= source.duration)
          throw new Error(`视频只有 ${seconds(source.duration)}，第 ${time} 秒没有画面`);
        await ffmpeg([
          ...['-ss', String(time), '-i', args.in!, '-frames:v', '1', ...quality],
          join(temp, `frame-${String(i + 1).padStart(4, '0')}.${ext}`),
        ]);
      }
    } else {
      const every = Number(args.every ?? 1);
      const max = Number(args.max ?? 100);
      await ffmpeg([
        ...['-i', args.in!, '-vf', `fps=1/${every}`, '-frames:v', String(max), ...quality],
        join(temp, `frame-%04d.${ext}`),
      ]);
    }
    const count = (await readdir(temp)).length;
    if (!count) throw new Error('一张画面也没抽到');
    return `抽了 ${count} 张画面，存在 ${out}/（frame-0001.${ext} 起）。`;
  },

  async 'video.audio'(args, out, temp) {
    const video = await probe(args.video!);
    if (!video.video) throw new Error(`${args.video} 里没有画面`);
    const audio = await probe(args.audio!);
    if (!audio.audio) throw new Error(`${args.audio} 里没有声音`);
    const volume = Number(args.volume ?? 1);
    const mix = args.mode === 'mix' && video.audio;
    const added = `[1:a]volume=${volume},${NORMAL_AUDIO},apad`;
    const filter = mix
      ? `${added}[x];[0:a]${NORMAL_AUDIO},apad[o];[o][x]amix=inputs=2:duration=first:normalize=0[a]`
      : `${added}[a]`;
    const ext = extname(out).toLowerCase();
    // 画面不用重新编码时直接复制（同样的容器、H.264）
    const copy =
      ext === extname(args.video!).toLowerCase() && video.video.codec === 'h264' && ext !== '.webm';
    const codec = videoCodec(ext);
    await ffmpeg([
      ...['-i', args.video!, '-i', args.audio!, '-filter_complex', filter],
      // 成片按画面的长度：补上的静音不会让它变长
      ...['-map', '0:v:0', '-map', '[a]'],
      ...(video.duration ? ['-t', String(video.duration)] : ['-shortest']),
      ...(copy ? ['-c:v', 'copy', ...codec.slice(codec.indexOf('-c:a'))] : codec),
      temp,
    ]);
    return `${mix ? '把声音混进了原声' : args.mode === 'mix' ? '原片没有声音，直接配上了' : '换上了新的声音'}，成片 ${seconds(video.duration)}。`;
  },

  async 'audio.concat'(args, out, temp) {
    const inputs = (listOf(args.in) ?? []).map(String);
    const probes = await Promise.all(inputs.map(probe));
    probes.forEach((p, i) => {
      if (!p.audio) throw new Error(`${inputs[i]} 里没有声音`);
    });
    const filters = inputs.map((_, i) => `[${i}:a]${NORMAL_AUDIO}[a${i}]`);
    filters.push(`${inputs.map((_, i) => `[a${i}]`).join('')}concat=n=${inputs.length}:v=0:a=1[a]`);
    await ffmpeg([
      ...inputs.flatMap((file) => ['-i', file]),
      ...['-filter_complex', filters.join(';'), '-map', '[a]'],
      ...AUDIO_CODECS[extname(out).toLowerCase()]!,
      temp,
    ]);
    const total = probes.reduce((sum, p) => sum + p.duration, 0);
    return `拼好了 ${inputs.length} 段音频，共约 ${seconds(total)}。`;
  },

  async 'media.convert'(args, out, temp) {
    const source = await probe(args.in!);
    const ext = extname(out).toLowerCase();
    const scale = scaleOf(args);
    if (AUDIO_CODECS[ext]) {
      if (!source.audio) throw new Error(`${args.in} 里没有声音`);
      await ffmpeg(['-i', args.in!, '-vn', '-map', '0:a:0', ...AUDIO_CODECS[ext], temp]);
      return `转成了 ${ext.slice(1)} 音频。`;
    }
    if (!source.video) throw new Error(`${args.in} 里没有画面`);
    if (ext === '.gif') {
      const size = scale ?? (source.video.width > 480 ? 'scale=480:-2:flags=lanczos' : undefined);
      const filter = `fps=12${size ? `,${size}` : ''},split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`;
      await ffmpeg(['-i', args.in!, '-filter_complex', filter, '-loop', '0', temp]);
      return '转成了 GIF 动图（每秒 12 帧）。';
    }
    if (IMAGE_EXTS.includes(ext)) {
      await ffmpeg([
        ...['-i', args.in!, ...(scale ? ['-vf', scale] : []), '-frames:v', '1'],
        ...(ext === '.jpg' || ext === '.jpeg' ? ['-q:v', '2'] : []),
        temp,
      ]);
      return `转成了 ${ext.slice(1)} 图片。`;
    }
    await ffmpeg([
      ...['-i', args.in!, ...(scale ? ['-vf', scale] : []), '-map', '0:v:0', '-map', '0:a:0?'],
      ...videoCodec(ext),
      temp,
    ]);
    return `转成了 ${ext.slice(1)} 视频。`;
  },
};

/** 检查参数和输入文件；返回操作的定义 */
export async function prepare(name: string, args: Args, out: string | undefined): Promise<LocalOp> {
  const op = OPS.find((o) => o.key === `op.${name}`);
  if (!op) throw new Error(`没有操作 ${name}；能用：${OPS.map((o) => o.key.slice(3)).join('、')}`);
  const problems = checkToolArgs(op.args, args, { anyPath: true });
  if (problems.length) throw new Error(problems.join('；'));
  if (!out) throw new Error('要用 --out 写结果存到哪');
  if (op.out === 'file' && !op.outTypes?.includes(extname(out).toLowerCase()))
    throw new Error(`--out 要以 ${op.outTypes?.join('、')} 结尾`);
  for (const spec of op.args.filter((s) => s.kind === 'path' || s.kind === 'paths'))
    for (const file of spec.kind === 'paths' ? (listOf(args[spec.name]) ?? []) : [args[spec.name]])
      if (typeof file === 'string' && !(await stat(file).catch(() => undefined))?.isFile())
        throw new Error(`找不到文件 ${file}`);
  return op;
}

/** 做一个操作：先写到同目录的临时位置，做完再换上，做到一半失败不留半个文件 */
export async function perform(name: string, argv: string[]): Promise<void> {
  const { args, out } = parseOpArgs(argv);
  const op = await prepare(name, args, out);
  const target = out!;
  await mkdir(dirname(target), { recursive: true });
  const temp = join(
    dirname(target),
    `.oasis-op-${randomUUID()}${op.out === 'file' ? extname(target) : ''}`,
  );
  try {
    const text = await OPERATIONS[name]!(args, target, temp);
    await rm(target, { recursive: true, force: true });
    await rename(temp, target);
    say(text);
    say(`已保存：${target}`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === 'list') {
    for (const op of OPS)
      say(`${op.key.slice(3)}（${op.name}）：${op.description}\n  用法：${op.usage}\n`);
    return;
  }
  await perform(command, rest);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(`oasis-op 出错：${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
