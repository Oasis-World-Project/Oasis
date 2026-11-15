// 「我」页里的资料：头像、账号 ID（别人按它加我）、名字、签名、性别、地区。
import type { Gender, MeBody } from '@oasis/contracts/identity';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { avatarUrl, clearAvatar, setAvatar, updateProfile } from '../api/queries.ts';
import { PersonAvatar } from '../ui/Avatar.tsx';

const FIELD =
  'h-11 min-w-0 rounded-item border-0 bg-glass-active px-3.5 text-[15px] text-ink shadow-edge-strong';
const PLAIN =
  'h-10 cursor-pointer rounded-full border-0 bg-glass-active px-4 text-[13.5px] text-ink shadow-edge-strong disabled:cursor-not-allowed disabled:opacity-45';
const GENDERS: { id: Gender; label: string }[] = [
  { id: '', label: '不说' },
  { id: 'female', label: '女' },
  { id: 'male', label: '男' },
  { id: 'other', label: '其他' },
];
/** 头像存成多大的方图（像素） */
const AVATAR_SIDE = 256;

/** 选的图片裁成正中的方块、缩小，转成 JPEG（透明的地方铺白），返回内容的 base64 */
async function shrink(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = AVATAR_SIDE;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('这个浏览器处理不了图片');
  context.fillStyle = 'white';
  context.fillRect(0, 0, AVATAR_SIDE, AVATAR_SIDE);
  context.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    AVATAR_SIDE,
    AVATAR_SIDE,
  );
  const url = canvas.toDataURL('image/jpeg', 0.85);
  return url.slice(url.indexOf(',') + 1);
}

export function ProfileForm({ me }: { me: MeBody }) {
  const client = useQueryClient();
  const picker = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(me.name);
  const [bio, setBio] = useState(me.bio);
  const [gender, setGender] = useState<Gender>(me.gender);
  const [region, setRegion] = useState(me.region);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const changed =
    name.trim() !== me.name ||
    bio.trim() !== me.bio ||
    gender !== me.gender ||
    region.trim() !== me.region;

  /** 做一件事，返回的新资料换进来（侧栏、群里看到的跟着变） */
  async function run(work: () => Promise<MeBody>, done: string) {
    setBusy(true);
    setNote(null);
    try {
      client.setQueryData(['me'], await work());
      setNote({ text: done, bad: false });
    } catch (err) {
      setNote({ text: err instanceof Error ? err.message : '没存上，请重试', bad: true });
    } finally {
      setBusy(false);
    }
  }
  const save = (event: FormEvent) => {
    event.preventDefault();
    void run(
      () => updateProfile({ name: name.trim(), bio: bio.trim(), gender, region: region.trim() }),
      '存好了',
    );
  };

  return (
    <form onSubmit={save} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-4">
        <PersonAvatar label={me.name} size={72} src={avatarUrl(me.id, me.avatarVersion)} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-xs text-ink-muted">账号 ID（别人按它加你为好友，不能改）</span>
          <span className="flex items-center gap-2.5">
            <span className="font-display text-xl">{me.accountNo}</span>
            <button
              type="button"
              className={PLAIN}
              onClick={() =>
                void navigator.clipboard
                  .writeText(me.accountNo)
                  .then(() => setNote({ text: '账号 ID 复制好了', bad: false }))
              }
            >
              复制
            </button>
          </span>
        </div>
        <input
          ref={picker}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          aria-label="选一张图片当头像"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file)
              void run(async () => setAvatar('image/jpeg', await shrink(file)), '头像换好了');
          }}
        />
        <button
          type="button"
          className={PLAIN}
          disabled={busy}
          onClick={() => picker.current?.click()}
        >
          换头像
        </button>
        {me.avatarVersion > 0 && (
          <button
            type="button"
            className={PLAIN}
            disabled={busy}
            onClick={() => void run(clearAvatar, '头像去掉了')}
          >
            去掉头像
          </button>
        )}
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
        <label className="flex flex-col gap-1.5 text-[12.5px] text-ink-muted">
          名字
          <input
            className={FIELD}
            value={name}
            maxLength={20}
            autoComplete="nickname"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-[12.5px] text-ink-muted">
          地区
          <input
            className={FIELD}
            value={region}
            maxLength={30}
            onChange={(event) => setRegion(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-[12.5px] text-ink-muted">
          性别
          <select
            className={FIELD}
            value={gender}
            onChange={(event) => setGender(event.target.value as Gender)}
          >
            {GENDERS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="flex flex-col gap-1.5 text-[12.5px] text-ink-muted">
        签名
        <input
          className={FIELD}
          value={bio}
          maxLength={60}
          placeholder="一句话介绍自己"
          onChange={(event) => setBio(event.target.value)}
        />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button
          disabled={busy || !changed || !name.trim()}
          className="h-11 cursor-pointer rounded-full border-0 bg-solid px-6 text-sm font-medium text-on-solid disabled:cursor-not-allowed disabled:opacity-45"
        >
          保存资料
        </button>
        {note && (
          <span
            role={note.bad ? 'alert' : 'status'}
            className={`text-[13px] ${note.bad ? 'text-accent' : 'text-ink-muted'}`}
          >
            {note.text}
          </span>
        )}
      </div>
    </form>
  );
}
