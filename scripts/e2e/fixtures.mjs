// 回归测试的假素材：假供应商「生成」的图片和视频。PNG 在这里直接编码；JPEG 和视频用沙箱镜像里的 ffmpeg
// 做一次，缓存在 .tmp/e2e/fixtures（文件是真的能解码的，关卡的解码检查照常跑）。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { ROOT } from './stack.mjs';

const SANDBOX_BASE = 'oasis/harness-sandbox-base:0.2.1-rc.5';

/** 64×64 的渐变 PNG（RGB，无透明） */
function gradientPng(size = 64) {
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      row[1 + x * 3] = Math.round((x / size) * 255);
      row[2 + x * 3] = Math.round((y / size) * 255);
      row[3 + x * 3] = 160;
    }
    rows.push(row);
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 在沙箱镜像里用 ffmpeg 做一个文件，缓存起来 */
function made(dir, name, script, min) {
  const file = path.join(dir, name);
  if (existsSync(file)) return readFileSync(file);
  const bytes = execFileSync(
    'docker',
    [
      'run',
      '--rm',
      '--pull',
      'never',
      '--network',
      'none',
      '--cpus',
      '1',
      '--entrypoint',
      'sh',
      SANDBOX_BASE,
      '-c',
      `ffmpeg -hide_banner -loglevel error ${script} /tmp/${name} && cat /tmp/${name}`,
    ],
    { maxBuffer: 64 * 1024 * 1024, windowsHide: true },
  );
  if (bytes.length < min) throw new Error(`测试素材 ${name} 生成失败`);
  writeFileSync(file, bytes);
  return bytes;
}

export function loadFixtures() {
  const dir = path.join(ROOT, '.tmp', 'e2e', 'fixtures');
  mkdirSync(dir, { recursive: true });
  return {
    png: gradientPng(),
    // 「要 PNG 回 JPEG」的假图片模型交这张（像 Seedream，2026-11-08 真实小样）
    jpg: made(dir, 'frame.jpg', '-f lavfi -i testsrc=size=64x64 -frames:v 1', 200),
    // 2 秒带声音的测试视频（H.264 + AAC）
    mp4: made(
      dir,
      'clip.mp4',
      '-f lavfi -i testsrc=duration=2:size=320x240:rate=15 -f lavfi -i sine=frequency=440:duration=2 ' +
        '-c:v libx264 -pix_fmt yuv420p -c:a aac -shortest -movflags +faststart',
      1000,
    ),
  };
}
