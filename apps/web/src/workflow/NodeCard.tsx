// 工作流图上的一个节点（照原型 ⑬）：谁在做、标题、一行说明、状态；左边进线、右边出线。
import type { NodeBody } from '@oasis/contracts/task';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { Check, Cog } from 'lucide-react';
import { AiAvatar } from '../ui/Avatar.tsx';
import { formatCost } from '../ui/format.ts';
import { NODE_H, NODE_W } from './layout.ts';
import type { nodeState } from './rules.ts';
import type { Speaker } from './use-speakers.ts';

type FlowNodeData = {
  node: NodeBody;
  /** 展开出来的条目、各版（ADR 0026）：叠在卡片后面，数做完了几个 */
  children: NodeBody[];
  state: ReturnType<typeof nodeState>;
  speakers: Speaker[];
  /** 工具名 → 给人看的名字（如 image.generate → 生成图片） */
  toolName: (key: string) => string;
  selected: boolean;
  acceptsInput: boolean;
  givesOutput: boolean;
  onPick: (id: string) => void;
};
export type FlowNode = Node<FlowNodeData, 'step'>;

/** 展开节点、做几版的节点的那行说明，如「镜头 × 12（7 完成）」「2 版 · 用了第 2 版」 */
function groupMeta(node: NodeBody, children: NodeBody[]): string | undefined {
  const done = children.filter((c) => c.status === 'succeeded').length;
  if (node.foreach) {
    const name = node.foreach.each.title.replace(/\s*\{\{[^}]*\}\}\s*/g, '').trim() || '条目';
    const total = node.foreach.items ?? node.foreach.count;
    return node.foreach.items === null && !children.length
      ? `${name} × 约 ${total}（等清单）`
      : `${name} × ${total}（${done} 完成）`;
  }
  if (node.variants && node.variants.n > 1) {
    if (node.variants.chosen) return `${node.variants.n} 版 · 用了第 ${node.variants.chosen} 版`;
    return children.length
      ? `${node.variants.n} 版（${done} 完成）`
      : `做 ${node.variants.n} 版挑 1 版`;
  }
  return undefined;
}

/** 卡片下面那行说明：讨论几轮、几步工具、用什么工具、花了多少、关卡提醒 */
function metaOf(node: NodeBody, toolName: (key: string) => string): string {
  if (node.warning) return '有提醒，点开查看';
  if (node.discussion) {
    const { round, rounds } = node.discussion;
    return round > 0 ? `讨论第 ${round} / ${rounds} 轮` : `讨论 ${rounds} 轮`;
  }
  if (node.steps)
    return `${node.steps.length} 步：${[...new Set(node.steps.map((s) => toolName(s.tool)))].join('、')}`;
  if (node.tools.length > 0) return `用${node.tools.map((t) => toolName(t.key)).join('、')}`;
  if (node.spentMicro > 0) return `已花 ${formatCost(node.spentMicro)}`;
  return node.role || node.goal;
}

function StatusMark({
  node,
  tone,
}: {
  node: NodeBody;
  tone: ReturnType<typeof nodeState>['tone'];
}) {
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

/** 工具节点的标记：齿轮，没有 AI 头像（ADR 0025） */
export function ToolMark({ size }: { size: number }) {
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size }}
      className="flex shrink-0 items-center justify-center rounded-full bg-track text-ink-muted"
    >
      <Cog size={Math.round(size * 0.6)} strokeWidth={1.8} />
    </span>
  );
}

const handleClass =
  '!size-2.5 !rounded-full !border-[1.5px] !border-ink-muted/50 !bg-glass-active hover:!border-accent';

export function NodeCard({ data }: NodeProps<FlowNode>) {
  const { node, speakers, selected } = data;
  const status = data.state;
  const group = groupMeta(node, data.children);
  const trouble = node.status !== 'succeeded' && !!node.warning;
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
      {/* 展开节点、做几版的节点：后面叠两层，看得出是一叠（ADR 0026） */}
      {group &&
        [8, 4].map((offset) => (
          <span
            key={offset}
            aria-hidden="true"
            style={{
              width: NODE_W,
              height: NODE_H,
              transform: `translate(${offset}px, ${offset}px)`,
            }}
            className="absolute left-0 top-0 rounded-[20px] bg-glass-strong shadow-edge-strong"
          />
        ))}
      <button
        type="button"
        onClick={() => data.onPick(node.id)}
        aria-pressed={selected}
        aria-label={`${node.title}，${status.label}`}
        style={{ width: NODE_W, height: NODE_H }}
        className={`relative flex flex-col justify-between rounded-[20px] border-0 p-3 text-left text-ink ${
          quiet ? 'bg-glass-strong' : 'bg-glass-active'
        } ${ring} ${node.status === 'cancelled' ? 'opacity-55' : ''}`}
      >
        <span className="flex items-center gap-2">
          {node.kind === 'tool' || node.kind === 'foreach' ? (
            <ToolMark size={26} />
          ) : (
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
          )}
          <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{node.title}</span>
          <StatusMark node={node} tone={status.tone} />
        </span>
        <span className={`truncate text-[11.5px] ${trouble ? 'text-accent' : 'text-ink-muted'}`}>
          {group ?? metaOf(node, data.toolName)}
        </span>
        <span
          className={`flex items-center gap-1.5 text-[11.5px] ${
            status.tone === 'trouble' || status.tone === 'active' ? 'text-accent' : 'text-ink-muted'
          }`}
        >
          {node.kind === 'discussion' && (
            <span className="rounded-full bg-track px-1.5 text-ink-muted">讨论</span>
          )}
          {node.kind === 'tool' && (
            <span className="rounded-full bg-track px-1.5 text-ink-muted">工具</span>
          )}
          {node.kind === 'foreach' && (
            <span className="rounded-full bg-track px-1.5 text-ink-muted">展开</span>
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
