// 一轮进行中，AI 要做超出权限的事、要用花钱的工具时，输入框上面出确认卡：允许一次 / 以后都允许 / 拒绝。
// 卡来自这一轮的状态（model-gateway 登记，conversation 跟进时放进来）；点了马上收起，AI 接着做。
import type { MessageBody, MessageList } from '@oasis/contracts/conversation';
import type { Confirmation, ConfirmDecision } from '@oasis/contracts/model-gateway';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Coins, ShieldAlert } from 'lucide-react';
import { ApiError } from '../api/client.ts';
import { confirmTurn, dmsQuery, messagesQuery } from '../api/queries.ts';

const DECISIONS: { decision: ConfirmDecision; label: string }[] = [
  { decision: 'once', label: '允许一次' },
  { decision: 'always', label: '以后都允许' },
  { decision: 'deny', label: '拒绝' },
];

/** 卡上那条命令：AI 消息里编号对得上的那一步的说明 */
function stepOf(messages: MessageBody[], callId: string | null) {
  if (!callId) return undefined;
  for (const message of messages)
    if (message.kind === 'text')
      for (const part of message.data.parts ?? [])
        if (part.type === 'step' && part.id === callId) return part.label;
  return undefined;
}

export function ConfirmationCards({
  conversationId,
  cards,
  messages,
}: {
  conversationId: string;
  cards: Confirmation[];
  messages: MessageBody[];
}) {
  const queryClient = useQueryClient();
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: ConfirmDecision }) =>
      confirmTurn(conversationId, id, decision),
    onSuccess: (decided, { decision }) => {
      // 马上收起（「以后都允许」连同类的一起），不等下一次刷新
      const always = decision === 'always' && decided.status === 'allowed';
      queryClient.setQueryData(
        messagesQuery(conversationId).queryKey,
        (old: MessageList | undefined) =>
          old?.turn
            ? {
                ...old,
                turn: {
                  ...old.turn,
                  confirmations: old.turn.confirmations.filter(
                    (card) => card.id !== decided.id && !(always && card.kind === decided.kind),
                  ),
                },
              }
            : old,
      );
    },
    // 「以后都允许」改了这个私聊的权限
    onSettled: () => queryClient.invalidateQueries({ queryKey: dmsQuery.queryKey }),
  });
  if (cards.length === 0) return null;
  return (
    <div role="group" aria-label="等你确认" className="flex flex-col gap-2">
      {cards.map((card) => {
        const command = card.kind === 'command' ? stepOf(messages, card.callId) : undefined;
        const Icon = card.kind === 'tool' ? Coins : ShieldAlert;
        return (
          <div
            key={card.id}
            className="flex flex-col gap-2 rounded-card bg-glass-strong px-4 py-3 shadow-edge-strong"
          >
            <p className="m-0 flex items-center gap-2 text-[13.5px] font-medium text-ink">
              <Icon size={16} aria-hidden="true" />
              {card.kind === 'tool' ? '要用花钱的工具，可以吗？' : 'AI 要做超出权限的事，可以吗？'}
            </p>
            <p className="m-0 text-[13px] text-ink-muted [overflow-wrap:anywhere]">{card.text}</p>
            {command && (
              <code className="rounded-item bg-glass-active px-3 py-1.5 text-[12.5px] text-ink [overflow-wrap:anywhere]">
                {command}
              </code>
            )}
            <div className="flex flex-wrap gap-2">
              {DECISIONS.map(({ decision, label }) => (
                <button
                  key={decision}
                  type="button"
                  disabled={decide.isPending}
                  title={
                    decision === 'always'
                      ? card.kind === 'tool'
                        ? '这个私聊以后用花钱的工具都不问'
                        : '这个私聊以后超出权限的事都直接做'
                      : undefined
                  }
                  onClick={() => decide.mutate({ id: card.id, decision })}
                  className={`h-8 rounded-full border-0 px-3.5 text-[12.5px] disabled:opacity-50 ${
                    decision === 'once'
                      ? 'bg-accent font-medium text-on-accent'
                      : 'bg-glass-active text-ink shadow-edge-strong'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        );
      })}
      {decide.isError && (
        <p role="alert" className="m-0 text-[13px] text-accent">
          {decide.error instanceof ApiError ? decide.error.message : '没点上，请重试'}
        </p>
      )}
    </div>
  );
}
