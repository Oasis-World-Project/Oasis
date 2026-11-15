import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { guideFiles } from '../src/adapter/dsh.ts';
import { loadGuide, loadSandboxFiles, parsePlaybook } from '../src/service/guide.ts';

describe('给主 AI 的说明和技能', () => {
  it('仓库里的平台规则和每份经验都读得出来，经验变成技能', async () => {
    const guide = await loadGuide(fileURLToPath(new URL('../guide', import.meta.url)));
    expect(guide.rules).toContain('out/');
    // 在用户电脑上干活时换上的「环境」一节：同一个标题，说清 .oasis/ 和权限
    expect(guide.device).toMatch(/^## 环境\n/);
    expect(guide.rules).toContain('\n## 环境\n');
    expect(guide.device).toContain('.oasis/out/');
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
      'tool-api.ts',
      'batch.ts',
      'tool-files.ts',
      'services/harness/sandbox/oasis-op.ts',
      'packages/contracts/src/ops.ts',
      'packages/contracts/src/tool-args.ts',
    ]);
    const tool = files[0]!.content.toString();
    expect(tool).toContain("from './tool-files.ts'");
    expect(tool).toContain("from './tool-api.ts'");
    expect(files[4]!.content.toString()).toContain("'../../../packages/contracts/src/ops.ts'");
    // dsh 组合和两个插件放在 dsh 用户目录的 oasis 组合里（插件按组合目录的相对路径找，云端和电脑上一样）；
    // 不给整条路由设默认思考档（不会思考的型号会被拒绝）
    expect(dsh!.dir).toBe('/home/node/.dsh');
    expect(dsh!.files.map((f) => f.path)).toEqual([
      'profiles/oasis/cordis.patch.yml',
      'profiles/oasis/node-goal.mjs',
      'profiles/oasis/approval.mjs',
    ]);
    const profile = dsh!.files[0]!.content.toString();
    expect(profile).toContain('name: ./node-goal.mjs');
    expect(profile).toContain('name: ./approval.mjs');
    expect(profile).not.toContain('/opt/oasis');
    expect(profile).not.toMatch(/^\s+reasoning:/m);
    // 5 个权限档：只读、可改项目文件夹各有问 / 不问两档，完全访问不问
    for (const preset of [
      'read-only',
      'read-only-strict',
      'workspace-write',
      'workspace-write-strict',
      'danger-full-access',
    ])
      expect(profile).toContain(`      ${preset}:\n`);
  });

  it('确认卡上的话：要哪一档权限、AI 说的理由', async () => {
    // dsh 插件是不带类型的 .mjs，按地址导入
    const plugin = new URL('../src/adapter/profile/approval.mjs', import.meta.url).href;
    const { describe: describeRequest } = (await import(plugin)) as {
      describe: (request: object) => string;
    };
    expect(
      describeRequest({ reason: 'escalate sandbox to danger-full-access: 要写项目外的文件' }),
    ).toBe('要用「完全访问」权限：要写项目外的文件');
    expect(describeRequest({ reason: 'x', displayReason: { zh: '中文理由' } })).toBe('中文理由');
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
    const guide = {
      rules: '# 在 Oasis 里干活\n\n## 环境\n\n- 沙箱\n\n## 交付\n\n- out/\n',
      device: '## 环境\n\n- 用户的电脑\n',
      skills: [{ name: 'images', description: '图片类。适用：海报', content: '# 图片类\n正文' }],
    };
    const files = guideFiles(guide, '你是 DeepSeek。');
    expect(files.map((f) => f.path)).toEqual(['AGENTS.md', 'skills/images/SKILL.md']);
    expect(files[0]!.content.toString()).toBe(`# 你是谁\n\n你是 DeepSeek。\n\n${guide.rules}`);
    expect(files[1]!.content.toString()).toBe(
      '---\nname: images\ndescription: "图片类。适用：海报"\n---\n\n# 图片类\n正文\n',
    );
    // 在用户电脑上干活：只换「环境」一节，别的不动
    const device = guideFiles(guide, '', { kind: 'device', deviceId: 'device-1', folder: 'D:\\p' });
    expect(device[0]!.content.toString()).toBe(
      '# 在 Oasis 里干活\n\n## 环境\n\n- 用户的电脑\n\n## 交付\n\n- out/\n',
    );
    // 群里的一轮：只换开头（第一个二级标题之前），别的不动
    const group = guideFiles(
      { ...guide, group: '# 在 Oasis 的群里干活\n\n你在一个群里。\n' },
      '',
      { kind: 'cloud' },
      'group',
    );
    expect(group[0]!.content.toString()).toBe(
      '# 在 Oasis 的群里干活\n\n你在一个群里。\n\n## 环境\n\n- 沙箱\n\n## 交付\n\n- out/\n',
    );
  });
});
