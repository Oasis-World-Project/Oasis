// 一句话下面的几个小字按钮（照原型）：复制每条都有；编辑、删除只有和 AI 的私聊里我的最后一句有——
// 删掉这句话和 AI 对它的回复，AI 的记忆退回这句话之前（编辑是删掉后放回输入框，改好再发）。
import { useState } from 'react';
import { groupSnapshot, removeMessage } from '../api/queries.ts';
import { useRoom } from './room.ts';

const button =
  'h-[30px] cursor-pointer rounded-full border-0 bg-transparent px-2.5 text-[12.5px] text-ink-muted disabled:opacity-45';

export function MessageActions({
  text,
  retract,
}: {
  /** 复制的内容 */
  text: string;
  /** 能编辑、删除的那一句（我的最后一句）：它的 ID */
  retract?: string | undefined;
}) {
  const room = useRoom();
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  /** 删掉这句话和 AI 对它的回复：服务端说删了哪几条，这边照着去掉 */
  const remove = () =>
    room.act(async () => {
      const { removed } = await removeMessage(room.group.id, retract!);
      const fresh = await groupSnapshot(room.group.id);
      return { ...fresh, gone: [...fresh.gone, ...removed] };
    });
  return (
    <div className="flex gap-0.5">
      <button
        type="button"
        className={button}
        onClick={() =>
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? '已复制' : '复制'}
      </button>
      {retract && !confirming && (
        <>
          <button
            type="button"
            className={button}
            disabled={room.busy}
            onClick={() => void remove().then((ok) => ok && room.refill(text))}
          >
            编辑
          </button>
          <button type="button" className={button} onClick={() => setConfirming(true)}>
            删除
          </button>
        </>
      )}
      {retract && confirming && (
        <>
          <span className="flex h-[30px] items-center px-2.5 text-[12.5px] text-ink-muted">
            这句话和 AI 的回复一起删掉，AI 不再记得
          </span>
          <button
            type="button"
            className={`${button} font-medium text-ink`}
            disabled={room.busy}
            onClick={() => void remove()}
          >
            确定删除
          </button>
          <button type="button" className={button} onClick={() => setConfirming(false)}>
            取消
          </button>
        </>
      )}
    </div>
  );
}
