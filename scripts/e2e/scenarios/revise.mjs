// 回归场景（docs/engineering/回归测试.md）：修改、停止和继续、持久工作目录。
import { marker, writeFiles } from '../fake-provider.mjs';
import { DEFAULT_MODEL, done, dropWorkspace, work } from './shared.mjs';

// ---------- 3. 修改：规划员排方案 → 用户确认 → 沿用 / 重新做 / 接着原会话改（ADR 0022） ----------
const reviseNodes = (pick) => [
  work('revise', 'copy', '写文案', '写活动文案，交出 out/文案.md', {
    model: pick(DEFAULT_MODEL),
    expects: ['文案.md'],
    deliver: ['文案.md'],
  }),
  work('revise', 'sheet', '写海报说明', '按 in/copy/文案.md 写海报说明，交出 out/海报说明.md', {
    model: pick(DEFAULT_MODEL),
    expects: ['海报说明.md'],
    deliver: ['海报说明.md'],
  }),
];
export const revise = {
  title: '活动文案和海报说明',
  deliverables: [
    { name: '活动文案', form: 'Markdown' },
    { name: '海报说明', form: 'Markdown' },
  ],
  criteria: ['文案和海报说明标题一致'],
  get request() {
    return `写一段活动文案，再按文案写一份海报说明 ${marker('revise')}`;
  },
  plan: ({ pick }) => ({
    nodes: reviseNodes(pick),
    edges: [{ from: 'copy', to: 'sheet' }],
    deliverables: { 活动文案: 'copy', 海报说明: 'sheet' },
  }),
  // 第一次改标题：文案沿用、海报说明重新做；第二次加副标题：海报说明接着原会话改
  revisionPlan: ({ pick, request }) => {
    const [copy, sheet] = reviseNodes(pick);
    const winter = request?.includes('冬日');
    return {
      summary: winter
        ? '文案沿用，海报说明重新做，标题改成冬日市集。'
        : '文案沿用，海报说明接着原来的会话加副标题。',
      nodes: [
        { key: copy.key, reuse: copy.key },
        winter
          ? {
              ...sheet,
              goal: `${sheet.goal}；基于 in/_previous/海报说明.md 把标题改成冬日市集`,
              from: 'sheet',
              mode: 'fresh',
            }
          : { ...sheet, goal: `${sheet.goal}；加一句副标题`, from: 'sheet', mode: 'continue' },
      ],
      edges: [{ from: 'copy', to: 'sheet' }],
      deliverables: { 活动文案: 'copy', 海报说明: 'sheet' },
    };
  },
  nodes: {
    copy: { work: [{ bash: writeFiles({ 'out/文案.md': '# 秋日市集\n周末一起逛市集。\n' }) }] },
    sheet: {
      work: [
        ({ seg }) =>
          seg.text.includes('【上一版】')
            ? {
                // 重新做：上一版的文件在 in/_previous/，标题改掉
                bash: `test -f in/_previous/海报说明.md && test -f in/copy/文案.md && mkdir -p out && sed 's/秋日市集/冬日市集/' in/_previous/海报说明.md > out/海报说明.md`,
              }
            : {
                bash: `test -f in/copy/文案.md && ${writeFiles({ 'out/海报说明.md': '# 秋日市集\n海报用暖色。\n' })}`,
              },
      ],
      revision: [{ bash: `printf '%s\\n' '副标题：一起过周末' >> out/海报说明.md` }],
    },
  },
  async run(t) {
    const { taskId } = await t.user.createTask(this.request);
    t.track(taskId);
    let task = await t.user.waitTask(taskId, done, '第一版交付');
    const sheetNode = task.nodes.find((n) => n.key === 'sheet');
    const copyCalls = () => t.provider.of('revise', 'copy').length;
    const before = copyCalls();

    // 第一次修改：改标题 → 规划员排方案 → 等确认
    await t.user.revise(taskId, { request: '把标题改成「冬日市集」', nodeIds: [sheetNode.id] });
    task = await t.user.waitTask(taskId, (x) => x.revision?.stage === 'confirm', '修改方案待确认');
    t.check(
      task.attention?.reason === 'revision_plan',
      `应等用户确认修改方案：${JSON.stringify(task.attention)}`,
    );
    const change = Object.fromEntries(task.revision.changes.map((c) => [c.key, c.change]));
    t.check(
      change.copy === 'reuse' && change.sheet === 'fresh',
      `修改方案不对：${JSON.stringify(change)}`,
    );
    await t.user.decide(taskId, 'continue');
    task = await t.user.waitTask(
      taskId,
      (x) => done(x) && x.version === 2 && !x.revising,
      '第二版交付',
    );
    t.check(copyCalls() === before, '沿用的「写文案」节点不应再调模型');
    t.check(
      task.versions.some((v) => v.version === 1),
      '第一版工作流应冻结可查',
    );
    const winter = await t.user.waitContent(taskId, '海报说明.md', (text) =>
      text.includes('冬日市集'),
    );
    t.check(winter.includes('冬日市集'), `画布里的海报说明没改成冬日市集：${winter}`);
    t.check(
      (await t.user.artifacts(taskId)).length === 2,
      '修改后画布里应还是 2 个成果（原地更新，不多出一份）',
    );

    // 第二次修改：接着原会话加副标题
    await t.user.revise(taskId, { request: '加一句副标题', nodeIds: [sheetNode.id] });
    task = await t.user.waitTask(
      taskId,
      (x) => x.revision?.stage === 'confirm',
      '第二次修改方案待确认',
    );
    const change2 = Object.fromEntries(task.revision.changes.map((c) => [c.key, c.change]));
    t.check(change2.sheet === 'continue', `第二次应接着原会话改：${JSON.stringify(change2)}`);
    await t.user.decide(taskId, 'continue');
    await t.user.waitTask(taskId, (x) => done(x) && x.version === 3 && !x.revising, '第三版交付');
    const continued = t.provider.of('revise', 'sheet').filter((c) => c.segment === 'revision');
    t.check(
      continued.length > 0 && continued.every((c) => c.segments > 1),
      '接着改的节点没有接上原会话',
    );
    const third = await t.user.waitContent(taskId, '海报说明.md', (text) =>
      text.includes('副标题'),
    );
    t.check(third.includes('冬日市集') && third.includes('副标题'), `第三版海报说明不对：${third}`);
  },
};

// ---------- 4. 停止后继续：节点在跑命令时被用户停下，继续后接着原会话做完 ----------
export const stop = {
  title: '慢慢做的报告',
  deliverables: [{ name: '报告', form: 'Markdown' }],
  criteria: ['交出报告'],
  get request() {
    return `写一份报告，中途我可能会停下 ${marker('stop')}`;
  },
  plan: ({ pick }) => ({
    nodes: [
      work('stop', 'slow', '写报告', '写报告，交出 out/报告.md', {
        model: pick(DEFAULT_MODEL),
        expects: ['报告.md'],
        deliver: ['报告.md'],
      }),
    ],
    edges: [],
    deliverables: { 报告: 'slow' },
  }),
  nodes: {
    slow: {
      work: [
        { bash: 'mkdir -p out && echo 开始 > out/进度.txt && sleep 600', description: '慢慢做' },
      ],
      resume: [
        {
          bash: `test -f out/进度.txt && ${writeFiles({ 'out/报告.md': '# 报告\n停下后接着做完。\n' })}`,
        },
      ],
    },
  },
  async run(t) {
    const { taskId } = await t.user.createTask(this.request);
    t.track(taskId);
    await t.provider.waitFor(
      (c) => c.scenario === 'stop' && c.node === 'slow' && c.action === 'bash:0',
      '节点开始跑命令',
    );
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await t.user.stop(taskId);
    let task = await t.user.waitTask(taskId, (x) => x.status === 'stopped', '任务停下');
    t.check(task.nodes[0].status === 'stopped', `节点应是已停止：${task.nodes[0].status}`);
    await t.user.run(taskId);
    task = await t.user.waitTask(taskId, done, '继续后交付');
    const runs = await t.user.nodeRuns(taskId, task.nodes[0].id);
    t.check(runs.length === 2, `应有两次运行（停下的和继续的），实际 ${runs.length} 次`);
    t.check(
      runs.some((r) => r.status === 'stopped'),
      '第一次运行应是已停止',
    );
    t.check(
      runs.some((r) => r.continued && r.status === 'succeeded'),
      '继续的那次应接着原会话并成功',
    );
    const resumed = t.provider.of('stop', 'slow').filter((c) => c.segment === 'resume');
    t.check(resumed.length > 0 && resumed.every((c) => c.segments === 2), '继续后没有接上原会话');
    const artifacts = await t.user.waitArtifacts(taskId, ['报告.md']);
    t.check(
      artifacts.some((a) => a.path === '报告.md'),
      '画布里没有报告',
    );
  },
};

// ---------- 4b. 持久工作目录丢了：修改时接不上原会话，重新开会话做、带上上一版产出（ADR 0022） ----------
const noteNode = (pick) =>
  work('workspace', 'note', '写笔记', '写笔记，交出 out/笔记.md', {
    model: pick(DEFAULT_MODEL),
    expects: ['笔记.md'],
    deliver: ['笔记.md'],
  });
export const workspace = {
  title: '工作目录丢失测试',
  deliverables: [{ name: '笔记', form: 'Markdown' }],
  criteria: ['交出笔记'],
  get request() {
    return `写一份笔记（之后它的工作目录会被清掉）${marker('workspace')}`;
  },
  plan: ({ pick }) => ({
    nodes: [noteNode(pick)],
    edges: [],
    deliverables: { 笔记: 'note' },
  }),
  // 规划员要接着原会话改；原会话的工作目录已经没了，task 应改成重新做
  revisionPlan: ({ pick }) => {
    const note = noteNode(pick);
    return {
      summary: '笔记接着原来的会话加一句结尾。',
      nodes: [{ ...note, goal: `${note.goal}；加一句结尾`, from: 'note', mode: 'continue' }],
      edges: [],
      deliverables: { 笔记: 'note' },
    };
  },
  nodes: {
    note: {
      work: [
        ({ seg }) =>
          seg.text.includes('【重新做】')
            ? {
                bash: `test -f in/_previous/笔记.md && mkdir -p out && cp in/_previous/笔记.md out/笔记.md && printf '%s\\n' '结尾：新会话补上的' >> out/笔记.md`,
              }
            : { bash: writeFiles({ 'out/笔记.md': '# 笔记\n第一版。\n' }) },
      ],
      // 工作目录没了，不应该再接着原会话改
      revision: [{ bash: `printf '%s\\n' '结尾：接着原会话' >> out/笔记.md` }],
    },
  },
  async run(t) {
    const { taskId } = await t.user.createTask(this.request);
    t.track(taskId);
    let task = await t.user.waitTask(taskId, done, '第一版交付');
    const node = task.nodes[0];
    const [first] = await t.user.nodeRuns(taskId, node.id);
    dropWorkspace(first.id);
    await t.user.revise(taskId, { request: '加一句结尾', nodeIds: [node.id] });
    await t.user.waitTask(taskId, (x) => x.revision?.stage === 'confirm', '修改方案待确认');
    await t.user.decide(taskId, 'continue');
    task = await t.user.waitTask(
      taskId,
      (x) => done(x) && x.version === 2 && !x.revising,
      '第二版交付',
    );
    const runs = await t.user.nodeRuns(taskId, node.id);
    t.log(
      `运行：${runs.map((r) => `${r.purpose}/${r.status}${r.continued ? '(接着)' : ''}`).join(' → ')}`,
    );
    t.check(
      runs.some((r) => r.continued && r.status === 'failed' && /工作目录/.test(r.error ?? '')),
      '接不上原会话的那次运行应记成失败、写明原因',
    );
    t.check(runs.at(-1)?.status === 'succeeded' && !runs.at(-1)?.continued, '应重新开会话做成功');
    t.check(!task.nodes[0].warning, `不应留下提醒：${task.nodes[0].warning}`);
    t.check(
      !t.provider.of('workspace', 'note').some((c) => c.segment === 'revision'),
      '工作目录没了还在接着原会话改',
    );
    const text = await t.user.waitContent(taskId, '笔记.md', (x) => x.includes('结尾'));
    t.check(
      text.includes('第一版') && text.includes('结尾：新会话补上的'),
      `笔记应在上一版的基础上重新做：${text}`,
    );
  },
};
