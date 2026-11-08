// 工具节点的步骤执行器（ADR 0025）：命令怎么拼、失败怎么重试、长任务怎么等、文字结果存到哪、进度怎么接着。
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  commandOf,
  conformOut,
  errorOf,
  expandGlobs,
  globFiles,
  main,
  nextTry,
  runSteps,
  settleOut,
  shown,
  type Ran,
  type Runner,
} from '../sandbox/oasis-steps.ts';

const JOB = '0d0c0b0a-0908-4706-8504-030201000000';
const ok = (stdout: string): Ran => ({ code: 0, stdout, stderr: '' });
const fail = (error: string): Ran => ({
  code: 1,
  stdout: '',
  stderr: `oasis-tool 出错：${error}\n`,
});

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'oasis-steps-'));
});
afterEach(() => rm(root, { recursive: true, force: true }));

/** 假的命令：按顺序给出每次运行的结果，记下运行了什么、发了什么事件、等了多久 */
function fake(replies: Ran[]) {
  const calls: string[][] = [];
  const events: Record<string, unknown>[] = [];
  const slept: number[] = [];
  const runner: Runner = {
    root,
    run: async (argv) => {
      calls.push(argv);
      const reply = replies.shift();
      if (!reply) throw new Error(`多跑了一次：${argv.join(' ')}`);
      return reply;
    },
    emit: (event) => events.push(event),
    sleep: async (ms) => {
      slept.push(ms);
    },
  };
  return { runner, calls, events, slept };
}

describe('工具步骤执行器', () => {
  it('外部工具交给 oasis-tool、本地操作交给 oasis-op；列表写成 JSON，带空格的值显示时加引号', () => {
    const tool = commandOf({
      tool: 'video.generate',
      args: { prompt: '一只猫 跳舞', duration: 5 },
      out: 'out/猫.mp4',
    });
    expect(tool).toEqual([
      'oasis-tool',
      'video.generate',
      '--prompt',
      '一只猫 跳舞',
      '--duration',
      '5',
      '--out',
      'out/猫.mp4',
    ]);
    expect(shown(tool)).toBe(
      'oasis-tool video.generate --prompt "一只猫 跳舞" --duration 5 --out "out/猫.mp4"',
    );
    expect(
      commandOf(
        { tool: 'op.video.concat', args: { in: ['in/a/1.mp4', 'in/a/2.mp4'] }, out: 'out/b.mp4' },
        ['--new', 'true'],
      ),
    ).toEqual([
      'oasis-op',
      'video.concat',
      '--in',
      '["in/a/1.mp4","in/a/2.mp4"]',
      '--out',
      'out/b.mp4',
      '--new',
      'true',
    ]);
    expect(errorOf(fail('供应商拒绝了提交'))).toBe('供应商拒绝了提交');
    expect(errorOf({ code: 2, stdout: '', stderr: '' })).toBe('退出码 2');
  });

  it('下一次怎么试：结果没确认的不再试，没收费或过期的重新提交，批次接着做，其余照原样', () => {
    expect(nextTry('结果没确认；任务号 x，不要重新提交以免重复收费')).toBe('stop');
    expect(
      nextTry('内容不合规（任务号 x，供应商没做出来，没有收费；要再试就加 --new true 重新提交）'),
    ).toEqual(['--new', 'true']);
    expect(nextTry('工具结果已过期，请使用已交付的成果')).toEqual(['--new', 'true']);
    expect(nextTry('批次或输出已存在，请使用 --resume true')).toEqual(['--resume', 'true']);
    expect(nextTry('fetch failed')).toEqual([]);
  });

  it('长任务等不到就接着 wait，直到做完', async () => {
    const { runner, calls, events } = fake([
      ok(`已提交\n还没做好（任务号 ${JOB}）。先做别的，过一会儿运行：oasis-tool wait ${JOB}\n`),
      ok('已保存：out/a.mp4\n花费：$0.5000\n'),
    ]);
    const failure = await runSteps(
      runner,
      [{ tool: 'video.generate', args: { prompt: 'p' }, out: 'out/a.mp4' }],
      new Set(),
      async () => {},
    );
    expect(failure).toBeUndefined();
    expect(calls[1]).toEqual(['oasis-tool', 'wait', JOB, '--out', 'out/a.mp4']);
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ ok: true });
  });

  it('供应商没做出来（没收费）：等一会儿重新提交，成功就往下走', async () => {
    const { runner, calls, events, slept } = fake([
      fail('内容不合规（任务号 x，供应商没做出来，没有收费；要再试就加 --new true 重新提交）'),
      ok('已保存：out/a.png\n'),
    ]);
    const failure = await runSteps(
      runner,
      [{ tool: 'image.generate', args: { prompt: 'p' }, out: 'out/a.png' }],
      new Set(),
      async () => {},
    );
    expect(failure).toBeUndefined();
    expect(calls[1]?.slice(-2)).toEqual(['--new', 'true']);
    expect(slept).toEqual([10_000]);
    expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(2);
    expect(events.find((e) => e.type === 'assistant_text')?.text).toContain('10 秒后自动重试');
  });

  it('结果没确认的长任务不重试（可能重复收费），交给用户', async () => {
    const { runner, calls } = fake([fail('结果没确认；任务号 x，不要重新提交以免重复收费')]);
    const failure = await runSteps(
      runner,
      [{ tool: 'video.generate', args: { prompt: 'p' } }],
      new Set(),
      async () => {},
    );
    expect(calls).toHaveLength(1);
    expect(failure).toContain('第 1 步（video.generate）没做成');
  });

  it('试满 3 次还不行：返回原因，前面等过 10 秒、20 秒', async () => {
    const { runner, calls, slept } = fake([fail('断网'), fail('断网'), fail('还是断网')]);
    const failure = await runSteps(
      runner,
      [{ tool: 'web.search', args: { query: 'q' } }],
      new Set(),
      async () => {},
    );
    expect(calls).toHaveLength(3);
    expect(slept).toEqual([10_000, 20_000]);
    expect(failure).toBe('第 1 步（web.search）没做成：还是断网');
  });

  it('文字结果的工具：把工具说的话存进 out（去掉花费行）；该有文件却没有算失败', async () => {
    expect(
      await settleOut(
        root,
        { tool: 'web.search', out: 'out/搜索.md' },
        '结果一\n结果二\n花费：$0.0100\n',
      ),
    ).toBeUndefined();
    expect(await readFile(join(root, 'out/搜索.md'), 'utf8')).toBe('结果一\n结果二\n');
    expect(await settleOut(root, { tool: 'image.generate', out: 'out/图.png' }, '没有图\n')).toBe(
      '工具说做完了，但没有生成 out/图.png',
    );
    // 多张图存成 -1、-2：看「已保存」
    expect(
      await settleOut(
        root,
        { tool: 'image.generate', out: 'out/图.png' },
        '已保存：out/图-1.png\n',
      ),
    ).toBeUndefined();
  });

  it('图片按实际格式存成了别的后缀：换回计划要的格式、删掉原来那份；换不成算失败', async () => {
    await mkdir(join(root, 'out'), { recursive: true });
    await writeFile(join(root, 'out/frame.jpg'), 'jpeg');
    const step = { tool: 'image.generate', args: { prompt: 'p' }, out: 'out/frame.png' };
    const saidJpeg =
      '生成了 1 张图片\n注意：返回的图片实际是 JPG，按实际格式存成了 out/frame.jpg\n已保存：out/frame.jpg\n';
    const { runner, calls, events } = fake([ok(saidJpeg), ok('转成了 png 图片。\n')]);
    expect(await runSteps(runner, [step], new Set(), async () => {})).toBeUndefined();
    expect(calls[1]).toEqual([
      'oasis-op',
      'media.convert',
      '--in',
      'out/frame.jpg',
      '--out',
      'out/frame.png',
    ]);
    await expect(readFile(join(root, 'out/frame.jpg'))).rejects.toThrow();
    expect(events.some((e) => String(e.text).includes('已按计划换成 out/frame.png'))).toBe(true);

    // 后缀一致、多张（-1、-2）的都不动
    const same = fake([]);
    expect(await conformOut(same.runner, step, '已保存：out/frame.png\n')).toBeUndefined();
    expect(
      await conformOut(same.runner, step, '已保存：out/frame-1.jpg\n已保存：out/frame-2.jpg\n'),
    ).toBeUndefined();
    expect(same.calls).toEqual([]);

    const broken = fake([fail('解码失败')]);
    expect(await conformOut(broken.runner, step, '已保存：out/frame.jpg\n')).toBe(
      '图片存成了 out/frame.jpg，换成 out/frame.png 没成功：解码失败',
    );
  });

  it('进度记在工作目录里：失败后接着做时跳过做完的步骤；步骤改过就从头做', async () => {
    const steps = [
      { tool: 'web.search', args: { query: 'q' }, out: 'out/a.md' },
      { tool: 'op.media.convert', args: { in: 'out/x.mov' }, out: 'out/x.mp4' },
    ];
    await mkdir(join(root, 'in'), { recursive: true });
    await writeFile(join(root, 'in/.oasis-steps.json'), JSON.stringify(steps));
    const first = fake([ok('结果\n'), fail('坏了'), fail('坏了'), fail('坏了')]);
    await main(first.runner);
    expect(first.events.at(-1)).toMatchObject({ type: 'done', ok: false });
    const progress = JSON.parse(
      await readFile(join(root, 'out/.oasis-steps/progress.json'), 'utf8'),
    ) as {
      done: number[];
    };
    expect(progress.done).toEqual([0]);

    await writeFile(join(root, 'out/x.mp4'), 'video');
    const again = fake([ok('已保存：out/x.mp4\n')]);
    await main(again.runner);
    expect(again.calls).toEqual([
      ['oasis-op', 'media.convert', '--in', 'out/x.mov', '--out', 'out/x.mp4'],
    ]);
    expect(again.events[0]?.text).toContain('前面做完的 1 步不再重做');
    expect(again.events.at(-1)).toEqual({ type: 'done', ok: true });

    await writeFile(join(root, 'in/.oasis-steps.json'), JSON.stringify(steps.slice(0, 1)));
    const changed = fake([ok('新结果\n')]);
    await main(changed.runner);
    expect(changed.calls).toHaveLength(1);
    expect(changed.events.at(-1)).toEqual({ type: 'done', ok: true });
  });

  it('参数里带 * 的路径按条目顺序展开成文件（ADR 0026）；一个也没找到这一步失败', async () => {
    for (const slot of ['02', '01', '10'])
      await mkdir(join(root, `in/clips/${slot}`), { recursive: true });
    for (const slot of ['02', '01', '10'])
      await writeFile(join(root, `in/clips/${slot}/clip.mp4`), 'v');
    await writeFile(join(root, 'in/clips/index.json'), '[]');
    expect(await globFiles(root, 'in/clips/*/clip.mp4')).toEqual([
      'in/clips/01/clip.mp4',
      'in/clips/02/clip.mp4',
      'in/clips/10/clip.mp4',
    ]);
    expect(await expandGlobs(root, { in: 'in/clips/*/clip.mp4', fps: 24 })).toEqual({
      in: ['in/clips/01/clip.mp4', 'in/clips/02/clip.mp4', 'in/clips/10/clip.mp4'],
      fps: 24,
    });
    expect(await expandGlobs(root, { in: 'in/clips/0*/clip.mp4' })).toEqual({
      in: ['in/clips/01/clip.mp4', 'in/clips/02/clip.mp4'],
    });
    expect(await expandGlobs(root, { in: 'in/clips/1*/clip.mp4' })).toEqual({
      in: 'in/clips/10/clip.mp4',
    });

    const steps = [{ tool: 'op.video.concat', args: { in: 'in/shots/*/a.mp4' }, out: 'out/f.mp4' }];
    await writeFile(join(root, 'in/.oasis-steps.json'), JSON.stringify(steps));
    const missing = fake([]);
    await main(missing.runner);
    expect(missing.calls).toEqual([]);
    expect(missing.events.at(-1)).toMatchObject({
      type: 'done',
      ok: false,
      error: expect.stringContaining('没找到符合 in/shots/*/a.mp4 的文件'),
    });
  });
});
