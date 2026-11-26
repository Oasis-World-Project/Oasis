// 画布里打开一个成果（照原型 ⑨–⑬ ㉘ ㉙）。顶栏一直在：回画布、哪个任务的哪个文件（能换这个任务的别的成果）、
// 看过程、下载、「编辑」。中间是成果本身（图片、视频、音频、PDF、文字、表格直接看；网页和静态应用在本机隔离框里运行；
// 3D 模型能转着看；数字人能对话；带后端的应用只能下载）。进了「编辑」，看和改是同一个画面：在上面指一处说怎么改，
// 右边一栏列着要改的地方，「让 AI 改」发进做它的那段对话（canvas/EditPanel.tsx）。
import type { Annotation } from '@oasis/contracts/canvas';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, Download } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../api/client.ts';
import {
  appArchiveUrl,
  artifactContentUrl,
  artifactQuery,
  artifactsQuery,
  dmsQuery,
  saveAnnotations,
  tasksQuery,
} from '../api/queries.ts';
import { useModelMap } from '../api/use-model-map.ts';
import { AvatarPreview } from '../canvas/AvatarPreview.tsx';
import { EditPanel } from '../canvas/EditPanel.tsx';
import { EditSurface, type Jump, type Place } from '../canvas/EditSurface.tsx';
import {
  CHIPS,
  HINTS,
  nextNumber,
  pdfCompanion,
  reviewName,
  surfaceOf,
  whereOf,
} from '../canvas/edits.ts';
import { LivePreview } from '../canvas/LivePreview.tsx';
import { AVATAR_FIELDS, fieldsFor, mediaLook, type Values } from '../canvas/parameters.ts';
import { previewKindOf } from '../chat/files.ts';

const route = getRouteApi('/shell/canvas/artifacts/$artifactId');

const ROUND =
  'flex size-10 shrink-0 items-center justify-center rounded-full bg-glass-active text-ink no-underline shadow-edge-strong';
const PILL =
  'flex h-10 shrink-0 cursor-pointer items-center rounded-full border-0 px-4 text-[13.5px] no-underline';
/** 「直接调」里改了能在画面上马上看到的项（只是近似效果） */
const PREVIEWABLE: Partial<Record<string, string[]>> = {
  video: ['亮度', '色温'],
  audio: ['语速', '音量（只能听到调低）'],
};
const OVERALL: Partial<Record<string, string>> = {
  image: '比如：整体再暖一点',
  video: '比如：节奏再快一点',
  audio: '比如：语气再轻松一点',
  live: '比如：整体换成暖色',
};

/** 弹出来的「这里要怎么改？」：选中了哪，写一句怎么改（下面几个常用的说法点一下就填上），「记下」 */
function Composer({
  where,
  chips,
  saving,
  onSave,
  onCancel,
}: {
  where: string;
  chips: string[];
  saving: boolean;
  onSave: (note: string) => void;
  onCancel: () => void;
}) {
  const [note, setNote] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (note.trim()) onSave(note.trim());
  };
  return (
    <form
      aria-label="这里要怎么改"
      onSubmit={submit}
      onKeyDown={(event) => event.key === 'Escape' && onCancel()}
      className="flex flex-col gap-2.5 rounded-[22px] bg-bubble p-3.5 text-left shadow-panel"
    >
      <span className="text-xs text-ink-muted">
        选中了：<span className="font-medium text-ink">{where}</span>
      </span>
      <input
        aria-label="这里要怎么改"
        autoFocus
        maxLength={500}
        value={note}
        placeholder="这里要怎么改？"
        onChange={(event) => setNote(event.target.value)}
        className="h-10 rounded-full border-0 bg-well px-3.5 text-[13.5px] text-ink outline-none placeholder:text-ink-muted"
      />
      <div className="flex flex-wrap items-center gap-1.5">
        {chips.map((chip) => (
          <button
            key={chip}
            type="button"
            onClick={() => setNote(chip)}
            className="h-7 cursor-pointer rounded-full border-0 bg-well px-2.5 text-xs text-ink"
          >
            {chip}
          </button>
        ))}
        <span className="flex-1" />
        <button
          type="button"
          onClick={onCancel}
          className="h-8 cursor-pointer rounded-full border-0 bg-transparent px-2 text-[12.5px] text-ink-muted"
        >
          算了
        </button>
        <button
          type="submit"
          disabled={saving || !note.trim()}
          className="h-8 cursor-pointer rounded-full border-0 bg-accent px-3.5 text-[12.5px] font-medium text-on-accent disabled:cursor-not-allowed disabled:opacity-45"
        >
          记下
        </button>
      </div>
    </form>
  );
}

export function ArtifactPage() {
  const { artifactId } = route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const models = useModelMap();
  const { data: artifact, isPending, isError } = useQuery(artifactQuery(artifactId));
  // 同一个话题的成果：网页按相对地址引用它们；同一个任务的可以在顶栏换着看
  const { data: siblings = [] } = useQuery({
    ...artifactsQuery({ sessionId: artifact?.sessionId }),
    enabled: !!artifact,
  });
  const { data: dms = [] } = useQuery({ ...dmsQuery, refetchInterval: 5_000 });
  const dm = artifact ? dms.find((item) => item.id === artifact.conversationId) : undefined;
  // 群里的 AI 做的（自己是群主）：「让 AI 改」发进那个群，@ 做它的 AI
  const { data: tasks = [] } = useQuery(tasksQuery);
  const task = artifact
    ? tasks.find((item) => item.runId === artifact.runId || item.runs?.includes(artifact.runId))
    : undefined;
  const from = task?.group ? { ...task.group, seat: task.conversationId } : undefined;
  const makerKey = from?.key ?? dm?.modelKey ?? undefined;
  const maker = makerKey ? models.get(makerKey) : undefined;

  /** 「编辑」开着没有；换一个成果时自动关掉 */
  const [editingFor, setEditingFor] = useState<string | null>(null);
  const editing = editingFor === artifactId;
  /** 运行着的成果：点一下是操作它，还是选取 */
  const [picking, setPicking] = useState(true);
  const [pending, setPending] = useState<Place | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [jump, setJump] = useState<Jump | null>(null);
  const [values, setValues] = useState<Values>({});
  const [notice, setNotice] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (next: Annotation[]) => saveAnnotations(artifactId, next),
    onSuccess: (body) => {
      queryClient.setQueryData(artifactQuery(artifactId).queryKey, body);
      void queryClient.invalidateQueries({ queryKey: ['artifacts'] });
    },
  });

  if (isPending || isError || !artifact)
    return (
      <section aria-label="成果" className="glass flex min-h-0 flex-1 flex-col rounded-panel p-6">
        <Link to="/canvas" aria-label="回到画布" className={ROUND}>
          <ArrowLeft size={17} aria-hidden="true" />
        </Link>
        <p className={`m-0 pt-6 text-sm ${isError ? 'text-accent' : 'text-ink-muted'}`}>
          {isError ? '没找到这个成果。' : '正在打开…'}
        </p>
      </section>
    );

  const edits = artifact.annotations;
  const kind = previewKindOf(artifact.path);
  const pdf = pdfCompanion(artifact, siblings);
  const staticApp = artifact.application?.kind === 'static' ? artifact.application : undefined;
  const appEntry = staticApp
    ? siblings.find((item) => item.path === `${staticApp.root}/${staticApp.entry}`)
    : undefined;
  // 同一话题的文件：网页按相对地址引用它们（图片、脚本、样式等）
  const assets = siblings.map((item) => ({ path: item.path, url: artifactContentUrl(item.id) }));
  // 单独打开静态应用里的网页时，以 / 开头的地址仍按应用根目录算
  const pageRoot = siblings.find(
    (item) =>
      item.application?.kind === 'static' && artifact.path.startsWith(`${item.application.root}/`),
  )?.application?.root;
  const live = artifact.application ? (
    appEntry && staticApp ? (
      <LivePreview
        key={appEntry.id}
        file={{ path: appEntry.path, url: artifactContentUrl(appEntry.id) }}
        name={staticApp.root}
        root={staticApp.root}
        assets={assets}
      />
    ) : (
      <p className="m-0 p-6 text-sm text-ink-muted">
        {staticApp
          ? `应用的入口 ${staticApp.root}/${staticApp.entry} 没有交付，没法在这里运行。`
          : '这个应用带后端，不能在画布里运行。请下载后在电脑上用 Node 启动。'}
      </p>
    )
  ) : undefined;
  const surface = surfaceOf(kind, !!pdf, !!live);
  // 数字人是实时对话，不在画面上指：只有「直接调」和整体的要求
  const fields = artifact.avatar ? AVATAR_FIELDS : fieldsFor(kind);
  // 这个任务的别的成果（应用里的文件不单列）
  const others = siblings.filter(
    (item) =>
      item.runId === artifact.runId &&
      !siblings.some(
        (app) =>
          app.application && app.id !== item.id && item.path.startsWith(`${app.application.root}/`),
      ),
  );

  const place = (next: Place) => {
    if (nextNumber(edits) === null) {
      setNotice('一份成果最多记 50 处，先删掉几条');
      return;
    }
    setNotice(null);
    setSelected(null);
    setPending(next);
  };
  const add = (note: string) => {
    const number = nextNumber(edits);
    if (!pending || number === null) return;
    save.mutate(
      [
        ...edits,
        {
          id: crypto.randomUUID(),
          number,
          note,
          page: pending.page,
          time: pending.time,
          quote: pending.quote ?? null,
          shape: pending.shape,
          target: pending.target ?? null,
        },
      ],
      { onSuccess: () => setPending(null) },
    );
  };
  const composer = pending && (
    <Composer
      key={JSON.stringify(pending)}
      where={whereOf({ ...pending, quote: pending.quote ?? null, target: pending.target ?? null })}
      chips={CHIPS[surface]}
      saving={save.isPending}
      onSave={add}
      onCancel={() => setPending(null)}
    />
  );
  const made = `${maker?.profile.name ?? maker?.name ?? 'AI'} 做的 · ${new Date(artifact.createdAt).toLocaleString('zh-CN')} 放进画布`;

  return (
    <section
      aria-label="成果"
      className="oasis-dots relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-panel bg-glass-strong shadow-[var(--oasis-glass-edge),var(--oasis-shadow-panel)]"
    >
      {/* 顶栏：左边是位置，右边是动作。进不进「编辑」这一行都在 */}
      <div className="flex flex-wrap items-center gap-2 p-4">
        <Link to="/canvas" aria-label="回到画布" title="回到画布" className={ROUND}>
          <ArrowLeft size={17} aria-hidden="true" />
        </Link>
        <h1 className="m-0 flex min-w-0 items-center gap-2 text-[15px] font-medium">
          <span className="truncate">{artifact.task}</span>
          <span aria-hidden="true" className="text-ink-muted">
            /
          </span>
          {others.length > 1 ? (
            <select
              aria-label={`换一个成果，这个任务有 ${others.length} 个`}
              value={artifact.id}
              onChange={(event) =>
                void navigate({
                  to: '/canvas/artifacts/$artifactId',
                  params: { artifactId: event.target.value },
                })
              }
              className="h-9 max-w-[280px] cursor-pointer truncate rounded-full border-0 bg-glass-active px-3 text-[13.5px] font-normal text-ink shadow-edge-strong"
            >
              {others.map((item) => (
                <option key={item.id} value={item.id}>
                  {reviewName(item)}
                </option>
              ))}
            </select>
          ) : (
            <span className="truncate text-[13.5px] font-normal text-ink-muted">
              {reviewName(artifact)}
            </span>
          )}
        </h1>
        <span className="flex-1" />
        {from ? (
          <Link
            to="/groups/$groupId"
            params={{ groupId: from.id }}
            search={{ task: artifact.runId }}
            className={`${PILL} bg-glass-active text-ink shadow-edge-strong`}
          >
            看过程
          </Link>
        ) : (
          <Link
            to="/dms/$conversationId"
            params={{ conversationId: artifact.conversationId }}
            search={{ task: artifact.runId }}
            className={`${PILL} bg-glass-active text-ink shadow-edge-strong`}
          >
            {dm?.turn ? '它正在做，看进度' : '看过程'}
          </Link>
        )}
        <a
          href={
            artifact.application
              ? appArchiveUrl(artifact.id)
              : artifactContentUrl(artifact.id, true)
          }
          download={artifact.application ? true : artifact.name}
          aria-label="下载"
          title={artifact.application ? '下载整个应用' : '下载'}
          className={ROUND}
        >
          <Download size={17} aria-hidden="true" />
        </a>
        <button
          type="button"
          aria-pressed={editing}
          onClick={() => {
            setEditingFor(editing ? null : artifactId);
            setPending(null);
            setSelected(null);
          }}
          className={`${PILL} font-medium ${editing ? 'bg-solid text-on-solid' : 'bg-accent text-on-accent shadow-accent'}`}
        >
          {editing ? '退出编辑' : '编辑'}
        </button>
      </div>

      <div className="mx-4 mb-4 flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2.5">
          {/* 成果本身：看和改是同一个画面 */}
          <div className="relative flex min-h-0 flex-1 flex-col overflow-auto rounded-card bg-glass-active shadow-edge-strong">
            {artifact.avatar ? (
              <AvatarPreview artifactId={artifact.id} spec={artifact.avatar} />
            ) : (
              <EditSurface
                key={artifact.id}
                file={{
                  path: artifact.path,
                  size: artifact.size,
                  url: artifactContentUrl(artifact.id),
                  downloadUrl: artifactContentUrl(artifact.id, true),
                  modelPreview: !!artifact.modelPreview,
                  ...(pdf ? { pdfUrl: artifactContentUrl(pdf.id) } : {}),
                  assets,
                  ...(pageRoot ? { root: pageRoot } : {}),
                }}
                surface={surface}
                edits={edits}
                editing={editing}
                picking={picking}
                pending={pending}
                selected={selected}
                onPlace={place}
                onSelect={setSelected}
                jump={jump}
                look={mediaLook(values)}
                {...(live ? { live } : {})}
                composer={composer}
              />
            )}
          </div>
          {/* 画面下面：这类成果自己的操作，和一句话 */}
          <div className="flex min-h-9 flex-wrap items-center gap-3 px-1.5">
            {editing && surface === 'live' && !artifact.avatar && (
              <div
                role="radiogroup"
                aria-label="点一下是操作还是选取"
                className="flex gap-0.5 rounded-full bg-well p-[3px]"
              >
                {[
                  { on: !picking, label: '操作', set: false },
                  { on: picking, label: '选取', set: true },
                ].map((mode) => (
                  <button
                    key={mode.label}
                    type="button"
                    role="radio"
                    aria-checked={mode.on}
                    onClick={() => setPicking(mode.set)}
                    className={`h-8 cursor-pointer rounded-full border-0 px-3.5 text-[13px] text-ink ${mode.on ? 'bg-on-solid font-medium shadow-raised' : 'bg-transparent'}`}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
            )}
            <span className="min-w-0 flex-1 text-[12.5px] text-ink-muted">
              {editing
                ? artifact.avatar
                  ? '数字人是实时对话：在右边直接调，或写整体的要求'
                  : HINTS[surface]
                : made}
            </span>
            {(notice ?? save.isError) && (
              <span role="alert" className="text-[12.5px] text-accent">
                {notice ?? (save.error instanceof ApiError ? save.error.message : '没存上，请重试')}
              </span>
            )}
          </div>
          {/* 没有落在画面上的一处（音频的某一刻、选中的一段原文）：在画面下面写怎么改 */}
          {editing && pending && !pending.shape && (
            <div className="mx-auto w-full max-w-[420px]">{composer}</div>
          )}
        </div>
        {editing && (
          <EditPanel
            artifact={artifact}
            edits={edits}
            selected={selected}
            onSelect={(edit) => {
              setPending(null);
              setSelected(edit.id);
              setJump({ id: edit.id, page: edit.page, time: edit.time, nonce: Date.now() });
            }}
            onRemove={(id) => save.mutate(edits.filter((edit) => edit.id !== id))}
            fields={fields}
            values={values}
            onValues={setValues}
            previewable={PREVIEWABLE[kind] ?? []}
            overallHint={OVERALL[surface] ?? '比如：整体再口语一点'}
            maker={makerKey}
            group={from}
            busy={Boolean(dm?.turn)}
          />
        )}
      </div>
    </section>
  );
}
