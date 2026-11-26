// 群页测试里造消息用的：人说的话、AI 的一轮（带步骤）、任务卡、分工单、群文件。
import type { GroupMessage } from '@oasis/contracts/group';

export const id = '00000000-0000-4000-8000-000000000061',
  me = '00000000-0000-4000-8000-000000000001',
  friend = '00000000-0000-4000-8000-000000000002',
  run = '00000000-0000-4000-8000-000000000071',
  oldRun = '00000000-0000-4000-8000-000000000072';
export const at = '2026-11-16T02:00:00Z';
export const uuid = (n: number) =>
  `00000000-0000-4000-8000-0000000002${String(n).padStart(2, '0')}`;
export const base = (seq: number, authorId: string, role: 'user' | 'assistant') => ({
  id: `00000000-0000-4000-8000-0000000001${String(seq).padStart(2, '0')}`,
  seq,
  authorId,
  displayName: authorId === 'claude' ? 'Claude' : authorId === me ? '我' : '阿杰',
  role,
  status: 'complete',
  error: null,
  createdAt: at,
});
export const said = (seq: number, authorId: string, content: string, data = {}) =>
  ({ ...base(seq, authorId, 'user'), content, kind: 'text', data }) as GroupMessage;
export const step = (n: string, status = 'done') => ({
  type: 'step' as const,
  id: n,
  tool: 'bash',
  label: `第 ${n} 步`,
  status,
});
export const aiSays = (seq: number, runId: string, parts: object[], patch = {}) =>
  ({
    ...base(seq, 'claude', 'assistant'),
    content: '',
    kind: 'text',
    data: { runId, parts, title: '排发布会流程' },
    ...patch,
  }) as GroupMessage;
export const card = (seq: number, runId: string, data = {}) =>
  ({
    ...base(seq, 'claude', 'assistant'),
    content: '任务结束',
    kind: 'task',
    data: {
      runId,
      title: '排发布会流程',
      status: 'done',
      startedAt: at,
      finishedAt: '2026-11-16T02:03:00Z',
      spentMicro: 1200,
      files: [
        { artifactId: uuid(1), name: '流程.md', path: '流程.md', size: 2048, category: 'doc' },
      ],
      ...data,
    },
  }) as GroupMessage;
/** Claude 发的分工单：第 1 项给 GLM（在做，是 run 那一轮），第 2 项给 Kimi（等第 1 项） */
export const plan = (seq: number, items: object[] = []) =>
  ({
    ...base(seq, 'claude', 'assistant'),
    content: '分工单：竞品 A 分析',
    kind: 'assign',
    data: {
      runId: oldRun,
      title: '竞品 A 分析',
      status: 'open',
      items: [
        { id: '1', key: 'glm', task: '做图表', after: [], status: 'running', runId: run },
        { id: '2', key: 'kimi', task: '写英文摘要', after: ['1'], status: 'waiting', runId: null },
        ...items,
      ],
    },
  }) as GroupMessage;
export const file = (n: number, path: string, patch = {}) => ({
  id: uuid(n),
  path,
  name: path.split('/').at(-1),
  size: 2048,
  madeBy: { kind: 'ai', id: 'claude' },
  changedBy: { kind: 'ai', id: 'claude' },
  runId: null,
  updatedAt: at,
  ...patch,
});
