// 画布按任务分框：私聊里的任务、自己当群主的群里的任务（任务卡）和它们的成果（成果上记着最近做出或改了它的那一轮）。
// 成品和素材（out/素材/ 里的）分开；应用目录里的文件归在应用下面，不单独列。最近的任务在前。
import type { ArtifactBody, ArtifactCategory } from '@oasis/contracts/canvas';
import type { TaskSummary } from '@oasis/contracts/conversation';

/** 素材放在 out/素材/ 下（成品直接放 out/） */
const MATERIALS = '素材/';

export interface TaskGroup {
  runId: string;
  /** 做它的那份会话（成果上记的也是它）：私聊自己，或派到云端的任务、群里的席位那一行 */
  conversationId: string;
  /** 聊天在哪：私聊或群的 ID */
  room: string;
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
  // 这个私聊的：它自己做的，和它派到云端的任务做的（各有一份会话）
  const roomOf = new Map(input.tasks.map((task) => [task.conversationId, task.room]));
  const here = (conversationId: string) =>
    !input.conversation || (roomOf.get(conversationId) ?? conversationId) === input.conversation;
  const all = input.artifacts.filter((item) => here(item.conversationId));
  const tasks = input.tasks.filter(
    (task) => !input.conversation || task.room === input.conversation,
  );
  const apps = all.filter((item) => item.application);
  const parentOf = (item: ArtifactBody) =>
    apps.find(
      (app) =>
        app.id !== item.id &&
        app.sessionId === item.sessionId &&
        item.path.startsWith(`${app.application!.root}/`),
    );
  /** 成果上记的那一轮算在哪个任务上：改过的任务，它做过的每一轮都算在最近那一轮名下 */
  const taskRun = new Map(
    tasks.flatMap((task) =>
      (task.runs ?? []).map((runId): [string, string] => [runId, task.runId]),
    ),
  );
  const runOf = (item: ArtifactBody) => taskRun.get(item.runId) ?? item.runId;
  const titleOf = new Map(tasks.map((task) => [task.runId, task.title]));
  const matching = all.filter((item) => {
    if (parentOf(item)) return false;
    if (!keyword) return true;
    const members = item.application
      ? all.filter((file) => parentOf(file)?.id === item.id).map((file) => file.path)
      : [];
    return [item.name, titleOf.get(runOf(item)) ?? item.task, ...members].some((text) =>
      text.toLowerCase().includes(keyword),
    );
  });
  const shown = category === 'all' ? matching : matching.filter((a) => a.category === category);

  const groups = new Map<string, TaskGroup>();
  for (const task of tasks)
    groups.set(task.runId, {
      runId: task.runId,
      conversationId: task.conversationId,
      room: task.room,
      title: task.title ?? '',
      task,
      finals: [],
      materials: [],
      at: Date.parse(task.startedAt),
    });
  for (const item of shown) {
    let group = groups.get(runOf(item));
    if (!group) {
      group = {
        runId: item.runId,
        conversationId: item.conversationId,
        room: roomOf.get(item.conversationId) ?? item.conversationId,
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
    // 主成果（AI 自己写明的）排在最前面
    const main = group.task?.main;
    group.finals.sort((a, b) => Number(b.path === main) - Number(a.path === main) || byPath(a, b));
    group.materials.sort(byPath);
  }
  return { groups: kept.sort((a, b) => b.at - a.at), matching };
}
