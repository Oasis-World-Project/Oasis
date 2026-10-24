// 工作流图上的一个节点（照原型 ⑬）：谁在做、标题、一行说明、状态；左边进线、右边出线。
import type { NodeBody } from '@oasis/contracts/task';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { Check } from 'lucide-react';
import { AiAvatar } from '../ui/Avatar.tsx';
import { formatCost } from '../ui/format.ts';
import { NODE_H, NODE_W } from './layout.ts';
import { NODE_STATUS } from './rules.ts';
import type { Speaker } from './use-speakers.ts';

type FlowNodeData = {
  node: NodeBody;
  speakers: Speaker[];
  /** 工具名 → 给人看的名字（如 image.generate → 生成图片） */
  toolName: (key: string) => string;
  selected: boolean;
  acceptsInput: boolean;
  givesOutput: boolean;
  onPick: (id: string) => void;
};
export type FlowNode = Node<FlowNodeData, 'step'>;

/** 卡片下面那行说明：讨论几轮、用什么工具、花了多少、关卡提醒 */
function metaOf(node: NodeBody, toolName: (key: string) => string): string {
  if (node.warning) return node.warning;
  if (node.discussion) {
    const { round, rounds } = node.discussion;
    return round > 0 ? `讨论第 ${round} / ${rounds} 轮` : `讨论 ${rounds} 轮`;
  }
  if (node.tools.length > 0) return `用${node.tools.map((t) => toolName(t.key)).join('、')}`;
  if (node.spentMicro > 0) return `已花 ${formatCost(node.spentMicro)}`;
  return node.role || node.goal;
}

function StatusMark({ node }: { node: NodeBody }) {
  const { tone } = NODE_STATUS[node.status];
  if (node.status === 'succeeded')
    return <Check size={16} strokeWidth={2.4} aria-hidden="true" className="shrink-0" />;
  if (tone === 'active')
    return (
      <span
        aria-hidden="true"
        className="size-2.5 shrink-0 rounded-full bg-accent motion-safe:animate-pulse"
      />
    );
  if (tone === 'trouble')
    return <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full bg-accent" />;
  return (
    <span
      aria-hidden="true"
      className="size-2.5 shrink-0 rounded-full border-[1.5px] border-ink-muted/40"
    />
  );
}

const handleClass =
  '!size-2.5 !rounded-full !border-[1.5px] !border-ink-muted/50 !bg-glass-active hover:!border-accent';

export function NodeCard({ data }: NodeProps<FlowNode>) {
  const { node, speakers, selected } = data;
  const status = NODE_STATUS[node.status];
  const quiet = ['draft', 'waiting', 'blocked', 'cancelled'].includes(node.status);
  const ring = selected
    ? 'shadow-[0_0_0_2px_var(--oasis-accent)]'
    : status.tone === 'active'
      ? 'shadow-[0_0_0_1px_var(--oasis-accent)]'
      : 'shadow-edge-strong';
  return (
    <>
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={data.acceptsInput}
        className={handleClass}
      />
      <button
        type="button"
        onClick={() => data.onPick(node.id)}
        aria-pressed={selected}
        aria-label={`${node.title}，${status.label}`}
        style={{ width: NODE_W, height: NODE_H }}
        className={`flex flex-col justify-between rounded-[20px] border-0 p-3 text-left text-ink ${
          quiet ? 'bg-glass-strong' : 'bg-glass-active'
        } ${ring} ${node.status === 'cancelled' ? 'opacity-55' : ''}`}
      >
        <span className="flex items-center gap-2">
          <span
            className="relative flex shrink-0"
            style={{ width: 26 + (Math.min(speakers.length, 4) - 1) * 20 }}
          >
            {speakers.slice(0, 4).map((s, i) => (
              <span key={`${s.name}-${i}`} className="absolute top-0" style={{ left: i * 20 }}>
                <AiAvatar mono={s.mono} glow={s.glow} size={26} />
              </span>
            ))}
            <span className="h-[26px]" />
          </span>
          <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{node.title}</span>
          <StatusMark node={node} />
        </span>
        <span
          className={`truncate text-[11.5px] ${node.warning ? 'text-accent' : 'text-ink-muted'}`}
        >
          {metaOf(node, data.toolName)}
        </span>
        <span
          className={`flex items-center gap-1.5 text-[11.5px] ${
            status.tone === 'trouble' || status.tone === 'active' ? 'text-accent' : 'text-ink-muted'
          }`}
        >
          {node.kind === 'discussion' && (
            <span className="rounded-full bg-track px-1.5 text-ink-muted">讨论</span>
          )}
          {status.label}
          {status.tone === 'active' && (
            <span aria-hidden="true" className="h-1 flex-1 overflow-hidden rounded-full bg-track">
              <span className="block h-full w-1/3 rounded-full bg-accent motion-safe:animate-[oasis-slide_1.4s_ease-in-out_infinite]" />
            </span>
          )}
        </span>
      </button>
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={data.givesOutput}
        className={handleClass}
      />
    </>
  );
}

/** 断开的线头：删了节点后留下的另一端 */
export type StubNode = Node<{ side: 'in' | 'out' }, 'stub'>;

export function StubCard({ data }: NodeProps<StubNode>) {
  return (
    <>
      {data.side === 'out' && (
        <Handle
          type="target"
          position={Position.Left}
          isConnectable={false}
          className="!opacity-0"
        />
      )}
      <span
        aria-hidden="true"
        className="flex size-6 items-center justify-center rounded-full border-[1.5px] border-dashed border-accent bg-glass-active"
      />
      {data.side === 'in' && (
        <Handle
          type="source"
          position={Position.Right}
          isConnectable={false}
          className="!opacity-0"
        />
      )}
    </>
  );
}
