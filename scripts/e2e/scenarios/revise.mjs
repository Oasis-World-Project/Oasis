// 回归场景（docs/engineering/回归测试.md）：修改、中途调整、停止和继续、持久工作目录。
import { marker, writeFiles } from '../fake-provider.mjs';
import { DEFAULT_MODEL, done, dropWorkspace, outcomes, work } from './shared.mjs';

// ---------- 3. 修改（ADR 0022、0030 §3.8）：意见指到一样成果 → 做它的 AI 接着原会话改；
// 没指到 → 规划员排方案 → 用户确认 → 沿用 / 重新做 ----------
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
  plan: ({ pick }) =>
    outcomes({
      nodes: reviseNodes(pick),
      edges: [{ from: 'copy', to: 'sheet' }],
      deliverables: { 活动文案: 'copy', 海报说明: 'sheet' },
    }),
  // 没指到成果的修改交给规划员：文案沿用，海报说明重新做（上一版在 in/_previous/）
  revisionPlan: ({ pick }) => {
    const [, sheet] = outcomes({
      nodes: reviseNodes(pick),
      edges: [{ from: 'copy', to: 'sheet' }],
    }).outcomes;
    return {
      summary: '文案沿用，海报说明重新做，加一句副标题。',
      outcomes: [
        { key: 'copy', reuse: true },
        {
          ...sheet,
          goal: `${sheet.goal}；基于 in/_previous/海报说明.md 加一句副标题`,
          mode: 'fresh',
        },
      ],
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
                // 重新做：上一版的文件在 in/_previous/，在它的基础上加副标题
                bash: `test -f in/_previous/海报说明.md && test -f in/copy/文案.md && mkdir -p out && cp in/_previous/海报说明.md out/海报说明.md && printf '%s\\n' '副标题：一起过周末' >> out/海报说明.md`,
              }
            : {
                bash: `test -f in/copy/文案.md && ${writeFiles({ 'out/海报说明.md': '# 秋日市集\n海报用暖色。\n' })}`,
              },
      ],
      // 接着原会话改：工作目录里还是上一版，直接改标题
      revision: [{ bash: `sed -i 's/秋日市集/冬日市集/' out/海报说明.md && cat out/海报说明.md` }],
    },
  },
  async run(t) {
    const { taskId } = await t.user.createTask(this.request);
    t.track(taskId);
    let task = await t.user.waitTask(taskId, done, '第一版交付');
    const sheetNode = task.nodes.find((n) => n.key === 'sheet');
    const copyCalls = () => t.provider.of('revise', 'copy').length;
    const before = copyCalls();

    // 第一次修改：批注指到海报说明 → 不经过规划员，做它的 AI 接着原会话改，马上开跑
    const planners = () =>
      t.provider.calls.filter((c) => c.kind === 'replanner' && c.scenario === 'revise').length;
    task = await t.user.revise(taskId, {
      request: '把标题改成「冬日市集」',
      nodeIds: [sheetNode.id],
    });
    t.check(
      task.status === 'running' && task.version === 2 && !task.revision,
      `意见指到一样成果应直接开跑：${task.status} 第 ${task.version} 版 ${JSON.stringify(task.revision)}`,
    );
    task = await t.user.waitTask(
      taskId,
      (x) => done(x) && x.version === 2 && !x.revising,
      '第二版交付',
    );
    t.check(copyCalls() === before, '沿用的「写文案」不应再调模型');
    t.check(planners() === 0, '意见指到一样成果时不应该找规划员');
    const continued = t.provider.of('revise', 'sheet').filter((c) => c.segment === 'revision');
    t.check(
      continued.length > 0 && continued.every((c) => c.segments > 1),
      '接着改的成果没有接上原会话',
    );
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

    // 第二次修改：没指到哪样成果 → 规划员排方案 → 等确认 → 文案沿用、海报说明重新做
    await t.user.revise(taskId, { request: '加一句副标题' });
    task = await t.user.waitTask(
      taskId,
      (x) => x.revision?.stage === 'confirm',
      '第二次修改方案待确认',
    );
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
    await t.user.waitTask(taskId, (x) => done(x) && x.version === 3 && !x.revising, '第三版交付');
    t.check(copyCalls() === before, '沿用的「写文案」不应再调模型');
    const third = await t.user.waitContent(taskId, '海报说明.md', (text) =>
      text.includes('副标题'),
    );
    t.check(third.includes('冬日市集') && third.includes('副标题'), `第三版海报说明不对：${third}`);
  },
};

// ---------- 3b. 中途调整（ADR 0030 §3.7）：做文案的 AI 提一次，规划员答一次——加一样成果、
// 给还没开始的成果补说明、停掉一样成果；改动马上生效，不问用户 ----------
const adjustNodes = (pick) => [
  work('adjust', 'copy', '写文案', '写活动文案和备用标题，交出 out/文案.md', {
    model: pick(DEFAULT_MODEL),
    expects: ['文案.md'],
    deliver: ['文案.md'],
  }),
  work('adjust', 'sheet', '写海报说明', '按 in/copy/文案.md 写海报说明，交出 out/海报说明.md', {
    model: pick(DEFAULT_MODEL),
    expects: ['海报说明.md'],
    deliver: ['海报说明.md'],
  }),
  work('adjust', 'titles', '想备用标题', '想三个备用标题，交出 out/备用标题.md', {
    model: pick(DEFAULT_MODEL),
    expects: ['备用标题.md'],
    deliver: ['备用标题.md'],
  }),
];
export const adjust = {
  title: '活动文案、海报说明和备用标题',
  deliverables: [
    { name: '活动文案', form: 'Markdown' },
    { name: '海报说明', form: 'Markdown' },
    { name: '备用标题', form: 'Markdown' },
  ],
  criteria: ['文案和海报说明标题一致'],
  get request() {
    return `写一段活动文案、一份海报说明，再想几个备用标题 ${marker('adjust')}`;
  },
  plan: ({ pick }) =>
    outcomes({
      nodes: adjustNodes(pick),
      edges: [{ from: 'copy', to: 'sheet' }],
      deliverables: { 活动文案: 'copy', 海报说明: 'sheet', 备用标题: 'titles' },
    }),
  // 规划员对调整的答复：三种改动各一个
  adjust: ({ pick }) => ({
    reply: '同意：加一份常见问题；海报说明不写价格；备用标题不单做了，文案里带着。',
    add: outcomes({
      nodes: [
        work('adjust', 'faq', '写常见问题', '按 in/copy/文案.md 写常见问题，交出 out/常见问题.md', {
          model: pick(DEFAULT_MODEL),
          expects: ['常见问题.md'],
        }),
      ],
      edges: [{ from: 'copy', to: 'faq' }],
    }).outcomes,
    deliverables: { 备用标题: 'copy' },
    instruct: [{ key: 'sheet', text: '不要写价格' }],
    stop: ['titles'],
  }),
  nodes: {
    copy: {
      work: [
        {
          bash: writeFiles({ 'out/文案.md': '# 秋日市集\n周末一起逛市集。\n备用标题：周末市集\n' }),
        },
        // 提出调整：假规划员答得快，这条命令自己就等到了答复；把答复记进交付的文件里
        {
          bash: `oasis-tool workflow.adjust --want '加一份常见问题；海报说明别写价格；备用标题不用单做了' --why '文案里已经带了备用标题' > 答复.txt && cat 答复.txt && printf '\\n规划员的答复：%s\\n' "$(cat 答复.txt)" >> out/文案.md`,
        },
      ],
    },
    sheet: {
      work: [
        ({ seg }) => ({
          // 补的说明要带进这样成果开跑时的说明里
          bash: seg.text.includes('（规划员中途调整）不要写价格')
            ? `test -f in/copy/文案.md && ${writeFiles({ 'out/海报说明.md': '# 秋日市集\n海报用暖色，不写价格。\n' })}`
            : 'echo "没有收到规划员补的说明" >&2; exit 1',
        }),
      ],
    },
    // 做得慢：规划员答复时它还在做，会被停掉
    titles: { work: [{ bash: 'sleep 600' }] },
    faq: {
      work: [
        {
          bash: `test -f in/copy/文案.md && ${writeFiles({ 'out/常见问题.md': '# 常见问题\n几点开始？上午十点。\n' })}`,
        },
      ],
    },
  },
  async run(t) {
    const { taskId } = await t.user.createTask(this.request);
    t.track(taskId);
    const task = await t.user.waitTask(taskId, done, '调整后交付');
    const status = Object.fromEntries(task.nodes.map((n) => [n.key, n.status]));
    t.check(
      status.copy === 'succeeded' &&
        status.sheet === 'succeeded' &&
        status.faq === 'succeeded' &&
        status.titles === 'cancelled',
      `调整后的工作流不对：${JSON.stringify(status)}`,
    );
    t.check(
      task.version === 2 && task.versions.some((v) => v.version === 1),
      `加了、停了成果，改之前的工作流应冻结成第 1 版：第 ${task.version} 版`,
    );
    const answered = t.provider.calls.filter(
      (c) => c.kind === 'adjuster' && c.scenario === 'adjust' && c.action === 'write-plan',
    );
    t.check(answered.length === 1, `规划员应只答复一次：${answered.length}`);
    const note = (key) => task.nodes.find((n) => n.key === key)?.adjust?.note ?? '';
    t.check(
      note('faq').includes('中途新加的') &&
        note('sheet').includes('不要写价格') &&
        note('titles').includes('停掉了') &&
        task.nodes.find((n) => n.key === 'copy')?.adjust?.asking === false,
      `节点上应记着调整了什么：${JSON.stringify(task.nodes.map((n) => [n.key, n.adjust]))}`,
    );
    const copy = task.nodes.find((n) => n.key === 'copy');
    const runs = await t.user.nodeRuns(taskId, copy.id);
    t.check(
      runs.map((r) => `${r.purpose}/${r.status}`).join(' → ') ===
        'work/succeeded → adjust/succeeded',
      `提出调整的成果应有一次干活、一次规划员答复的运行：${runs.map((r) => `${r.purpose}/${r.status}`).join(' → ')}`,
    );
    // 提出调整的 AI 拿到了答复；补的说明带进了海报说明；备用标题改由文案交付
    const text = await t.user.waitContent(taskId, '文案.md', (x) => x.includes('已生效'));
    t.check(
      text.includes('新加了「写常见问题」') && text.includes('停掉了「想备用标题」'),
      `做文案的 AI 没拿到规划员的答复：${text}`,
    );
    const sheet = await t.user.waitContent(taskId, '海报说明.md', (x) => x.includes('不写价格'));
    t.check(sheet.includes('不写价格'), `海报说明没按补的说明做：${sheet}`);
    t.check(
      task.deliverables.find((d) => d.name === '备用标题')?.nodeId === copy.id,
      '备用标题应改由文案交付',
    );
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
  plan: ({ pick }) =>
    outcomes({
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
  plan: ({ pick }) =>
    outcomes({
      nodes: [noteNode(pick)],
      edges: [],
      deliverables: { 笔记: 'note' },
    }),
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
    // 意见直接交给做笔记的 AI 接着原会话改；原会话的工作目录已经没了，task 应改成重新做
    await t.user.revise(taskId, { request: '加一句结尾', nodeIds: [node.id] });
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
