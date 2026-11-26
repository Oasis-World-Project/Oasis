// 任务几处都要用的：状态怎么写（进行中、已完成、修改中……）、用时怎么写、进行中每秒走一次的钟。
import { taskPhase, type TaskCard as TaskData } from '@oasis/contracts/conversation';
import { useEffect, useState } from 'react';

const STATUS: Record<TaskData['status'], { label: string; tone: 'muted' | 'accent' | 'solid' }> = {
  running: { label: '进行中', tone: 'accent' },
  done: { label: '已完成', tone: 'solid' },
  stopped: { label: '已停下', tone: 'muted' },
  failed: { label: '出错了', tone: 'accent' },
};
/** 任务卡上的状态：改一个做完过的任务时是「修改中」 */
export const taskStatus = (card: Pick<TaskData, 'status' | 'revision'>) =>
  taskPhase(card) === 'fixing' ? { label: '修改中', tone: 'accent' as const } : STATUS[card.status];

/** 用时：几小时几分、几分几秒 */
export function elapsedText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes >= 60) return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
  return minutes ? `${minutes} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
}

/** 进行中每秒走一次 */
export function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}
