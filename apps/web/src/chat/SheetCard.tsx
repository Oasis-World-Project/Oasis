// 任务单卡：大活开工前 AI 回复里的 ```oasis-plan 代码块（做什么、几步、大概花多少）。
// 最新的那份可以确认（发一句「确认，开始做」），或者在输入框里说要改哪里。
import type { PlanBlock } from '@oasis/contracts/conversation';
import { CardActions, CardButton, CardHeading } from './parts.tsx';
import { useChatActions } from './use-chat-actions.ts';

export function SheetCard({ block, active }: { block: PlanBlock; active: boolean }) {
  const actions = useChatActions();
  const busy = actions.busy !== null;
  return (
    <section
      aria-label="任务单"
      className="flex flex-col gap-3 rounded-item bg-glass-active px-4 py-3.5 shadow-edge-strong"
    >
      <CardHeading kind="任务单" title={block.title} />
      <ol className="m-0 flex flex-col gap-1 pl-5 text-[14px] leading-relaxed">
        {block.steps.map((step, index) => (
          <li key={index}>{step}</li>
        ))}
      </ol>
      {block.estimate && <p className="m-0 text-[13px] text-ink-muted">预计 {block.estimate}</p>}
      {active && (
        <CardActions>
          <CardButton
            tone="accent"
            disabled={busy}
            onClick={() => void actions.say('confirm', '确认，开始做')}
          >
            {actions.busy === 'confirm' ? '正在发…' : '确认，开始做'}
          </CardButton>
          <CardButton
            disabled={busy}
            onClick={() => actions.focusComposer('说说要改哪里，比如：分镜改成 4 个')}
          >
            要改一下
          </CardButton>
        </CardActions>
      )}
    </section>
  );
}
