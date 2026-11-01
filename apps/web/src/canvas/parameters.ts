// 参数面板（ADR 0012 §12）：各类成果能改哪些成品参数、怎么写进修改意见、哪些能在浏览器里近似预览。
// 每项默认「不变」（不在 values 里）；改过的才会变成修改意见里的一行。
import type { RevisionParameter } from '@oasis/contracts/conversation';
import type { PreviewKind } from '../chat/files.ts';

export type Field =
  | { key: string; label: string; kind: 'choice'; options: string[] }
  | {
      key: string;
      label: string;
      kind: 'range';
      min: number;
      max: number;
      step: number;
      unit: 'dB' | '%' | '倍';
    }
  | { key: string; label: string; kind: 'text'; suggestions?: string[]; placeholder: string }
  | { key: string; label: string; kind: 'color' }
  | { key: string; label: string; kind: 'size' };

export type Values = Record<string, string | number | [number, number]>;

const TONE = ['冷', '中性', '暖'];
const db = (key: string, label: string): Field => ({
  key,
  label,
  kind: 'range',
  min: -12,
  max: 6,
  step: 1,
  unit: 'dB',
});

const FIELDS: Partial<Record<PreviewKind, Field[]>> = {
  video: [
    { key: 'subtitleSize', label: '字幕字号', kind: 'choice', options: ['小', '中', '大'] },
    {
      key: 'subtitlePosition',
      label: '字幕位置',
      kind: 'choice',
      options: ['底部', '中间', '顶部'],
    },
    db('voiceVolume', '配音音量'),
    db('musicVolume', '背景音乐音量'),
    { key: 'brightness', label: '亮度', kind: 'range', min: -30, max: 30, step: 5, unit: '%' },
    { key: 'tone', label: '色温', kind: 'choice', options: TONE },
  ],
  audio: [
    { key: 'rate', label: '语速', kind: 'range', min: 0.8, max: 1.25, step: 0.05, unit: '倍' },
    db('volume', '音量'),
    { key: 'mood', label: '语气', kind: 'choice', options: ['平稳', '热情', '温柔', '严肃'] },
    { key: 'music', label: '背景音乐', kind: 'choice', options: ['保留', '调低', '去掉'] },
    { key: 'format', label: '导出格式', kind: 'choice', options: ['MP3', 'WAV'] },
  ],
  model: [
    {
      key: 'material',
      label: '主体材质',
      kind: 'text',
      suggestions: ['木纹', '金属', '哑光塑料', '玻璃', '布料'],
      placeholder: '选一个，或者自己写',
    },
    { key: 'color', label: '主体颜色', kind: 'color' },
    { key: 'ground', label: '地面材质', kind: 'text', placeholder: '如 浅色木地板、水泥地' },
    { key: 'lightTone', label: '灯光色温', kind: 'choice', options: TONE },
    { key: 'faces', label: '面数', kind: 'choice', options: ['更少', '更多'] },
    { key: 'format', label: '导出格式', kind: 'choice', options: ['GLB', 'OBJ', 'FBX'] },
  ],
  image: [
    { key: 'size', label: '输出尺寸', kind: 'size' },
    { key: 'format', label: '导出格式', kind: 'choice', options: ['PNG', 'JPG', 'WebP'] },
  ],
};

export const fieldsFor = (kind: PreviewKind): Field[] => FIELDS[kind] ?? [];

/** 数字人（ADR 0013）：改的是配置文件里的人设、形象和声音，没有可近似预览的项 */
export const AVATAR_FIELDS: Field[] = [
  { key: 'tone', label: '语气', kind: 'choice', options: ['更亲切', '更正式', '更简短', '更热情'] },
  { key: 'language', label: '对话语言', kind: 'choice', options: ['中文', '英文', '日文'] },
  { key: 'voice', label: '声音', kind: 'choice', options: ['女声', '男声', '更年轻', '更沉稳'] },
  {
    key: 'look',
    label: '形象',
    kind: 'text',
    suggestions: ['换成女性', '换成男性', '更正式的着装', '竖屏形象'],
    placeholder: '想要什么样的形象',
  },
  {
    key: 'maxMinutes',
    label: '单次最长时长',
    kind: 'choice',
    options: ['3 分钟', '5 分钟', '10 分钟', '15 分钟'],
  },
  { key: 'handoff', label: '转人工', kind: 'text', placeholder: '什么情况要转人工' },
];

/** 写进修改意见的值：带单位、带符号 */
export function formatValue(field: Field, value: Values[string]): string {
  if (field.kind === 'range') {
    const n = Number(value);
    if (field.unit === '倍') return `${n} 倍`;
    const signed = `${n > 0 ? '+' : ''}${n}`;
    return field.unit === '%' ? `${signed}%` : `${signed} dB`;
  }
  if (field.kind === 'size') {
    const [w, h] = value as [number, number];
    return `${w}×${h} 像素`;
  }
  return String(value).trim();
}

/** 改过的参数（空字符串、不完整的尺寸不算） */
export function toParameters(file: string, fields: Field[], values: Values): RevisionParameter[] {
  return fields.flatMap((field) => {
    const value = values[field.key];
    if (value === undefined || value === '') return [];
    if (field.kind === 'size') {
      const [w, h] = value as [number, number];
      if (!(w > 0 && h > 0)) return [];
    }
    const text = formatValue(field, value).slice(0, 200);
    return text ? [{ file, name: field.label, value: text }] : [];
  });
}

/** 能在浏览器里近似预览的部分：视频的亮度和色温（CSS 滤镜）、音频的音量（只能调低）和语速 */
export function mediaLook(values: Values): { filter?: string; volume?: number; rate?: number } {
  const filters: string[] = [];
  if (typeof values.brightness === 'number')
    filters.push(`brightness(${1 + values.brightness / 100})`);
  if (values.tone === '暖') filters.push('sepia(0.25) saturate(1.1)');
  if (values.tone === '冷') filters.push('saturate(0.9) hue-rotate(12deg)');
  return {
    ...(filters.length ? { filter: filters.join(' ') } : {}),
    ...(typeof values.volume === 'number'
      ? { volume: Math.min(1, Math.pow(10, values.volume / 20)) }
      : {}),
    ...(typeof values.rate === 'number' ? { rate: values.rate } : {}),
  };
}
