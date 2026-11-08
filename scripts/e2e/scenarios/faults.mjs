// 回归场景（docs/engineering/回归测试.md）：故障：回答截断、harness 接管、model-gateway 重启。
import { execute, literal, query } from '../db.mjs';
import { marker, writeFiles } from '../fake-provider.mjs';
import { DEFAULT_MODEL, done, work } from './shared.mjs';

// ---------- 6. 回答不完整：流断在半路、输出被截断，都不能当成做完了 ----------
const BOTH = writeFiles({ 'out/甲.md': '甲\n', 'out/乙.md': '乙\n' });
export const fault = {
  title: '两段文字',
  deliverables: [{ name: '两段文字', form: 'Markdown' }],
  criteria: ['甲乙两段都交付'],
  get request() {
    return `写甲乙两段文字 ${marker('fault')}`;
  },
  plan: ({ pick }) => ({
    nodes: [
      work('fault', 'fragile', '写两段', '写甲乙两段，交出 out/甲.md 和 out/乙.md', {
        model: pick(DEFAULT_MODEL),
        expects: ['甲.md', '乙.md'],
        deliver: ['*.md'],
      }),
    ],
    edges: [],
    deliverables: { 两段文字: 'fragile' },
  }),
  nodes: {
    fragile: {
      work: [
        { fault: 'disconnect', bash: writeFiles({ 'out/甲.md': '甲\n' }), description: '写甲' },
        { fault: 'length', bash: writeFiles({ 'out/乙.md': '乙\n' }), description: '写乙' },
      ],
      // 运行失败后平台接着原会话重试：两段都补齐
      resume: [{ bash: BOTH, description: '补齐' }],
    },
  },
  async run(t) {
    const { taskId } = await t.user.createTask(this.request);
    t.track(taskId);
    const task = await t.user.waitTask(taskId, done, '两段交付');
    const faults = t.provider.of('fault', 'fragile').filter((c) => c.action.startsWith('fault:'));
    t.check(
      faults.length === 2,
      `两次故障都应发生，实际 ${faults.map((c) => c.action).join('、')}`,
    );
    const runs = await t.user.nodeRuns(taskId, task.nodes[0].id);
    t.log(
      `运行：${runs.map((r) => `${r.purpose}/${r.status}${r.continued ? '(接着)' : ''}`).join(' → ')}`,
    );
    const artifacts = await t.user.waitArtifacts(taskId, ['甲.md', '乙.md']);
    t.check(
      ['甲.md', '乙.md'].every((p) => artifacts.some((a) => a.path === p)),
      `两段都应交付，画布里有：${artifacts.map((a) => a.path).join('、')}`,
    );
    // 11-08 的 $5.05：流断了拿不到用量时，先凭生成 ID 向供应商查实际花费，查不到才估
    const chats = query(
      'model_gateway',
      `select id, status, cost_source, charged_micro, error from calls where task_id = ${literal(taskId)} and kind = 'chat'`,
    );
    const estimated = chats.filter((c) => c.cost_source === 'estimate');
    t.check(
      estimated.length === 0,
      `流断掉的调用不应按字数估价（${estimated.map((c) => `${c.id.slice(0, 8)} ${c.status} ${c.error ?? ''}`).join('、')}）`,
    );
  },
};

// ---------- 7. harness 重启接管：节点跑命令时 harness 崩了，重启后接着原会话做完 ----------
export const takeover = {
  serial: true,
  title: '接管测试报告',
  deliverables: [{ name: '报告', form: 'Markdown' }],
  criteria: ['交出报告'],
  get request() {
    return `写一份报告（中途服务会重启）${marker('takeover')}`;
  },
  plan: ({ pick }) => ({
    nodes: [
      work('takeover', 'long', '写报告', '写报告，交出 out/报告.md', {
        model: pick(DEFAULT_MODEL),
        expects: ['报告.md'],
        deliver: ['报告.md'],
      }),
    ],
    edges: [],
    deliverables: { 报告: 'long' },
  }),
  nodes: {
    long: {
      // 第一步跑到一半 harness 重启：持续目标在原会话里续跑，dsh 告诉模型这条命令丢了（unknown job），重做这一步再往下
      work: [
        {
          bash: 'mkdir -p out && echo 一 > out/一.txt && sleep 30 && echo 二 > out/二.txt',
          description: '慢慢做',
        },
        {
          bash: `test -f out/二.txt && ${writeFiles({ 'out/报告.md': '# 报告\n服务重启后接着做完。\n' })}`,
          description: '写报告',
        },
      ],
    },
  },
  async run(t) {
    const { taskId } = await t.user.createTask(this.request);
    t.track(taskId);
    await t.provider.waitFor(
      (c) => c.scenario === 'takeover' && c.action === 'bash:0',
      '节点开始跑命令',
    );
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    t.log('重启 harness');
    await t.stack.restart('harness');
    const task = await t.user.waitTask(taskId, done, '接管后交付');
    t.check(!task.nodes[0].warning, `接管后不应留下提醒：${task.nodes[0].warning}`);
    const runs = await t.user.nodeRuns(taskId, task.nodes[0].id);
    t.check(runs.length === 1, `接管应在原来那次运行里接着做，实际 ${runs.length} 次运行`);
    const calls = t.provider.of('takeover', 'long');
    t.check(
      calls.every((c) => c.segments === 1),
      '接管后应在同一个会话里续跑',
    );
    t.check(
      calls.filter((c) => c.action === 'bash:0').length === 2,
      '接管后被打断的那条命令应重做一次',
    );
    const artifacts = await t.user.waitArtifacts(taskId, ['报告.md']);
    t.check(
      artifacts.some((a) => a.path === '报告.md'),
      '画布里没有报告',
    );
  },
};

// ---------- 8. model-gateway 重启：模型回答到一半网关崩了，任务照样做完，卡住的调用最后收尾、退回冻结 ----------
export const gateway = {
  serial: true,
  title: '网关重启测试',
  deliverables: [{ name: '两段文字', form: 'Markdown' }],
  criteria: ['两段都交付'],
  get request() {
    return `写两段文字（中途网关会重启）${marker('gateway')}`;
  },
  plan: ({ pick }) => ({
    nodes: [
      work('gateway', 'steady', '写两段', '写两段，交出 out/一.md 和 out/二.md', {
        model: pick(DEFAULT_MODEL),
        expects: ['一.md', '二.md'],
        deliver: ['*.md'],
      }),
    ],
    edges: [],
    deliverables: { 两段文字: 'steady' },
  }),
  nodes: {
    steady: {
      work: [
        { bash: writeFiles({ 'out/一.md': '一\n' }), description: '写一' },
        // 第二步的回答挂起：网关就在这时候被重启
        { hang: true, bash: writeFiles({ 'out/二.md': '二\n' }), description: '写二' },
      ],
      resume: [{ bash: writeFiles({ 'out/二.md': '二\n' }), description: '补上二' }],
    },
  },
  async run(t) {
    const { taskId } = await t.user.createTask(this.request);
    t.track(taskId);
    await t.provider.waitFor(
      (c) => c.scenario === 'gateway' && c.action === 'hang',
      '模型回答挂起',
    );
    t.log('重启 model-gateway');
    await t.stack.restart('model-gateway');
    await t.user.waitTask(taskId, done, '网关重启后交付');
    const artifacts = await t.user.waitArtifacts(taskId, ['一.md', '二.md']);
    t.check(
      artifacts.some((a) => a.path === '二.md'),
      '画布里没有第二段',
    );
    // 网关崩溃时在途的那次调用没收尾：「快进」半小时后重启网关，启动时的收尾要把它记成失败、退回冻结
    const stuck = query(
      'model_gateway',
      `select id, hold_id from calls where task_id = ${literal(taskId)} and status = 'running'`,
    );
    t.check(stuck.length >= 1, '网关崩溃时在途的调用应留下一条没收尾的记录');
    execute(
      'model_gateway',
      `update calls set created_at = created_at - interval '31 minutes' where task_id = ${literal(taskId)} and status = 'running'`,
    );
    await t.stack.restart('model-gateway');
    let left = stuck;
    for (let i = 0; i < 30 && left.length; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      left = query(
        'model_gateway',
        `select id from calls where task_id = ${literal(taskId)} and status = 'running'`,
      );
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
