// 回归场景（docs/engineering/回归测试.md）：故障：回答不完整、harness 接管、model-gateway 重启。
import { execute, literal, query } from '../db.mjs';
import { writeFiles } from '../fake-provider.mjs';
import { aiOf, runsOf, settle, start } from './shared.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- 9. 回答不完整：流断在半路、上游临时出错，都不能当成做完了；这一轮出错时说「继续」接着做完 ----------
export const fault = {
  says: {
    1: {
      steps: [
        { fault: 'disconnect', bash: writeFiles({ 'out/甲.md': '甲\n' }), description: '写甲' },
        { fault: 'error500', bash: writeFiles({ 'out/乙.md': '乙\n' }), description: '写乙' },
      ],
      reply: '甲乙两段写好了。',
    },
    // 这一轮出错了、用户说「继续」：两段都补齐
    2: {
      steps: [
        { bash: writeFiles({ 'out/甲.md': '甲\n', 'out/乙.md': '乙\n' }), description: '补齐' },
      ],
      reply: '两段都补齐了。',
    },
  },
  async run(t) {
    const id = await start(t, 'fault', '写甲乙两段文字');
    await settle(t, id, '两段交付', 'fault', 2);
    const faults = t.provider.of('fault').filter((c) => c.action.startsWith('fault:'));
    const runs = runsOf(id);
    t.log(
      `故障：${faults.map((c) => c.action).join('、') || '无'}；各轮：${runs.map((r) => `${r.status}${r.continue_from ? '(接着)' : ''}`).join(' → ')}`,
    );
    t.check(faults.length >= 1, '流断掉的故障应发生');
    const artifacts = await t.user.waitArtifacts(id, ['甲.md', '乙.md']);
    t.check(
      ['甲.md', '乙.md'].every((p) => artifacts.some((a) => a.path === p)),
      `两段都应交付，画布里有：${artifacts.map((a) => a.path).join('、')}`,
    );
    // 11-08 的 $5.05：流断了拿不到用量时，先凭生成 ID 向供应商查实际花费，查不到才估
    const chats = query(
      'model_gateway',
      `select id, status, cost_source, error from calls where run_id in (${runs.map((r) => literal(r.id)).join(',')}) and kind = 'chat'`,
    );
    const estimated = chats.filter((c) => c.cost_source === 'estimate');
    t.check(
      estimated.length === 0,
      `流断掉的调用不应按字数估价（${estimated.map((c) => `${c.id.slice(0, 8)} ${c.status} ${c.error ?? ''}`).join('、')}）`,
    );
  },
};

// ---------- 10. harness 重启接管：AI 跑命令时 harness 崩了，重启后在同一轮、同一个会话里接着做完 ----------
export const takeover = {
  serial: true,
  says: {
    1: {
      // 第一步跑到一半 harness 重启：dsh 告诉模型这条命令丢了（unknown job），重做这一步再往下
      steps: [
        {
          bash: 'mkdir -p out && echo 一 > out/一.txt && sleep 30 && echo 二 > out/二.txt',
          description: '慢慢做',
        },
        {
          bash: `test -f out/二.txt && ${writeFiles({ 'out/报告.md': '# 报告\n服务重启后接着做完。\n' })}`,
          description: '写报告',
        },
      ],
      reply: '报告写好了。',
    },
  },
  async run(t) {
    const id = await start(t, 'takeover', '写一份报告（中途服务会重启）');
    await t.provider.waitFor(
      (c) => c.scenario === 'takeover' && c.action === 'bash:0',
      'AI 开始跑命令',
    );
    await sleep(3_000);
    t.log('重启 harness');
    await t.stack.restart('harness');
    const messages = await t.user.waitTurn(id, '接管后做完');
    const runs = runsOf(id);
    t.check(
      runs.length === 1 && runs[0].status === 'succeeded',
      `接管应在原来那一轮里接着做完：${JSON.stringify(runs)}`,
    );
    const calls = t.provider.of('takeover', 1);
    t.check(
      calls.some((c) => c.segment === 'recover') && calls.every((c) => c.says === 1),
      `接管后应在同一个会话里收到「已恢复」接着做：${calls.map((c) => `${c.action}/${c.segment}/${c.says}`).join(' ')}`,
    );
    t.check(
      calls.filter((c) => c.action === 'bash:0').length === 2,
      '接管后被打断的那条命令应重做一次',
    );
    const notices = aiOf(messages, runs[0]?.id)
      .flatMap((m) => m.data.parts ?? [])
      .filter((p) => p.type === 'notice');
    t.log(`AI 消息里的提示：${notices.map((n) => n.text).join('、') || '无'}`);
    const artifacts = await t.user.waitArtifacts(id, ['报告.md']);
    t.check(
      artifacts.some((a) => a.path === '报告.md'),
      '画布里没有报告',
    );
  },
};

// ---------- 11. model-gateway 重启：模型回答到一半网关崩了，这一轮照样做完（出错了说「继续」）；
// 卡住的调用最后收尾、退回冻结 ----------
export const gateway = {
  serial: true,
  says: {
    1: {
      steps: [
        { bash: writeFiles({ 'out/一.md': '一\n' }), description: '写一' },
        // 第二步的回答挂起：网关就在这时候被重启
        { hang: true, bash: writeFiles({ 'out/二.md': '二\n' }), description: '写二' },
      ],
      reply: '两段写好了。',
    },
    2: {
      steps: [{ bash: writeFiles({ 'out/二.md': '二\n' }), description: '补上二' }],
      reply: '补上了。',
    },
  },
  async run(t) {
    const id = await start(t, 'gateway', '写两段文字（中途网关会重启）');
    await t.provider.waitFor(
      (c) => c.scenario === 'gateway' && c.action === 'hang',
      '模型回答挂起',
    );
    t.log('重启 model-gateway');
    await t.stack.restart('model-gateway');
    await settle(t, id, '网关重启后做完', 'gateway', 2);
    const artifacts = await t.user.waitArtifacts(id, ['一.md', '二.md']);
    t.check(
      artifacts.some((a) => a.path === '二.md'),
      '画布里没有第二段',
    );
    // 网关崩溃时在途的那次调用没收尾：「快进」半小时后重启网关，启动时的收尾要把它记成失败、退回冻结
    const runIds = runsOf(id)
      .map((r) => literal(r.id))
      .join(',');
    const running = `select id, hold_id from calls where run_id in (${runIds}) and status = 'running'`;
    const stuck = query('model_gateway', running);
    t.check(stuck.length >= 1, '网关崩溃时在途的调用应留下一条没收尾的记录');
    execute(
      'model_gateway',
      `update calls set created_at = created_at - interval '31 minutes' where run_id in (${runIds}) and status = 'running'`,
    );
    await t.stack.restart('model-gateway');
    let left = stuck;
    for (let i = 0; i < 30 && left.length; i++) {
      await sleep(1_000);
      left = query('model_gateway', running);
    }
    t.check(left.length === 0, `重启后的收尾没有处理卡住的调用（还剩 ${left.length} 条）`);
    const holds = stuck.filter((c) => c.hold_id).map((c) => literal(c.hold_id));
    if (holds.length) {
      const open = query(
        'billing',
        `select id from holds where id in (${holds.join(',')}) and status = 'open'`,
      );
      t.check(open.length === 0, `卡住的调用的冻结没有退回（${open.length} 笔）`);
    }
  },
};
