// 进度页要用的一步的事实（dsh 的工具名不出适配层）：跑的是 oasis-tool 的哪个工具、点名的型号，
// 写、改的文件，oasis-tool 和 oasis-op 存下的文件。都按完整的参数和输出算（事件里的会截断）。

/** 命令里调的 oasis-tool 工具（如 image.generate） */
export const OASIS_TOOL = /(?:^|[\s;&|(])oasis-tool\s+([a-z0-9]+(?:\.[a-z0-9_-]+)*)/;

/** 工作目录里的相对路径；工作目录外的、往上跳的不算 */
function inWorkspace(path: string): string | undefined {
  const relative = path
    .trim()
    .replace(/^\/workspace\//, '')
    .replace(/^\.\//, '');
  return relative && !relative.startsWith('/') && !relative.split('/').includes('..')
    ? relative
    : undefined;
}

/** 一次工具调用的事实：oasis-tool 的工具名和点名的型号；写、改的文件。arg 取参数里的一个字段 */
export function stepFacts(
  name: string,
  arg: (key: string) => string | undefined,
): Record<string, string> {
  if (name === 'bash' || name === 'pwsh') {
    const command = arg('command') ?? '';
    const tool = OASIS_TOOL.exec(command)?.[1];
    const model = /--model\s+["']?([^"'\s]+)/.exec(command)?.[1];
    return tool ? { oasisTool: tool, ...(model ? { oasisModel: model } : {}) } : {};
  }
  const writes =
    name === 'write' ||
    name === 'edit' ||
    (name === 'str_replace_editor' && arg('command') !== 'view');
  const path = writes ? inWorkspace(arg('file_path') ?? arg('path') ?? '') : undefined;
  return path ? { path } : {};
}

/** 命令输出里「已保存：路径」那几行说的文件（oasis-tool、oasis-op 存下的），相对工作目录 */
export function savedFiles(output: string): string[] {
  return [...output.matchAll(/^已保存：(.+)$/gm)].flatMap((match) => {
    const path = inWorkspace(match[1] ?? '');
    return path ? [path] : [];
  });
}
