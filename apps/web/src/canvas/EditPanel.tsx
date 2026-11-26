// 成果页进了「编辑」右边那一栏（照原型 ㉘）：要改的地方一条一条列着，和画面上的编号是同一样东西——点一条画面跳过去，
// 能删；下面是「直接调」的参数、「整体还有什么要求」、交给谁，和「让 AI 改 · N 处」。
// 发出去的是一段话（整体的要求、每处一行、参数），带着这份成果，发进做它的那段对话：私聊里直接发，群里的 AI 做的
// 发进那个群、@ 它、引用群文件里的这一份。改好原地换新。
import type { Annotation, ArtifactBody } from '@oasis/contracts/canvas';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { X } from 'lucide-react';
import { useState } from 'react';
import { ApiError } from '../api/client.ts';
import { dmsQuery, groupFiles, sendGroupMessage, sendMessage } from '../api/queries.ts';
import { useModelMap } from '../api/use-model-map.ts';
import { AiAvatar } from '../ui/Avatar.tsx';
import { reviewName, revisionText, whereOf } from './edits.ts';
import { ParameterFields } from './ParameterFields.tsx';
import { toParameters, type Field, type Values } from './parameters.ts';

export function EditPanel({
  artifact,
  edits,
  selected,
  onSelect,
  onRemove,
  fields,
  values,
  onValues,
  previewable,
  overallHint,
  maker,
  group,
  busy,
}: {
  artifact: ArtifactBody;
  edits: Annotation[];
  selected: string | null;
  onSelect: (edit: Annotation) => void;
  onRemove: (id: string) => void;
  /** 这类成果能「直接调」的参数（没有就不显示那一块） */
  fields: Field[];
  values: Values;
  onValues: (values: Values) => void;
  previewable: string[];
  /** 「整体还有什么要求」里的例子 */
  overallHint: string;
  /** 做它的 AI（修改默认交给它） */
  maker: string | undefined;
  /** 群里的 AI 做的：发进这个群，@ 做它的那个 AI */
  group?: { id: string; title: string; key: string } | undefined;
  /** 做它的 AI 正在做一轮：做完之前不能再让它改 */
  busy: boolean;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const models = useModelMap();
  const [overall, setOverall] = useState('');
  const name = reviewName(artifact);
  const parameters = toParameters(name, fields, values);
  const count = edits.length + parameters.length;
  const key = group?.key ?? maker;
  const model = key ? models.get(key) : undefined;
  const who = model?.profile.name ?? model?.name ?? '做它的 AI';

  const send = useMutation({
    mutationFn: async () => {
      const content = revisionText(
        overall.trim() || `改一下「${name}」`,
        [{ name, annotations: edits }],
        parameters,
      );
      if (!group)
        return sendMessage(artifact.conversationId, {
          content,
          attachments: [],
          artifacts: [artifact.id],
        });
      // 引用群文件里现在就是这份成果的那一个（已经被别的 AI 换成新版的不引用）
      const refs = (await groupFiles(group.id))
        .filter((file) => file.artifactId === artifact.id)
        .map((file) => file.path);
      return sendGroupMessage(
        group.id,
        content,
        crypto.randomUUID(),
        [{ kind: 'ai', key: group.key }],
        { attachments: [], refs },
      );
    },
    onSuccess: async () => {
      if (group) return navigate({ to: '/groups/$groupId', params: { groupId: group.id } });
      await queryClient.invalidateQueries({ queryKey: dmsQuery.queryKey });
      return navigate({
        to: '/dms/$conversationId',
        params: { conversationId: artifact.conversationId },
      });
    },
  });

  return (
    <aside
      aria-label="要改的地方"
      className="flex max-h-[46%] w-full shrink-0 flex-col gap-3.5 overflow-auto rounded-card bg-glass-active p-4 shadow-edge-strong lg:max-h-none lg:w-[320px]"
    >
      <h2 className="m-0 flex items-baseline gap-2 text-[15px] font-medium">
        要改的地方
        <span className="font-display text-xs font-normal text-ink-muted">{edits.length}</span>
      </h2>
      {edits.length === 0 ? (
        <p className="m-0 text-[12.5px] leading-relaxed text-ink-muted">
          还没有。在左边的画面上指一处，说怎么改；也可以只写整体的要求。
        </p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
          {[...edits]
            .sort((a, b) => a.number - b.number)
            .map((edit) => (
              <li
                key={edit.id}
                className={`flex items-start gap-1 rounded-2xl ${
                  selected === edit.id ? 'bg-accent-tint' : 'bg-bubble shadow-edge-bright'
                }`}
              >
                <button
                  type="button"
                  aria-label={`跳到第 ${edit.number} 处：${whereOf(edit)}`}
                  aria-current={selected === edit.id ? 'true' : undefined}
                  onClick={() => onSelect(edit)}
                  className="flex min-w-0 flex-1 cursor-pointer items-start gap-2.5 border-0 bg-transparent px-2.5 py-2 text-left text-ink [font:inherit]"
                >
                  <span
                    aria-hidden="true"
                    className="mt-px flex size-[22px] flex-none items-center justify-center rounded-full bg-accent font-display text-[10.5px] font-medium text-on-accent"
                  >
                    {edit.number}
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-[11.5px] text-ink-muted">{whereOf(edit)}</span>
                    <span className="break-words text-[13.5px] leading-snug">{edit.note}</span>
                    {edit.quote && (
                      <span className="line-clamp-2 text-[11.5px] text-ink-muted">
                        原文「{edit.quote}」
                      </span>
                    )}
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={`不改第 ${edit.number} 处了`}
                  onClick={() => onRemove(edit.id)}
                  className="mr-1 mt-1.5 flex size-7 flex-none cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-ink-muted hover:text-ink"
                >
                  <X size={13} aria-hidden="true" />
                </button>
              </li>
            ))}
        </ol>
      )}
      {fields.length > 0 && (
        <ParameterFields
          fields={fields}
          values={values}
          onChange={onValues}
          previewable={previewable}
        />
      )}
      <label className="flex flex-col gap-1.5 text-[12.5px] text-ink-muted">
        整体还有什么要求（可以不填）
        <textarea
          rows={2}
          maxLength={2000}
          value={overall}
          placeholder={overallHint}
          onChange={(event) => setOverall(event.target.value)}
          className="resize-none rounded-2xl border-0 bg-bubble px-3 py-2 text-[13.5px] leading-relaxed text-ink shadow-edge-bright outline-none placeholder:text-ink-muted"
        />
      </label>
      <div className="flex items-center gap-2.5">
        <AiAvatar
          mono={model?.mono ?? 'AI'}
          glow={model?.glow ?? 'var(--oasis-hairline)'}
          size={30}
        />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[13px] font-medium">
            交给 {who}
            {group ? `（发进群「${group.title}」）` : ''}
          </span>
          <span className="text-[11.5px] text-ink-muted">改好原地换新，旧的不留</span>
        </span>
      </div>
      {send.isError && (
        <p role="alert" className="m-0 text-[12.5px] text-accent">
          {send.error instanceof ApiError ? send.error.message : '没发出去，请重试'}
        </p>
      )}
      <button
        type="button"
        disabled={busy || send.isPending || (count === 0 && !overall.trim())}
        title={busy ? '它正在做，做完才能再让它改' : undefined}
        onClick={() => send.mutate()}
        className="h-11 cursor-pointer rounded-full border-0 bg-accent px-4 text-[14px] font-medium text-on-accent shadow-accent disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none"
      >
        {send.isPending
          ? '正在发…'
          : busy
            ? '它正在做…'
            : `让 AI 改${count ? ` · ${count} 处` : ''}`}
      </button>
    </aside>
  );
}
