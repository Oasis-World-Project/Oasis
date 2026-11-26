// 群页里几处都要用的小东西：真人头像的颜色、AI 的样子、时间分隔行。
import type { ModelEntry } from '@oasis/contracts/agent';
import type { GroupAi, GroupSnapshot } from '@oasis/contracts/group';

/** 群里的人按 ID 分到几种柔色头像里：自己总是第一种，别人各自固定一种 */
export function toneOf(userId: string, me: string | undefined): number {
  if (userId === me) return 0;
  let hash = 0;
  for (const char of userId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return 1 + (hash % 3);
}

/** 群里一个 AI 的样子：名字（群主给它起了名字就是那个）、头像上的字、光色、现在用的型号 */
export function aiLook(models: Map<string, ModelEntry>, key: string, fallback = key) {
  const model = models.get(key);
  return {
    name: model?.profile.name ?? model?.name ?? fallback,
    mono: model?.mono ?? fallback.slice(0, 2),
    glow: model?.glow ?? 'var(--oasis-hairline)',
    version: model?.versionLabel ?? '',
  };
}

/** 这个 AI 现在在做的每一轮：它自己那份会话的（群里的席位、私聊的家），和它名下的云端任务的 */
export const runsOf = (ai: GroupAi) => [
  ...(ai.runId ? [{ runId: ai.runId, callers: ai.callers }] : []),
  ...ai.tasks,
];
/** 这个 AI 在忙：有一轮在做 */
export const working = (ai: GroupAi) => runsOf(ai).length > 0;

const pad = (n: number) => String(n).padStart(2, '0');
const dayOf = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** 时间分隔行上的字：今天 01:58、昨天 21:10、11月3日 09:00 */
export function dividerText(at: Date, now: Date): string {
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const days = Math.round((dayOf(now) - dayOf(at)) / 86_400_000);
  if (days === 0) return `今天 ${time}`;
  if (days === 1) return `昨天 ${time}`;
  return `${at.getMonth() + 1}月${at.getDate()}日 ${time}`;
}

/** 两条消息隔了这么久，中间放一行时间 */
export const DIVIDER_GAP_MS = 10 * 60_000;

/** 群页头上的那行：4 个人和 5 个 AI */
export const headcount = (group: Pick<GroupSnapshot, 'memberCount' | 'aiCount'>) =>
  group.aiCount
    ? `${group.memberCount} 个人和 ${group.aiCount} 个 AI`
    : `${group.memberCount} 个人`;
