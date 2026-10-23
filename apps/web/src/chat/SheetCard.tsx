// 任务单卡：要交付什么、怎么算做好、风格与限制、AI 自己定的事。
// 等确认时可以确认、说要改哪里（在输入框里直接说，AI 改出新的一份）、或者不做了；只留最新一份。
import type { SheetCard as SheetData } from '@oasis/contracts/conversation';
import { cancelIntake, confirmIntake } from '../api/queries.ts';
import { formatUsd } from '../ui/format.ts';
import {
  CardActions,
  CardButton,
  CardFrame,
  CardHeading,
  ItemList,
  StatusTag,
  type Speaker,
} from './parts.tsx';
import { useChatActions } from './use-chat-actions.ts';

const STATUS: Record<SheetData['status'], { label: string; tone: 'muted' | 'accent' | 'solid' }> = {
  open: { label: '等你确认', tone: 'accent' },
  confirmed: { label: '已交给 AI 团队', tone: 'solid' },
  superseded: { label: '已改成新的一份', tone: 'muted' },
  cancelled: { label: '不做了', tone: 'muted' },
};

/** 交付物以外的部分：确认前全部摊开，确认后收起来 */
function SheetDetails({ sheet }: { sheet: SheetData['sheet'] }) {
  return (
    <>
      <ItemList title="怎么算做好" items={sheet.criteria} />
      <ItemList title="风格与限制" items={sheet.style} />
      <ItemList title="素材" items={sheet.materials} />
      {sheet.budgetMicro !== null && (
        <p className="m-0 text-[14px]">
          <span className="text-ink-muted">花费上限 </span>
          <span className="font-display">{formatUsd(sheet.budgetMicro)}</span>
        </p>
      )}
      {sheet.assumptions.length > 0 && (
        <details className="rounded-item bg-glass-active/60 px-3.5 py-2.5">
          <summary className="cursor-pointer text-[13px] text-ink-muted">
            AI 自己定的事（{sheet.assumptions.length} 条，不用确认）
          </summary>
          <div className="pt-2">
            <ItemList items={sheet.assumptions} />
          </div>
        </details>
      )}
    </>
  );
}

export function SheetCard({ card, speaker }: { card: SheetData; speaker: Speaker }) {
  const actions = useChatActions();
  const { sheet } = card;
  const busy = actions.busy !== null;
  const status = STATUS[card.status];
  const past = card.status === 'superseded' || card.status === 'cancelled';

  return (
    <CardFrame speaker={speaker} label="任务单" dim={past} glowing={actions.busy === 'confirm'}>
      <CardHeading
        kind="任务单"
        title={sheet.title}
        status={<StatusTag tone={status.tone}>{status.label}</StatusTag>}
      />
      {card.intro && card.status === 'open' && (
        <p className="m-0 text-[14.5px] leading-relaxed">{card.intro}</p>
      )}
      {!past && (
        <ItemList
          title="要交付的东西"
          items={sheet.deliverables.map((d) => (
            <>
              {d.name}
              <span className="text-ink-muted"> · {d.form}</span>
            </>
          ))}
        />
      )}
      {card.status === 'open' && <SheetDetails sheet={sheet} />}
      {card.status === 'confirmed' && (
        <details className="rounded-item bg-glass-active/60 px-3.5 py-2.5">
          <summary className="cursor-pointer text-[13px] text-ink-muted">看完整任务单</summary>
          <div className="flex flex-col gap-3.5 pt-3">
            <SheetDetails sheet={sheet} />
          </div>
        </details>
      )}
      {card.status === 'open' && (
        <CardActions>
          <CardButton
            tone="accent"
            onClick={() => void actions.run('confirm', () => confirmIntake(actions.conversationId))}
            disabled={busy}
          >
            {actions.busy === 'confirm' ? '正在交出去…' : '确认，开始做'}
          </CardButton>
          <CardButton
            onClick={() => actions.focusComposer('说说要改哪里，比如：风格改成清新一点')}
            disabled={busy}
          >
            要改一下
          </CardButton>
          <CardButton
            tone="text"
            onClick={() => void actions.run('cancel', () => cancelIntake(actions.conversationId))}
            disabled={busy}
          >
            不做了
          </CardButton>
        </CardActions>
      )}
    </CardFrame>
  );
}
