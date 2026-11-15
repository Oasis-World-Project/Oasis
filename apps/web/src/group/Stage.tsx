// 舞台：群里的 AI 一排，在忙的身后发光、名字前的点亮起；点开是它的卡片（负责什么、在做什么、@ 它）。照原型 ②。
import type { GroupAi, GroupMessage } from '@oasis/contracts/group';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import {
  addGroupAi,
  modelsQuery,
  removeGroupAi,
  setGroupAiRole,
  stopGroupAi,
} from '../api/queries.ts';
import { ConfirmButton } from '../chat/parts.tsx';
import { AiAvatar } from '../ui/Avatar.tsx';
import { aiLook } from './people.ts';
import { Popover } from './RoomHeader.tsx';
import { useRoom } from './room.ts';

/** 这个 AI 现在在做什么：正在做的那一步；还没到第一步就是在想；有空 */
function statusOf(ai: GroupAi, messages: GroupMessage[]): string {
  if (!ai.runId) return '有空';
  const writing = messages.findLast(
    (m) => m.kind === 'text' && m.authorId === ai.key && m.status === 'streaming',
  );
  const step =
    writing?.kind === 'text'
      ? writing.data.parts?.findLast((part) => part.type === 'step' && part.status === 'running')
      : undefined;
  return step?.type === 'step' ? step.label : '正在想…';
}

function AiCard({ ai, onClose }: { ai: GroupAi; onClose: () => void }) {
  const { group, me, owner, models, busy, act, mention } = useRoom();
  const look = aiLook(models, ai.key);
  const [role, setRole] = useState(ai.role);
  const [editing, setEditing] = useState(false);
  const canStop = Boolean(ai.runId) && (owner || ai.callers.includes(me));
  return (
    <Popover
      label={look.name}
      onClose={onClose}
      className="left-[22px] top-full -mt-2.5 w-[300px] gap-3.5 rounded-pop p-[18px]"
    >
      <div className="flex items-center gap-3.5">
        <AiAvatar mono={look.mono} glow={look.glow} size={56} glowing />
        <div className="min-w-0 flex-1">
          <div className="text-[18px] font-medium leading-[1.3]">
            {look.name}
            {look.version && (
              <span className="ml-2 text-xs font-normal text-ink-muted">{look.version}</span>
            )}
          </div>
          {editing ? (
            <form
              className="mt-1 flex gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                void act(() => setGroupAiRole(group.id, ai.key, role.trim())).then((done) => {
                  if (done) setEditing(false);
                });
              }}
            >
              <input
                aria-label="在这个群里负责"
                value={role}
                maxLength={60}
                autoFocus
                onChange={(event) => setRole(event.target.value)}
                placeholder="比如：统筹、长文"
                className="h-8 min-w-0 flex-1 rounded-full border-0 bg-glass-active px-3 text-[12.5px] text-ink shadow-edge-strong"
              />
              <button
                disabled={busy}
                className="h-8 rounded-full border-0 bg-solid px-3 text-[12.5px] text-on-solid disabled:opacity-45"
              >
                好
              </button>
            </form>
          ) : (
            <div className="text-[12.5px] text-ink-muted">
              {ai.role ? `在这个群里负责${ai.role}` : '还没写它在这个群里负责什么'}
              {owner && (
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="ml-1.5 cursor-pointer border-0 bg-transparent p-0 text-[12.5px] text-ink underline underline-offset-4"
                >
                  {ai.role ? '改' : '写一下'}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 text-[13px]">
        <span
          aria-hidden="true"
          className={`size-[7px] rounded-full ${ai.runId ? '' : 'bg-dot-idle'}`}
          style={ai.runId ? { background: look.glow } : undefined}
        />
        <span className="min-w-0 truncate">{statusOf(ai, group.messages)}</span>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => {
            mention({ kind: 'ai', key: ai.key });
            onClose();
          }}
          className="h-[42px] flex-1 cursor-pointer rounded-full border-0 bg-solid text-sm font-medium text-on-solid"
        >
          @ 它
        </button>
        {owner && (
          <Link
            to="/ais/$key"
            params={{ key: ai.key }}
            className="flex h-[42px] flex-1 items-center justify-center rounded-full bg-well text-sm font-medium text-ink no-underline"
          >
            它的设定
          </Link>
        )}
      </div>
      {(canStop || owner) && (
        <div className="flex flex-wrap items-center gap-1">
          {canStop && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(() => stopGroupAi(group.id, ai.key))}
              className="h-9 cursor-pointer rounded-full border-0 bg-well px-3.5 text-[13px] text-ink disabled:opacity-45"
            >
              停下它这一轮
            </button>
          )}
          {owner && (
            <ConfirmButton
              label="移出群"
              question="移出后它不记得群里的事"
              confirmLabel="移出"
              disabled={busy}
              onConfirm={() =>
                void act(() => removeGroupAi(group.id, ai.key)).then((done) => {
                  if (done) onClose();
                })
              }
            />
          )}
        </div>
      )}
    </Popover>
  );
}

/** 群主叫 AI 进群：列出能聊天、还不在群里的 */
function AddAi({ onClose }: { onClose: () => void }) {
  const { group, busy, act } = useRoom();
  const { data: models } = useQuery(modelsQuery);
  const inGroup = new Set(group.ais.map((ai) => ai.key));
  const choices = (models ?? []).filter(
    (model) => model.category === 'llm' && model.available && !inGroup.has(model.key),
  );
  return (
    <Popover
      label="叫 AI 进群"
      onClose={onClose}
      className="left-[22px] top-full -mt-2.5 w-[420px] max-w-[calc(100%-44px)] gap-3 rounded-pop p-[18px]"
    >
      <span className="text-[15px] font-medium">叫哪个 AI 进群</span>
      <div className="flex flex-wrap gap-1.5">
        {choices.map((model) => (
          <button
            key={model.key}
            type="button"
            disabled={busy}
            onClick={() => void act(() => addGroupAi(group.id, model.key)).then(onClose)}
            className="flex h-10 cursor-pointer items-center gap-2 rounded-full border-0 bg-bubble py-0 pl-[5px] pr-3.5 text-[13px] text-ink shadow-edge-bright disabled:opacity-45"
          >
            <AiAvatar mono={model.mono} glow={model.glow} size={30} />
            {model.profile.name ?? model.name}
          </button>
        ))}
        {!choices.length && <span className="text-[13px] text-ink-muted">能叫的都在群里了</span>}
      </div>
    </Popover>
  );
}

export function Stage() {
  const { group, owner, models } = useRoom();
  const [open, setOpen] = useState<string | null>(null);
  const card = group.ais.find((ai) => ai.key === open);
  return (
    <>
      <div
        role="list"
        aria-label="群里的 AI"
        className="flex items-end gap-[22px] overflow-x-auto px-1 pb-[18px] pt-[22px]"
      >
        {group.ais.map((ai) => {
          const look = aiLook(models, ai.key);
          const busy = Boolean(ai.runId);
          return (
            <div role="listitem" key={ai.key} className="shrink-0">
              <button
                type="button"
                aria-label={`${look.name}，${busy ? '在忙' : '有空'}`}
                aria-expanded={open === ai.key}
                onClick={() => setOpen(open === ai.key ? null : ai.key)}
                className="flex cursor-pointer flex-col items-center gap-2 border-0 bg-transparent p-0 text-ink"
              >
                <AiAvatar mono={look.mono} glow={look.glow} size={56} glowing={busy} />
                <span className="flex items-center gap-[5px] text-xs font-medium">
                  <span
                    aria-hidden="true"
                    className={`size-1.5 rounded-full ${busy ? '' : 'bg-dot-idle'}`}
                    style={busy ? { background: look.glow } : undefined}
                  />
                  {look.name}
                </span>
              </button>
            </div>
          );
        })}
        {owner && group.ais.length < 8 && (
          <div role="listitem" className="shrink-0">
            <button
              type="button"
              aria-label="叫 AI 进群"
              aria-expanded={open === '+'}
              onClick={() => setOpen(open === '+' ? null : '+')}
              className="flex cursor-pointer flex-col items-center gap-2 border-0 bg-transparent p-0 text-ink-muted"
            >
              <span className="flex size-14 items-center justify-center rounded-[17px] border border-dashed border-hairline bg-glass-strong">
                <Plus size={18} aria-hidden="true" />
              </span>
              <span className="text-xs">叫 AI</span>
            </button>
          </div>
        )}
        {!owner && !group.ais.length && (
          <span className="pb-1 text-[13px] text-ink-muted">群里还没有 AI，群主可以叫它们进来</span>
        )}
      </div>
      {card && <AiCard ai={card} onClose={() => setOpen(null)} />}
      {open === '+' && <AddAi onClose={() => setOpen(null)} />}
    </>
  );
}
