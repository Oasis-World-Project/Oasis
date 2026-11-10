// 工具参数的定义（ADR 0025）：和沙箱里的 `oasis-tool <工具> --名字 值`、`oasis-op <操作> --名字 值` 一一对应。
// 一份定义几处用：工具目录（model-gateway 发给规划员、节点和工作流页）、规划门校验工具节点的参数（task）、
// 沙箱里的 oasis-op 执行前校验。这个文件原样复制进沙箱镜像，所以不 import 任何东西、只用 Node 自带的能力。

/**
 * 参数的形状：text 一段文字；number 数字；flag true / false；choice 几个选项之一；
 * path 沙箱里的一个文件；paths 一个或几个文件；dir 沙箱里的一个目录（如网页应用所在的目录）；
 * list 几段文字；json 结构化内容（如测试计划）。
 */
export type ToolArgKind =
  'text' | 'number' | 'flag' | 'choice' | 'path' | 'paths' | 'dir' | 'list' | 'json';

export interface ToolArgSpec {
  name: string;
  kind: ToolArgKind;
  required?: boolean;
  /** choice 的选项 */
  choices?: string[];
  /** number 的范围；paths、list 的个数范围 */
  min?: number;
  max?: number;
  /** 给规划员、节点和工作流页看的一句话 */
  description: string;
}

/** 沙箱里能引用的文件：in/（上游交来的）、materials/（用户素材）、out/（前面步骤的产出），不能有 .. */
export const SANDBOX_FILE = /^(?:in|materials|out)\/(?!.*(?:^|\/)\.\.(?:\/|$))[^\\\0\r\n]+$/;

/** 工具节点里一步的结果存到哪：out/ 下的相对路径 */
export const STEP_OUT = /^out\/(?!.*(?:^|\/)\.\.(?:\/|$))[^\\\0\r\n*]+$/;

const isNumber = (value: unknown) =>
  (typeof value === 'number' && Number.isFinite(value)) ||
  (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)));

/** 列表参数：数组，或写成 JSON 数组、逗号分隔的文字（命令行里传来的） */
export function listOf(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return undefined;
  if (value.trim().startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 沙箱里直接运行时（AI 自己调 oasis-op）文件可以在工作目录的任何地方，只是不能有 .. */
const ANY_FILE = /^(?!.*(?:^|\/)\.\.(?:\/|$))[^\\\0\r\n]+$/;

function problemOf(spec: ToolArgSpec, value: unknown, anyPath: boolean): string | undefined {
  const inRange = (n: number) =>
    (spec.min === undefined || n >= spec.min) && (spec.max === undefined || n <= spec.max);
  const range = `${spec.min ?? ''}–${spec.max ?? ''}`;
  const file = anyPath ? ANY_FILE : SANDBOX_FILE;
  switch (spec.kind) {
    case 'text':
      return typeof value === 'string' && value.trim() ? undefined : '要写一段文字';
    case 'number':
      if (!isNumber(value)) return '要写数字';
      return inRange(Number(value)) ? undefined : `要在 ${range} 之间`;
    case 'flag':
      return value === true || value === false || value === 'true' || value === 'false'
        ? undefined
        : '只能是 true 或 false';
    case 'choice':
      return spec.choices?.includes(String(value))
        ? undefined
        : `只能是 ${spec.choices?.join('、')} 之一`;
    case 'path':
      return typeof value === 'string' && file.test(value)
        ? undefined
        : '要写沙箱里的文件路径（in/上游节点/…、materials/… 或 out/…）';
    case 'dir':
      return typeof value === 'string' && file.test(value)
        ? undefined
        : '要写沙箱里的目录路径（in/上游节点/…、materials/… 或 out/…）';
    case 'paths':
    case 'list': {
      const items = listOf(value);
      if (!items?.length)
        return spec.kind === 'paths' ? '要写一个或几个文件路径' : '要写一项或几项';
      // 文件路径里有 *（如 in/clips/*/clip.mp4）时，运行时才展开成几个文件，个数到时再查
      const globbed =
        spec.kind === 'paths' && items.some((p) => typeof p === 'string' && p.includes('*'));
      if (!globbed && !inRange(items.length)) return `要写 ${range} 项`;
      if (spec.kind === 'paths' && items.some((p) => typeof p !== 'string' || !file.test(p)))
        return '每一项都要是沙箱里的文件路径（in/上游节点/…、materials/… 或 out/…）';
      return items.some(
        (item) => !(typeof item === 'number' || (typeof item === 'string' && item.trim())),
      )
        ? '每一项都要是文字或数字'
        : undefined;
    }
    case 'json': {
      let parsed = value;
      if (typeof value === 'string')
        try {
          parsed = JSON.parse(value);
        } catch {
          parsed = undefined;
        }
      return parsed !== null && typeof parsed === 'object' ? undefined : '要写成 JSON 对象或数组';
    }
  }
}

/**
 * 按参数定义检查一组参数：不认识的参数、缺了必填的、形状不对的；没有问题返回空数组。
 * anyPath：沙箱里直接运行时，文件路径不限于 in/、materials/、out/。
 */
export function checkToolArgs(
  specs: ToolArgSpec[],
  args: Record<string, unknown>,
  options: { anyPath?: boolean } = {},
): string[] {
  const problems: string[] = [];
  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  for (const name of Object.keys(args))
    if (!byName.has(name))
      problems.push(
        `不认识参数 ${name}（能用：${specs.map((s) => s.name).join('、') || '没有参数'}）`,
      );
  for (const spec of specs) {
    const value = args[spec.name];
    if (value === undefined || value === null || value === '') {
      if (spec.required) problems.push(`缺少参数 ${spec.name}（${spec.description}）`);
      continue;
    }
    const problem = problemOf(spec, value, options.anyPath ?? false);
    if (problem) problems.push(`参数 ${spec.name} ${problem}`);
  }
  return problems;
}

/** 这组参数引用的沙箱文件（path、paths 两种参数里写的） */
export function referencedFiles(specs: ToolArgSpec[], args: Record<string, unknown>): string[] {
  const files: string[] = [];
  for (const spec of specs) {
    const value = args[spec.name];
    if (value === undefined || value === null || value === '') continue;
    if (spec.kind === 'path' && typeof value === 'string') files.push(value);
    if (spec.kind === 'paths')
      for (const item of listOf(value) ?? []) if (typeof item === 'string') files.push(item);
  }
  return files;
}

/** 一个参数写成命令行的值：列表和结构化内容写成 JSON，其余照原样 */
export function argValue(value: unknown): string {
  if (Array.isArray(value) || (value !== null && typeof value === 'object'))
    return JSON.stringify(value);
  return String(value);
}
