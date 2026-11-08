// 讨论节点：几位参与者来回几轮，最后由汇总者写出结论（ADR 0004）。
// - 第一轮每位参与者各说一次（并行）→ 之后每轮每人接着自己的会话回应上一轮别人的发言 → 最后汇总者写结论，
//   之后和干活节点一样过关卡。
// - 停止后继续：把这一轮没说完的重新说；都说完了就开下一轮或汇总。
// - 接不上自己原来的会话（工作目录不在了）：重新开会话说，带上完整题目和之前几轮的全部发言。
// - 运行中用户的追问不插进会话，记下来，下一轮带上。
import { HttpError } from '@oasis/service-kit';
import type { DiscussionConfig } from '../../repo/schema.ts';
import type { NodeOf, Snapshot } from '../../repo/task-store.ts';
import { contextParts, NO_QUESTIONS, type NodeContext } from '../prompt.ts';
import { contextOf, inputsOf, openRuns, redoOf } from './common.ts';
import type { NodeKindPlugin, RunRequest, Step } from './kind.ts';

type DiscussionNode = NodeOf<'discussion'>;

interface Speech {
  round: number;
  name: string;
  text: string;
}

const transcriptText = (speeches: Speech[]) =>
  speeches.map((s) => `- 第 ${s.round} 轮 ${s.name}：${s.text}`).join('\n');

/**
 * 某位参与者某一轮的发言。第一轮带完整上下文；之后接着自己的会话，只给上一轮别人说了什么。
 * 给了 history（接不上自己原来的会话、重新开会话时）：完整上下文加上之前几轮的全部发言。
 */
function speechPrompt(input: {
  context: NodeContext;
  name: string;
  stance: string;
  round: number;
  rounds: number;
  others: Speech[];
  newNotes: string[];
  history?: Speech[];
}): string {
  const ask = [
    `这是第 ${input.round} 轮（共 ${input.rounds} 轮）。`,
    '直接在你最后一条消息里说出你的发言，不用写文件，也不用调工具，除非你需要看 in/ 里的材料。',
  ].join('');
  const respond = '请回应：同意什么、反对什么、还要补充什么。';
  if (input.round === 1 || input.history) {
    return [
      `你是「${input.name}」，正在参加一场讨论：「${input.context.title}」。`,
      ...(input.stance.trim() ? [`【你的立场】\n${input.stance}`] : []),
      ...contextParts(input.context, '讨论的题目'),
      ...(input.history?.length ? [`【之前的讨论】\n${transcriptText(input.history)}`] : []),
      `【说明】\n${NO_QUESTIONS}\n- ${ask}${input.round > 1 ? respond : ''}`,
    ].join('\n\n');
  }
  const notes = input.newNotes.length
    ? `\n\n【用户新追加的要求】\n${input.newNotes.map((n) => `- ${n}`).join('\n')}`
    : '';
  return `【上一轮其他人说了】\n${transcriptText(input.others)}${notes}\n\n${ask}${respond}`;
}

/** 汇总者根据全部发言写出结论 */
function summaryPrompt(input: { context: NodeContext; transcript: Speech[] }): string {
  return [
    `你负责汇总一场讨论：「${input.context.title}」。`,
    ...contextParts(input.context, '讨论的题目'),
    `【讨论记录】\n${transcriptText(input.transcript)}`,
    [
      '【说明】',
      '- 把结论写到 out/（例如 out/讨论结论.md）：共识、分歧、建议怎么做。',
      NO_QUESTIONS,
      '- 做完后用一两句话说明结论。',
    ].join('\n'),
  ].join('\n\n');
}

const speechesOf = (config: DiscussionConfig): Speech[] =>
  (config.transcript ?? []).map(({ round, name, text }) => ({ round, name, text }));

/** 参与者不能重名 */
function duplicateNames(title: string, participants: { name: string }[]): string[] {
  const names = participants.map((p) => p.name);
  return new Set(names).size === names.length ? [] : [`讨论「${title}」里有重名的参与者`];
}

/**
 * 某位参与者某一轮的发言。fresh：接不上自己原来的会话（工作目录不在了），
 * 重新开会话说，带上完整题目和之前几轮的全部发言。
 */
function speech(
  snapshot: Snapshot,
  node: DiscussionNode,
  name: string,
  round: number,
  fresh = false,
): RunRequest {
  const config = node.config;
  const participant = (config.participants ?? []).find((p) => p.name === name);
  if (!participant) throw new Error(`讨论里没有参与者「${name}」`);
  const transcript = config.transcript ?? [];
  const previous = transcript.filter((t) => t.name === name && t.round === round - 1).at(-1);
  const others = speechesOf(config).filter((s) => s.round === round - 1 && s.name !== name);
  return {
    purpose: 'speech',
    model: participant.model,
    prompt: speechPrompt({
      context: contextOf(snapshot, node),
      name,
      stance: participant.stance,
      round,
      rounds: config.rounds ?? 1,
      others,
      newNotes: node.userNotes.slice(config.notesSeen ?? 0),
      ...(fresh && round > 1 ? { history: speechesOf(config).filter((s) => s.round < round) } : {}),
    }),
    inputsFrom: round === 1 || fresh ? inputsOf(snapshot, node) : [],
    ...(round > 1 && previous && !fresh ? { continueFrom: previous.runId } : {}),
    meta: { round, participant: name },
  };
}

function summary(snapshot: Snapshot, node: DiscussionNode): RunRequest {
  return {
    purpose: 'summary',
    goal: true,
    model: node.model,
    prompt: summaryPrompt({
      context: contextOf(snapshot, node),
      transcript: speechesOf(node.config),
    }),
    inputsFrom: inputsOf(snapshot, node),
    meta: {},
  };
}

/** 一轮发言：每位参与者各一次 */
function round(snapshot: Snapshot, node: DiscussionNode, n: number): Step<DiscussionConfig> {
  const requests = (node.config.participants ?? []).map((p) => speech(snapshot, node, p.name, n));
  return { requests, config: { ...node.config, round: n, notesSeen: node.userNotes.length } };
}

/** 一轮发言都结束了：下一轮，或者汇总 */
function afterRound(snapshot: Snapshot, node: DiscussionNode): Step<DiscussionConfig> {
  const current = node.config.round ?? 1;
  if (current < (node.config.rounds ?? 1)) return round(snapshot, node, current + 1);
  return { requests: [summary(snapshot, node)] };
}

const start = (snapshot: Snapshot, node: DiscussionNode) => round(snapshot, node, 1);

/** 停止后继续：这一轮没说完的重新说；都说完了就开下一轮或汇总 */
function resume(snapshot: Snapshot, node: DiscussionNode): Step {
  const config = node.config;
  const current = config.round ?? 0;
  if (current === 0) return start(snapshot, node);
  const spoke = new Set(
    (config.transcript ?? []).filter((t) => t.round === current).map((t) => t.name),
  );
  const missing = (config.participants ?? []).filter((p) => !spoke.has(p.name));
  if (missing.length === 0) return afterRound(snapshot, node);
  return { requests: missing.map((p) => speech(snapshot, node, p.name, current)) };
}

export const discussion: NodeKindPlugin<'discussion'> = {
  problems: (plan) => duplicateNames(plan.title, plan.participants),
  models: (plan) => [plan.model, ...plan.participants.map((p) => p.model)],
  toolProblems: () => [],
  estimate: (plan, rates) =>
    (plan.participants.length * plan.rounds + 1) * (rates.speech + rates.compute),
  config: (plan): DiscussionConfig => ({
    participants: plan.participants,
    rounds: plan.rounds,
    round: 0,
    transcript: [],
  }),
  plan: (node, common) => ({
    ...common,
    kind: 'discussion',
    participants: node.config.participants ?? [],
    rounds: node.config.rounds ?? 1,
  }),
  edit(node, body) {
    if (body.tools !== undefined) throw new HttpError(400, 'invalid_node', '只有干活节点能用工具');
    if (body.steps !== undefined) throw new HttpError(400, 'invalid_node', '只有工具节点有步骤');
    const problems = body.participants
      ? duplicateNames(body.title ?? node.title, body.participants)
      : [];
    if (problems.length) throw new HttpError(400, 'invalid_node', problems.join('；'));
    return {
      ...(body.participants ? { participants: body.participants } : {}),
      ...(body.rounds ? { rounds: body.rounds } : {}),
    };
  },
  body: (node) => ({
    tools: [],
    discussion: {
      participants: node.config.participants ?? [],
      rounds: node.config.rounds ?? 1,
      round: node.config.round ?? 0,
      transcript: speechesOf(node.config),
    },
    steps: null,
  }),
  // 汇总的会话不接着改：要改就重新讨论
  continuable: false,
  // 关卡没过时让汇总的 AI 接着改
  reworkable: true,
  switchable: true,
  listens: true,

  start,
  resume: (snapshot, node) => resume(snapshot, node),
  retry(snapshot, node, failed) {
    const { participant, round: n } = failed.meta;
    if (failed.purpose === 'speech' && participant && n)
      return { requests: [speech(snapshot, node, participant, n)] };
    if (failed.purpose === 'summary') return { requests: [summary(snapshot, node)] };
    // 汇总之后关卡退回的修改没做成：原会话还在就接着讨论，否则从头讨论
    return failed.meta.resumable
      ? resume(snapshot, { ...node, currentRunId: failed.id })
      : start(snapshot, node);
  },
  redo(snapshot, node, run) {
    const { participant, round: n } = run.meta;
    if (run.purpose === 'speech' && participant && n)
      return { requests: [speech(snapshot, node, participant, n, true)] };
    return redoOf(node, run, summary(snapshot, node));
  },
  // 发言属于当前这一轮就还算数；汇总和修改看节点当前那次运行
  current: (node, run) =>
    run.purpose === 'speech' ? run.meta.round === node.config.round : node.currentRunId === run.id,
  succeeded(snapshot, node, run, text) {
    if (run.purpose !== 'speech') return { deliver: true };
    // 发言记进讨论记录；这一轮都说完了就开下一轮或汇总
    const transcript = [
      ...(node.config.transcript ?? []),
      {
        round: run.meta.round ?? 0,
        name: run.meta.participant ?? '',
        text: text?.trim() || '（没有发言）',
        runId: run.id,
      },
    ];
    const config = { ...node.config, transcript };
    const done = openRuns(snapshot, node.id).length === 0;
    return {
      deliver: false,
      config,
      ...(done ? { next: afterRound(snapshot, { ...node, config }) } : {}),
    };
  },
  switchModel(node, run, model) {
    const who = run.meta.participant;
    if (run.purpose !== 'speech' || !who) return { model };
    const participants = (node.config.participants ?? []).map((p) =>
      p.name === who ? { ...p, model } : p,
    );
    return { config: { ...node.config, participants } };
  },
  live: false,
};
