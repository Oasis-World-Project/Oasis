// 任务单卡：要交付什么、怎么算做好、风格与限制、AI 自己定的事，以及三档预算和大概用时（ADR 0016）。
// 等确认时可以选预算后确认、说要改哪里（在输入框里直接说，AI 改出新的一份）、或者不做了；只留最新一份。
import type { IntakeConfirmBody, SheetCard as SheetData } from '@oasis/contracts/conversation';
import { useState } from 'react';
import { cancelIntake, confirmIntake } from '../api/queries.ts';
import { formatUsd } from '../ui/format.ts';
import {
  CardActions,
  CardButton,
  CardFrame,
  CardHeading,
  Choice,
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

const TIER_LABELS = {
  economy: '省钱',
  standard: '标准',
  premium: '精细',
  custom: '自定义',
} as const;

/**
 * 选预算：三档各带金额和大概用时，或者自定义金额（不能低于最低预算）。
 * 预算只是参考，花完了也会照常做完；只有账户余额用完才会停。
 */
function BudgetPicker({
  quote,
  name,
  initialCustomMicro,
  disabled,
  onChange,
}: {
  quote: NonNullable<SheetData['quote']>;
  name: string;
  initialCustomMicro: number | null;
  disabled: boolean;
  onChange: (budget: IntakeConfirmBody | null) => void;
}) {
  const [tier, setTier] = useState<IntakeConfirmBody['tier']>(
    initialCustomMicro ? 'custom' : 'standard',
  );
  const [custom, setCustom] = useState(
    initialCustomMicro ? (initialCustomMicro / 1_000_000).toFixed(2) : '',
  );
  const report = (next: IntakeConfirmBody['tier'], text: string) => {
    if (next !== 'custom') return onChange({ tier: next });
    const micro = Math.round(Number(text) * 1_000_000);
    onChange(
      Number.isFinite(micro) && micro >= quote.minimumMicro
        ? { tier: next, customMicro: micro }
        : null,
    );
  };
  const tooLow = tier === 'custom' && !(Number(custom) * 1_000_000 >= quote.minimumMicro);
  return (
    <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
      <legend className="mb-2 p-0 text-[14.5px] font-medium">预算和大概用时</legend>
      <div className="flex flex-wrap gap-1.5">
        {quote.tiers.map((t) => (
          <Choice
            key={t.tier}
            name={name}
            label={`${TIER_LABELS[t.tier]} · ${formatUsd(t.micro)} · 约 ${t.minutes} 分钟`}
            checked={tier === t.tier}
            onChange={() => {
              setTier(t.tier);
              report(t.tier, custom);
            }}
            disabled={disabled}
            isDefault={t.tier === 'standard'}
          />
        ))}
        <Choice
          name={name}
          label="自定义"
          checked={tier === 'custom'}
          onChange={() => {
            setTier('custom');
            report('custom', custom);
          }}
          disabled={disabled}
        />
      </div>
      {tier === 'custom' && (
        <label className="flex items-center gap-2 text-[13.5px]">
          <span className="text-ink-muted">金额（美元）</span>
          <input
            type="number"
            inputMode="decimal"
            min={quote.minimumMicro / 1_000_000}
            step="0.01"
            aria-label="自定义预算（美元）"
            value={custom}
            onChange={(e) => {
              setCustom(e.target.value);
              report('custom', e.target.value);
            }}
            disabled={disabled}
            className="min-h-9 w-28 rounded-full bg-glass-active px-3.5 text-ink shadow-edge-strong outline-none focus-visible:outline-2 focus-visible:outline-accent"
          />
        </label>
      )}
      <p className="m-0 text-[12px] text-ink-muted">
        {tooLow
          ? `最低预算是 ${formatUsd(quote.minimumMicro)}。`
          : '预算只是参考：AI 团队按它安排力度，花完了也会照常做完；只有账户余额用完才会停。时间跟着预算变。'}
        {quote.rough ? ' 部分单价还没有记录，是粗估。' : ''}
      </p>
    </fieldset>
  );
}

/** 交付物以外的部分：确认前全部摊开，确认后收起来 */
function SheetDetails({ sheet }: { sheet: SheetData['sheet'] }) {
  return (
    <>
      <ItemList title="怎么算做好" items={sheet.criteria} />
      {sheet.requirements?.length ? (
        <ItemList title="原始要求" items={sheet.requirements.map((r) => r.text)} />
      ) : null}
      {sheet.materialWarnings?.length ? (
        <ItemList title="材料读取提示" items={sheet.materialWarnings} />
      ) : null}
      <ItemList title="风格与限制" items={sheet.style} />
      <ItemList title="素材" items={sheet.materials} />
      {sheet.budget && (
        <p className="m-0 text-[14px]">
          <span className="text-ink-muted">预算 </span>
          {TIER_LABELS[sheet.budget.tier]} ·{' '}
          <span className="font-display">{formatUsd(sheet.budget.micro)}</span>
          <span className="text-ink-muted"> · 约 {sheet.budget.minutes} 分钟</span>
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
  // 原话里说了花多少就默认按自定义金额；没报价时按标准档交出去
  const [budget, setBudget] = useState<IntakeConfirmBody | null>(() =>
    card.quote && sheet.budgetMicro
      ? sheet.budgetMicro >= card.quote.minimumMicro
        ? { tier: 'custom', customMicro: sheet.budgetMicro }
        : null
      : { tier: 'standard' },
  );

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
      {card.status === 'open' && card.quote && (
        <BudgetPicker
          quote={card.quote}
          name={`budget-${card.intakeId}`}
          initialCustomMicro={sheet.budgetMicro}
          disabled={busy}
          onChange={setBudget}
        />
      )}
      {card.status === 'open' && (
        <CardActions>
          <CardButton
            tone="accent"
            onClick={() =>
              budget &&
              void actions.run('confirm', () => confirmIntake(actions.conversationId, budget))
            }
            disabled={busy || !budget}
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
