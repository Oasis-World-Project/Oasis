// 画布按任务分框：私聊里的任务、自己当群主的群里的任务（任务卡）和它们的成果（成果上记着最近做出或改了它的那一轮）。
// 成品和素材（out/素材/ 里的）分开；应用目录里的文件归在应用下面，不单独列。最近的任务在前。
import type { ArtifactBody, ArtifactCategory } from '@oasis/contracts/canvas';
import type { TaskSummary } from '@oasis/contracts/conversation';
import { MATERIALS } from '../chat/run-progress.ts';

export interface TaskGroup {
  runId: string;
  conversationId: string;
  title: string;
  /** 任务卡（状态、用时、花费）；以前登记的成果没有 */
  task?: TaskSummary;
  finals: ArtifactBody[];
  materials: ArtifactBody[];
  /** 排序用：任务开始的时间，没有任务卡用最新成果的时间 */
  at: number;
}

const byPath = (a: ArtifactBody, b: ArtifactBody) =>
  a.path.localeCompare(b.path, 'zh-CN', { numeric: true });

export function groupTasks(input: {
  artifacts: ArtifactBody[];
  tasks: TaskSummary[];
  category: ArtifactCategory | 'all';
  /** 搜索词（小写） */
  keyword: string;
  /** 只看这个私聊的 */
  conversation?: string;
}): {
  groups: TaskGroup[];
  /** 搜索后的成果（各类别的数量按它算） */
  matching: ArtifactBody[];
} {
  const { category, keyword } = input;
  const mine = <T extends { conversationId: string }>(list: T[]) =>
    input.conversation ? list.filter((item) => item.conversationId === input.conversation) : list;
  const all = mine(input.artifacts);
  const tasks = mine(input.tasks);
  const apps = all.filter((item) => item.application);
  const parentOf = (item: ArtifactBody) =>
    apps.find(
      (app) =>
        app.id !== item.id &&
        app.sessionId === item.sessionId &&
        item.path.startsWith(`${app.application!.root}/`),
    );
  const titleOf = new Map(tasks.map((task) => [task.runId, task.title]));
  const matching = all.filter((item) => {
    if (parentOf(item)) return false;
    if (!keyword) return true;
    const members = item.application
      ? all.filter((file) => parentOf(file)?.id === item.id).map((file) => file.path)
      : [];
    return [item.name, titleOf.get(item.runId) ?? item.task, ...members].some((text) =>
      text.toLowerCase().includes(keyword),
    );
  });
  const shown = category === 'all' ? matching : matching.filter((a) => a.category === category);

  const groups = new Map<string, TaskGroup>();
  for (const task of tasks)
    groups.set(task.runId, {
      runId: task.runId,
      conversationId: task.conversationId,
      title: task.title ?? '',
      task,
      finals: [],
      materials: [],
      at: Date.parse(task.startedAt),
    });
  for (const item of shown) {
    let group = groups.get(item.runId);
    if (!group) {
      group = {
        runId: item.runId,
        conversationId: item.conversationId,
        title: '',
        finals: [],
        materials: [],
        at: 0,
      };
      groups.set(item.runId, group);
    }
    group.title ||= item.task;
    if (!group.task) group.at = Math.max(group.at, Date.parse(item.createdAt));
    (item.path.startsWith(MATERIALS) ? group.materials : group.finals).push(item);
  }
  // 筛了类别时只留有这类成果的；搜索时任务名对得上也留；都没筛时没有成果的任务也列出来（看过程）
  const kept = [...groups.values()].filter((group) => {
    if (group.finals.length + group.materials.length) return true;
    if (category !== 'all') return false;
    if (keyword) return group.title.toLowerCase().includes(keyword);
    return !!group.task;
  });
  for (const group of kept) {
    group.title ||= '未命名任务';
    group.finals.sort(byPath);
    group.materials.sort(byPath);
  }
  return { groups: kept.sort((a, b) => b.at - a.at), matching };
}
