// 工具目录的命令行参数（ADR 0025）：规划门按它校验工具节点，写错了节点开跑才失败，所以和网关实际收的参数对一遍。
import { checkToolArgs } from '@oasis/contracts/tool-args';
import { OPS } from '@oasis/contracts/ops';
import { describe, expect, it } from 'vitest';
import { localOpEntries, textBatchEntry } from '../src/service/tools/catalog-extras.ts';
import { TOOLS } from '../src/service/tools.ts';

/** 只在命令行上有、沙箱里的 oasis-tool 换成别的再交给网关的参数（见 services/harness/sandbox/oasis-tool.ts） */
const CLI_ONLY = new Set([
  'image.generate:ref',
  '3d.render:width',
  '3d.render:height',
  '3d.render:samples',
  '3d.render:backend',
  'audio.music:lyrics_file',
  'audio.transcribe:file',
  'jev.decide:in',
  'jev.decide:budget_micro',
  'jev.decide:resume',
]);

describe('工具目录的参数', () => {
  it('每个外部工具都列了参数，名字都是网关认得的（或由 oasis-tool 转换）', () => {
    for (const tool of TOOLS) {
      expect(tool.cli.length, tool.key).toBeGreaterThan(0);
      const shape = (tool.args as unknown as { shape?: Record<string, unknown> }).shape ?? {};
      for (const spec of tool.cli)
        expect(
          spec.name in shape || CLI_ONLY.has(`${tool.key}:${spec.name}`),
          `${tool.key} 的参数 ${spec.name}`,
        ).toBe(true);
      // 按参数计费的工具：计费参数要在参数表里
      if (tool.per)
        expect(
          tool.cli.map((s) => s.name),
          tool.key,
        ).toContain(tool.per.arg);
    }
  });

  it('本地操作和批量生成文字也在目录里，带参数；本地操作不花钱、一直可用', () => {
    const ops = localOpEntries();
    expect(ops.map((o) => o.key)).toEqual(OPS.map((o) => o.key));
    expect(ops.every((o) => o.local && o.available && o.estimateMicro === 0)).toBe(true);
    expect(ops[0]?.usage).toContain('oasis-tool op.video.concat');
    expect(textBatchEntry(false)).toMatchObject({
      key: 'text.batch',
      available: false,
      local: false,
    });
    expect(textBatchEntry(true).args.map((a) => a.name)).toContain('model');
  });

  it('生成视频的参数检查：必填、范围、选项', () => {
    const video = TOOLS.find((t) => t.key === 'video.generate')!;
    expect(checkToolArgs(video.cli, { prompt: '猫', duration: 5 })).toEqual([]);
    expect(checkToolArgs(video.cli, { duration: 50 })).toEqual([
      expect.stringContaining('缺少参数 prompt'),
      '参数 duration 要在 1–20 之间',
    ]);
  });
});
