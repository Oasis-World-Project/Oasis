// 拉群弹窗：群名、挑一种光（弹窗跟着变色）、叫哪些 AI（选中的站到弹窗的舞台上）、拉哪些好友。照原型 ⑦。
import { MAX_GROUP_AIS, type GroupLight } from '@oasis/contracts/group';
import { useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { avatarUrl, createGroup, friendsQuery, modelsQuery } from '../api/queries.ts';
import { AiAvatar, PersonAvatar } from '../ui/Avatar.tsx';

const LIGHTS: { id: GroupLight; label: string }[] = [
  { id: 'coral', label: '珊瑚' },
  { id: 'mint', label: '薄荷' },
  { id: 'sky', label: '晴空' },
  { id: 'honey', label: '蜂蜜' },
];
const FIELD =
  'h-[46px] min-w-0 rounded-full border-0 bg-glass-active px-[18px] text-[15px] text-ink shadow-[inset_0_0_0_1px_var(--oasis-track)]';
const CHIP =
  'flex h-10 cursor-pointer items-center gap-2 rounded-full border-0 py-0 pl-[5px] pr-3.5 text-[13px] text-ink';

export function NewGroupDialog({ onClose }: { onClose: () => void }) {
  const { data: models } = useQuery(modelsQuery);
  const { data: social } = useQuery(friendsQuery);
  const friends = social?.friends ?? [];
  const client = useQueryClient();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [light, setLight] = useState<GroupLight>('mint');
  const [picked, setPicked] = useState<string[]>([]);
  const [pulled, setPulled] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ais = (models ?? []).filter((model) => model.category === 'llm' && model.available);
  const perch = ais.filter((model) => picked.includes(model.key));
  const full = picked.length >= MAX_GROUP_AIS;

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const group = await createGroup({
        title: title.trim(),
        ais: picked,
        members: pulled,
        light,
      });
      await client.invalidateQueries({ queryKey: ['groups'] });
      // 进了新群，群列表页连同这个弹窗一起收起
      await navigate({ to: '/groups/$groupId', params: { groupId: group.id } });
    } catch (err) {
      setError(err instanceof Error ? err.message : '没建成，请重试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 box-border flex items-start justify-center overflow-y-auto bg-veil px-4 py-9 backdrop-blur-[14px]"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-label="拉个新群"
        data-light={light}
        onSubmit={(event) => void create(event)}
        className="oasis-room box-border flex w-[720px] max-w-full flex-col gap-4 rounded-dialog p-[26px] shadow-dialog"
      >
        <div className="flex items-start gap-3.5">
          <div className="flex-1">
            <h2 className="m-0 text-[32px] font-light leading-[1.2]">拉个新群</h2>
            <p className="mb-0 mt-1.5 text-[13.5px] text-ink-muted">
              挑一种光，叫上几个 AI。AI 进群后保持你给它的设定。
            </p>
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="flex size-[42px] cursor-pointer items-center justify-center rounded-full border-0 bg-bubble text-ink shadow-edge-bright"
          >
            <X size={15} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </div>

        <div aria-hidden="true" className="flex h-[92px] items-center justify-center gap-[18px]">
          {perch.map((model) => (
            <AiAvatar key={model.key} mono={model.mono} glow={model.glow} size={54} glowing />
          ))}
          {!perch.length && <span className="text-[13px] text-ink-muted">还没叫 AI</span>}
        </div>

        <div className="flex flex-col gap-4 rounded-[30px] bg-glass-strong p-5 shadow-edge-bright">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-[1_1_240px] flex-col gap-1.5 text-[12.5px] text-ink-muted">
              群名
              <input
                className={FIELD}
                value={title}
                maxLength={40}
                autoFocus
                placeholder="比如：城市夜跑小组"
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <div
              role="radiogroup"
              aria-label="群的光"
              className="flex gap-2 rounded-[26px] bg-bubble p-1.5"
            >
              {LIGHTS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={light === option.id}
                  aria-label={option.label}
                  data-light={option.id}
                  onClick={() => setLight(option.id)}
                  className={`light-swatch size-[34px] cursor-pointer rounded-full border-0 ${
                    light === option.id
                      ? 'shadow-[0_0_0_2px_var(--oasis-on-solid),0_0_0_3.5px_var(--oasis-ink)]'
                      : 'shadow-edge'
                  }`}
                />
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-2.5">
            <span className="text-[12.5px] text-ink-muted">
              叫哪些 AI 来（只有大语言模型能进群，最多 {MAX_GROUP_AIS} 个）
            </span>
            <div className="flex flex-wrap gap-1.5">
              {ais.map((model) => {
                const on = picked.includes(model.key);
                return (
                  <button
                    key={model.key}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    disabled={!on && full}
                    onClick={() =>
                      setPicked(
                        on ? picked.filter((key) => key !== model.key) : [...picked, model.key],
                      )
                    }
                    className={`${CHIP} disabled:cursor-not-allowed disabled:opacity-45 ${
                      on
                        ? 'bg-glass-active font-medium shadow-[0_0_0_1.5px_var(--oasis-ink)]'
                        : 'bg-glass shadow-[inset_0_0_0_1px_var(--oasis-well)]'
                    }`}
                  >
                    <AiAvatar mono={model.mono} glow={model.glow} size={30} />
                    {model.profile.name ?? model.name}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex flex-col gap-2.5">
            <span className="text-[12.5px] text-ink-muted">
              拉哪些好友（直接进群，不用对方同意；之后也能在成员里拉）
            </span>
            {friends.length === 0 ? (
              <span className="text-[12.5px] text-ink-muted">
                还没有好友：去「私聊」里按账号 ID 加。
              </span>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {friends.map(({ profile }) => {
                  const on = pulled.includes(profile.id);
                  return (
                    <button
                      key={profile.id}
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      onClick={() =>
                        setPulled(
                          on ? pulled.filter((id) => id !== profile.id) : [...pulled, profile.id],
                        )
                      }
                      className={`${CHIP} ${
                        on
                          ? 'bg-glass-active font-medium shadow-[0_0_0_1.5px_var(--oasis-ink)]'
                          : 'bg-glass shadow-[inset_0_0_0_1px_var(--oasis-well)]'
                      }`}
                    >
                      <PersonAvatar
                        label={profile.name}
                        size={30}
                        src={avatarUrl(profile.id, profile.avatarVersion)}
                      />
                      {profile.name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {error && (
          <p role="alert" className="m-0 text-[13px] text-accent">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="min-w-40 flex-1 text-[13.5px] text-ink-muted">
            {picked.length + pulled.length
              ? `你${pulled.length ? `、${pulled.length} 个好友` : ''}${picked.length ? `和 ${picked.length} 个 AI` : ''}`
              : '先只有你，好友和 AI 之后也能叫'}
          </span>
          <button
            disabled={busy || !title.trim()}
            className="h-12 cursor-pointer rounded-full border-0 bg-solid px-[26px] text-[15px] font-medium text-on-solid disabled:cursor-not-allowed disabled:opacity-45"
          >
            建群
          </button>
        </div>
      </form>
    </div>
  );
}
