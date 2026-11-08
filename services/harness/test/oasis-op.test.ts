// 沙箱里的本地操作 oasis-op（ADR 0025）：参数解析和检查、ffprobe 结果的读法。真正调 ffmpeg 的验收在沙箱镜像里跑
// （pnpm sandbox:check:ops），本机不一定装了 ffmpeg。
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseOpArgs, prepare, probeOf } from '../sandbox/oasis-op.ts';

let root: string;
beforeEach(async () => {
  // 沙箱里的路径用 /；在 Windows 上跑测试时也换成 /（Node 认得）
  root = (await mkdtemp(join(tmpdir(), 'oasis-op-'))).replaceAll('\\', '/');
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe('oasis-op', () => {
  it('解析 --名字 值，--out 单独拿出来；少了值说清楚', () => {
    expect(parseOpArgs(['--in', 'a.mp4,b.mp4', '--fps', '30', '--out', 'out/c.mp4'])).toEqual({
      args: { in: 'a.mp4,b.mp4', fps: '30' },
      out: 'out/c.mp4',
    });
    expect(() => parseOpArgs(['--in'])).toThrow('--in 后面缺少值');
    expect(() => parseOpArgs(['in', 'x'])).toThrow('看不懂参数');
  });

  it('ffprobe 的结果：时长、画面大小、帧率、有没有声音', () => {
    const probe = probeOf(
      JSON.stringify({
        streams: [
          {
            codec_type: 'video',
            codec_name: 'h264',
            width: 1280,
            height: 720,
            r_frame_rate: '30000/1001',
          },
          { codec_type: 'audio', codec_name: 'aac' },
        ],
        format: { duration: '4.5' },
      }),
    );
    expect(probe).toEqual({
      duration: 4.5,
      video: { width: 1280, height: 720, fps: 29.97, codec: 'h264' },
      audio: true,
    });
    expect(probeOf(JSON.stringify({ streams: [{ codec_type: 'audio' }], format: {} }))).toEqual({
      duration: 0,
      audio: true,
    });
  });

  it('执行前检查：不认识的操作、参数不对、--out 后缀不对、输入文件不在，都在调 ffmpeg 之前说清楚', async () => {
    const a = `${root}/a.mp4`;
    const b = `${root}/b.mp4`;
    await writeFile(a, 'x');
    await writeFile(b, 'x');
    await expect(prepare('video.explode', {}, 'out/x.mp4')).rejects.toThrow(
      '没有操作 video.explode',
    );
    await expect(prepare('video.concat', { in: a }, 'out/x.mp4')).rejects.toThrow(
      '参数 in 要写 2–50 项',
    );
    await expect(prepare('video.concat', { in: `${a},${b}` }, undefined)).rejects.toThrow('--out');
    await expect(prepare('video.concat', { in: `${a},${b}` }, 'out/x.gif')).rejects.toThrow(
      '--out 要以 .mp4、.mov、.webm 结尾',
    );
    await expect(
      prepare('video.concat', { in: `${a},${root}/none.mp4` }, 'out/x.mp4'),
    ).rejects.toThrow('找不到文件');
    await expect(prepare('video.trim', { in: a, start: '-1' }, 'out/x.mp4')).rejects.toThrow(
      '参数 start 要在 0–86400 之间',
    );
    // 沙箱里直接运行：文件不限于 in/、materials/、out/，只是不能有 ..
    await expect(prepare('video.concat', { in: `${a},${b}` }, 'out/x.mp4')).resolves.toMatchObject({
      key: 'op.video.concat',
    });
    await expect(
      prepare('video.trim', { in: '../a.mp4', start: '0' }, 'out/x.mp4'),
    ).rejects.toThrow('参数 in');
  });
});
