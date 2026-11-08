// 节点详情里展开节点、做几版的节点（ADR 0026）的几块：展开出来的每一条、各版和挑选理由、「改用这一版」，
// 以及子节点回到它属于的那个节点。
import type { NodeBody, TaskBody } from '@oasis/contracts/task';
import { pickVersion, taskFileUrl } from '../api/queries.ts';
import { Section, smallButton } from './node-panel-parts.tsx';
import { childrenOf, nodeState } from './rules.ts';
import type { WorkflowActions } from './use-workflow-actions.ts';

const IMAGE = /\.(?:png|jpe?g|webp|gif)$/i;

/** 子节点：属于哪个节点（展开出来的第几条、第几版），点一下回到它 */
export function ParentLink({
  task,
  node,
  onPick,
}: {
  task: TaskBody;
  node: NodeBody;
  onPick: (nodeId: string) => void;
}) {
  const parent = task.nodes.find((n) => n.id === node.parentId);
  if (!parent) return null;
  const what =
    parent.variants && parent.variants.n > 1 ? `第 ${node.slot} 版` : `第 ${node.slot} 条`;
  return (
    <button
      type="button"
      onClick={() => onPick(parent.id)}
      className={`${smallButton} h-auto self-start py-1.5 text-left`}
    >
      {what} · 属于「{parent.title}」，点这里回去
    </button>
  );
}

/** 展开出来的每一条：状态，点开看 */
function Items({
  task,
  node,
  onPick,
}: {
  task: TaskBody;
  node: NodeBody;
  onPick: (nodeId: string) => void;
}) {
  const items = childrenOf(task, node);
  const each = node.foreach!;
  return (
    <Section title={`展开：按 ${each.over} 每条一个`}>
      <p className="m-0 text-[13px] text-ink-muted">
        {each.items === null
          ? `规划时预计 ${each.count} 条，等上游交出清单后展开。`
          : `一共 ${each.items} 条，同时跑；都做完后按条目号汇总交给下游。`}
      </p>
      {items.length > 0 && (
        <ol className="m-0 flex list-none flex-col gap-1 p-0">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onPick(item.id)}
                className="flex w-full items-center gap-2 rounded-item border-0 bg-glass-strong px-3 py-2 text-left text-[13px] text-ink"
              >
                <span className="font-display text-ink-muted">
                  {String(item.slot ?? 0).padStart(2, '0')}
                </span>
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                <span className="shrink-0 text-[12px] text-ink-muted">
                  {item.variants?.chosen
                    ? `用第 ${item.variants.chosen} 版`
                    : nodeState(item).label}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}

/** 各版：缩略图、在用的那版、挑选理由，以及「改用这一版」 */
function Versions({
  task,
  node,
  actions,
  onPick,
}: {
  task: TaskBody;
  node: NodeBody;
  actions: WorkflowActions;
  onPick: (nodeId: string) => void;
}) {
  const variants = node.variants!;
  const versions = childrenOf(task, node);
  // 换版本：下游做完了的会排成修改、带预估等你确认（和修改意见一样）
  const switchable =
    node.status === 'succeeded' &&
    variants.chosen !== null &&
    !task.revision &&
    !['planning', 'accepting'].includes(task.status);
  return (
    <Section title={`做 ${variants.n} 版挑 1 版`}>
      <p className="m-0 text-[13px] leading-relaxed">
        <span className="text-ink-muted">按什么挑：</span>
        {variants.pick}
      </p>
      {variants.chosen !== null && (
        <p className="m-0 rounded-item bg-track px-3 py-2 text-[13px] leading-relaxed">
          用了第 {variants.chosen} 版{variants.reason ? `：${variants.reason}` : ''}
        </p>
      )}
      {versions.length === 0 && (
        <p className="m-0 text-[13px] text-ink-muted">开跑后同时做 {variants.n} 版。</p>
      )}
      <ul className="m-0 grid list-none grid-cols-2 gap-2 p-0">
        {versions.map((version) => {
          const k = version.slot ?? 0;
          const image = version.outputs.find((f) => IMAGE.test(f.path));
          const inUse = variants.chosen === k;
          return (
            <li
              key={version.id}
              className={`flex flex-col gap-1.5 rounded-item bg-glass-strong p-2 ${
                inUse ? 'shadow-[0_0_0_2px_var(--oasis-accent)]' : ''
              }`}
            >
              <button
                type="button"
                onClick={() => onPick(version.id)}
                className="flex aspect-video items-center justify-center overflow-hidden rounded-[12px] border-0 bg-track p-0 text-[12px] text-ink-muted"
              >
                {image ? (
                  <img
                    src={taskFileUrl(task.id, version.id, image.path)}
                    alt={`第 ${k} 版`}
                    className="size-full object-cover"
                  />
                ) : (
                  (version.outputs[0]?.path ?? nodeState(version).label)
                )}
              </button>
              <span className="flex items-center gap-1.5 text-[12px]">
                <span className="font-medium">第 {k} 版</span>
                {inUse ? (
                  <span className="rounded-full bg-accent/15 px-1.5 text-accent">在用</span>
                ) : (
                  <span className="text-ink-muted">{nodeState(version).label}</span>
                )}
              </span>
              {switchable && !inUse && version.status === 'succeeded' && (
                <button
                  type="button"
                  className={smallButton}
                  disabled={actions.busy !== null}
                  onClick={() => void actions.run('pick', () => pickVersion(task.id, node.id, k))}
                >
                  改用这一版
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

/** 展开节点、做几版的节点在详情里多出来的部分 */
export function GroupSections(props: {
  task: TaskBody;
  node: NodeBody;
  actions: WorkflowActions;
  onPick: (nodeId: string) => void;
}) {
  const { node } = props;
  return (
    <>
      {node.foreach && <Items {...props} />}
      {node.variants && node.variants.n > 1 && <Versions {...props} />}
    </>
  );
}
