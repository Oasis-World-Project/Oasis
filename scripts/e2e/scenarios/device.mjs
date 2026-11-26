// 回归场景（docs/engineering/回归测试.md）：在用户电脑上干活。这台「电脑」用桌面版同一份代码
// （apps/desktop 构建出的 device.js：经网页地址连 Oasis、装 dsh、在项目文件夹里起 dsh），dsh 是真的。
// 「可改项目文件夹 + 超出问我 + 花钱的工具问我」：项目里直接写；写项目外的出确认卡，点「允许一次」；
// 生图出确认卡，点「以后都允许」（私聊的设置跟着改）；成品进画布；删私聊时电脑上的会话也清掉。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { marker } from '../fake-provider.mjs';
import { ROOT } from '../stack.mjs';
import { cardOf, runsOf } from './shared.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** 装好的 dsh 留着给下一轮回归用（第一次装约 3 分钟） */
const DSH_CACHE = path.join(ROOT, '.tmp', 'e2e-dsh');
/** 项目外的一个文件：要用户同意才能写 */
const OUTSIDE = path.join(os.tmpdir(), 'oasis-e2e-device', 'outside.txt');
const PROMPT = '小项目的封面，蓝色几何';
const windows = process.platform === 'win32';
/** 命令行一步：Windows 上 dsh 的命令工具是 pwsh，别处是 bash */
const shell = (command, description, extra = {}) => ({
  tool: windows ? 'pwsh' : 'bash',
  args: { description, command, ...extra },
});

export const device = {
  says: {
    1: {
      steps: [
        shell(
          windows
            ? "Set-Content -Path notes.txt -Value '项目里写的' -Encoding utf8"
            : "printf '%s\\n' '项目里写的' > notes.txt",
          '在项目里写文件',
        ),
        shell(
          windows
            ? `Set-Content -Path '${OUTSIDE}' -Value '项目外写的' -Encoding utf8`
            : `printf '%s\\n' '项目外写的' > '${OUTSIDE}'`,
          '写项目外的文件',
          {
            sandbox_permissions: 'danger-full-access',
            justification: '要把整理好的清单写到项目外面的文件夹',
          },
        ),
        shell(
          `oasis-tool image.generate --prompt "${PROMPT}" --out .oasis/out/封面.png`,
          '生成封面',
        ),
      ],
      reply: '整理好了，封面也做好了。',
    },
  },
  async run(t) {
    // 回归开始时才构建桌面版（turbo），所以到这里再加载
    const { createDeviceClient } = await import('../../../apps/desktop/dist/device.js');
    const { createDshRuntime } = await import('../../../apps/desktop/dist/dsh-runtime.js');
    const base = path.join(t.outDir, 'device');
    const project = path.join(base, 'project');
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(project, 'README.md'), '# 小项目\n');
    mkdirSync(path.dirname(OUTSIDE), { recursive: true });
    rmSync(OUTSIDE, { force: true });
    const dataDir = path.join(base, 'data');
    const client = createDeviceClient({
      dataDir,
      webOrigin: t.webUrl,
      cookie: async () => t.user.cookie(),
      runtime: createDshRuntime(DSH_CACHE),
      log: (line) => t.log(`电脑：${line}`),
    });
    try {
      await client.start();
      for (let i = 0; i < 60 && !client.status().connected; i++) await sleep(250);
      t.check(client.status().connected, '桌面版没连上 Oasis');
      const { deviceId, folder } = await client.allowFolder(project);

      const id = await t.user.openDm();
      t.track(id);
      const permissions = { mode: 'manual' };
      const setup = await t.user.api.put(`/conversation/v1/conversations/${id}/setup`, {
        workplace: { kind: 'device', deviceId, folder },
        permissions,
      });
      t.check(
        setup.message === null && setup.conversation.workplace.kind === 'device',
        `还没说过话的对话定在电脑上，不该插分隔：${JSON.stringify(setup).slice(0, 300)}`,
      );
      await t.user.say(id, `整理一下这个项目，再做一张封面 ${marker('device', 1)}`);

      // 用户点确认卡（第一次在这台电脑上干活要先装 dsh，等得久一些）
      const answer = async (kind, decision) => {
        const deadline = Date.now() + 600_000;
        while (Date.now() < deadline) {
          const { turn } = await t.user.messages(id);
          if (!turn) break;
          const card = turn.confirmations.find((c) => c.kind === kind);
          if (card) {
            t.log(`确认卡（${kind}）：${card.text} → ${decision}`);
            return t.user.api.post(
              `/conversation/v1/conversations/${id}/confirmations/${card.id}`,
              {
                decision,
              },
            );
          }
          await sleep(1_000);
        }
        t.check(false, `等不到${kind === 'tool' ? '花钱的工具' : '超出权限'}的确认卡`);
        return undefined;
      };
      t.check((await answer('command', 'once'))?.status === 'allowed', '允许一次没生效');
      t.check((await answer('tool', 'always'))?.status === 'allowed', '以后都允许没生效');
      const messages = await t.user.waitTurn(id, '在电脑上干活');

      const [run] = runsOf(id);
      t.check(run?.status === 'succeeded', `这一轮应成功：${run?.status} ${run?.error ?? ''}`);
      const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8').trim() : '');
      t.check(read(path.join(project, 'notes.txt')).includes('项目里写的'), '项目里的文件没写成');
      t.check(read(OUTSIDE).includes('项目外写的'), '用户允许了，项目外的文件却没写成');
      t.check(read(path.join(project, '.oasis', '.gitignore')) === '*', '.oasis/ 没让 git 忽略');
      const shots = t.provider.calls.filter((c) => c.kind === 'image' && c.prompt === PROMPT);
      t.check(shots.length === 1, `封面应调一次供应商：${shots.length} 次`);
      const artifacts = await t.user.waitArtifacts(id, ['封面.png']);
      t.check(
        artifacts.some((a) => a.path === '封面.png'),
        `画布里没有封面（有：${artifacts.map((a) => a.path).join('、')}）`,
      );
      t.check(cardOf(messages, run?.id)?.data.status === 'done', '用了生图的一轮应有任务卡');
      const { conversations } = await t.user.api.get('/conversation/v1/dms');
      t.check(
        conversations.find((c) => c.id === id)?.permissions.always?.includes('tool'),
        '点了「以后都允许」，花钱的工具这一类应记下以后不问',
      );

      // 删私聊：电脑上这个会话的 dsh 记录也清掉
      const home = path.join(dataDir, 'dsh', run?.session_id ?? '');
      t.check(existsSync(home), `电脑上应有这个会话的 dsh 家目录：${home}`);
      await t.user.removeDms([id]);
      for (let i = 0; i < 40 && existsSync(home); i++) await sleep(250);
      t.check(!existsSync(home), '删了私聊，电脑上这个会话的 dsh 记录还在');
    } finally {
      client.close();
      rmSync(OUTSIDE, { force: true });
    }
  },
};
