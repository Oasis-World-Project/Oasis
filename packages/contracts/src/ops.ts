// 沙箱里的本地确定性操作（ADR 0025）：拼视频、裁剪、抽帧、配音轨、拼音频、转格式。不调外部供应商、不花工具钱，
// 只占沙箱算力。和外部工具一样进工具目录（键名 op.*），工具节点和干活节点里的 AI 都能用：
//   oasis-op video.concat --in in/镜头/1.mp4,in/镜头/2.mp4 --out out/成片.mp4
//   oasis-tool op.video.concat …（同上，oasis-tool 转给 oasis-op）
// 这个文件原样复制进沙箱镜像（oasis-op 用它校验参数），所以只用 import type。
import type { ToolArgSpec } from './tool-args.ts';

export interface LocalOp {
  /** 工具目录里的键名 */
  key: `op.${string}`;
  name: string;
  description: string;
  usage: string;
  args: ToolArgSpec[];
  /** 结果是一个文件，还是一个目录（抽帧） */
  out: 'file' | 'dir';
  /** 结果文件能用的后缀 */
  outTypes?: string[];
}

const VIDEO_OUT = ['.mp4', '.mov', '.webm'];
const AUDIO_OUT = ['.mp3', '.wav', '.m4a', '.ogg', '.flac'];
const IMAGE_OUT = ['.png', '.jpg', '.jpeg', '.webp'];

const size = (name: 'width' | 'height', otherwise: string): ToolArgSpec => ({
  name,
  kind: 'number',
  min: 16,
  max: 4096,
  description: `画面${name === 'width' ? '宽' : '高'}（像素），不写${otherwise}`,
});

export const OPS: LocalOp[] = [
  {
    key: 'op.video.concat',
    name: '拼接视频',
    description:
      '按顺序把几段视频拼成一段：统一成同样的画面大小（等比缩放、不够的补黑边）和帧率，没有声音的段补静音。',
    usage:
      'oasis-op video.concat --in in/镜头/1.mp4,in/镜头/2.mp4 [--width 1280 --height 720] [--fps 30] --out out/成片.mp4',
    args: [
      {
        name: 'in',
        kind: 'paths',
        required: true,
        min: 2,
        max: 50,
        description: '按顺序拼接的视频',
      },
      size('width', '按第一段'),
      size('height', '按第一段'),
      { name: 'fps', kind: 'number', min: 1, max: 60, description: '帧率，不写按第一段' },
    ],
    out: 'file',
    outTypes: VIDEO_OUT,
  },
  {
    key: 'op.video.trim',
    name: '裁剪视频',
    description: '截取视频里的一段（按秒，精确到帧）。',
    usage:
      'oasis-op video.trim --in in/素材/原片.mp4 --start 3 [--end 8 | --duration 5] --out out/片段.mp4',
    args: [
      { name: 'in', kind: 'path', required: true, description: '要截取的视频' },
      {
        name: 'start',
        kind: 'number',
        required: true,
        min: 0,
        max: 86_400,
        description: '从第几秒开始',
      },
      {
        name: 'end',
        kind: 'number',
        min: 0,
        max: 86_400,
        description: '到第几秒结束（和 duration 二选一）',
      },
      {
        name: 'duration',
        kind: 'number',
        min: 0.04,
        max: 86_400,
        description: '截多少秒（和 end 二选一）',
      },
    ],
    out: 'file',
    outTypes: VIDEO_OUT,
  },
  {
    key: 'op.video.frames',
    name: '视频抽帧',
    description: '从视频里抽出画面存成图片：每隔几秒一张，或在指定的几个时间点各一张。',
    usage:
      'oasis-op video.frames --in in/成片.mp4 [--every 2 | --at 0,1.5,3] [--format jpg] --out out/画面',
    args: [
      { name: 'in', kind: 'path', required: true, description: '视频文件' },
      {
        name: 'every',
        kind: 'number',
        min: 0.1,
        max: 3600,
        description: '每隔几秒抽一张（默认 1）',
      },
      { name: 'at', kind: 'list', min: 1, max: 200, description: '在这几个时间点（秒）各抽一张' },
      {
        name: 'format',
        kind: 'choice',
        choices: ['png', 'jpg'],
        description: '图片格式（默认 png）',
      },
      { name: 'max', kind: 'number', min: 1, max: 500, description: '最多抽几张（默认 100）' },
    ],
    out: 'dir',
  },
  {
    key: 'op.video.audio',
    name: '给视频配音轨',
    description:
      '把一段音频（配音、配乐）放进视频：替换原声或和原声混在一起；成片按视频的长度，音频短了补静音、长了截掉。',
    usage:
      'oasis-op video.audio --video in/成片.mp4 --audio in/配音/旁白.mp3 [--mode replace|mix] [--volume 1] --out out/成片-配音.mp4',
    args: [
      { name: 'video', kind: 'path', required: true, description: '视频' },
      { name: 'audio', kind: 'path', required: true, description: '要放进去的音频' },
      {
        name: 'mode',
        kind: 'choice',
        choices: ['replace', 'mix'],
        description: 'replace 换掉原声（默认），mix 和原声混在一起',
      },
      {
        name: 'volume',
        kind: 'number',
        min: 0,
        max: 4,
        description: '放进去的音频的音量倍数（默认 1）',
      },
    ],
    out: 'file',
    outTypes: VIDEO_OUT,
  },
  {
    key: 'op.audio.concat',
    name: '拼接音频',
    description: '按顺序把几段音频拼成一段（统一成 48 kHz 立体声）。',
    usage: 'oasis-op audio.concat --in in/配音/1.mp3,in/配音/2.mp3 --out out/旁白.mp3',
    args: [
      {
        name: 'in',
        kind: 'paths',
        required: true,
        min: 2,
        max: 100,
        description: '按顺序拼接的音频',
      },
    ],
    out: 'file',
    outTypes: AUDIO_OUT,
  },
  {
    key: 'op.media.convert',
    name: '转换格式',
    description:
      '转换音频、视频、图片的格式（按 --out 的后缀），可以顺带缩放画面；视频转成 .gif 做动图预览。',
    usage:
      'oasis-op media.convert --in in/成片.mov [--width 1280] [--height 720] --out out/成片.mp4',
    args: [
      { name: 'in', kind: 'path', required: true, description: '要转换的文件' },
      size('width', '保持原样（只写一边时按比例）'),
      size('height', '保持原样（只写一边时按比例）'),
    ],
    out: 'file',
    outTypes: [...VIDEO_OUT, '.gif', ...AUDIO_OUT, ...IMAGE_OUT],
  },
];

export const opByKey = (key: string): LocalOp | undefined => OPS.find((op) => op.key === key);
