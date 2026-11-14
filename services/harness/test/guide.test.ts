import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { guideFiles } from '../src/adapter/dsh.ts';
import { loadGuide, loadSandboxFiles, parsePlaybook } from '../src/service/guide.ts';

describe('给主 AI 的说明和技能', () => {
  it('仓库里的平台规则和每份经验都读得出来，经验变成技能', async () => {
    const guide = await loadGuide(fileURLToPath(new URL('../guide', import.meta.url)));
    expect(guide.rules).toContain('out/');
    expect(guide.skills.map((s) => s.name)).toEqual([
      '3d',
      'audio',
      'data-dashboards',
      'deep-research',
      'digital-human',
      'documents',
      'images',
      'marketing',
      'synthetic-data',
      'video',
      'web-apps',
    ]);
    expect(guide.skills.find((s) => s.name === 'images')?.description).toMatch(/^图片类。适用：/);
  });

  it('沙箱里的 oasis-tool 这些命令和 dsh 组合从仓库现读，按镜像里的位置放（import 路径不变）', async () => {
    const [tools, dsh] = await loadSandboxFiles(
      fileURLToPath(new URL('../../..', import.meta.url)),
    );
    expect(tools!.dir).toBe('/opt/oasis');
    const files = tools!.files;
    expect(files.map((f) => f.path)).toEqual([
      'oasis-tool.ts',
      'batch.ts',
      'tool-files.ts',
      'services/harness/sandbox/oasis-op.ts',
      'packages/contracts/src/ops.ts',
      'packages/contracts/src/tool-args.ts',
      'node-goal.mjs',
    ]);
    const tool = files[0]!.content.toString();
    expect(tool).toContain("from './tool-files.ts'");
    expect(files[3]!.content.toString()).toContain("'../../../packages/contracts/src/ops.ts'");
    // dsh 组合放在 dsh 用户目录的 oasis 组合里；不给整条路由设默认思考档（不会思考的型号会被拒绝）
    expect(dsh!.dir).toBe('/home/node/.dsh');
    expect(dsh!.files.map((f) => f.path)).toEqual(['profiles/oasis/cordis.patch.yml']);
    const profile = dsh!.files[0]!.content.toString();
    expect(profile).toContain('/opt/oasis/node-goal.mjs');
    expect(profile).not.toMatch(/^\s+reasoning:/m);
  });

  it('经验缺标题或「适用」行就报错', () => {
    expect(() => parsePlaybook('x', '正文')).toThrow('x.md');
    expect(parsePlaybook('x', '# 名\n\n> 适用：时\n\n正文')).toEqual({
      key: 'x',
      name: '名',
      when: '时',
      content: '# 名\n\n> 适用：时\n\n正文',
    });
  });

  it('放进 dsh 用户目录的文件：人设在说明最前面，每个技能一个 SKILL.md（带名字和描述）', () => {
    const files = guideFiles(
      {
        rules: '# 在 Oasis 里干活\n',
        skills: [{ name: 'images', description: '图片类。适用：海报', content: '# 图片类\n正文' }],
      },
      '你是 DeepSeek。',
    );
    expect(files.map((f) => f.path)).toEqual(['AGENTS.md', 'skills/images/SKILL.md']);
    expect(files[0]!.content.toString()).toBe('# 你是谁\n\n你是 DeepSeek。\n\n# 在 Oasis 里干活\n');
    expect(files[1]!.content.toString()).toBe(
      '---\nname: images\ndescription: "图片类。适用：海报"\n---\n\n# 图片类\n正文\n',
    );
  });
});
