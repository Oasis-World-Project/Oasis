// 工作流图上的卡片（ADR 0030 §3.2）：一个 AI 做的成果是一个框，里面是它自己列的任务清单（只读）；
// 生产线是一个框，框里是它的节点（谁在做、标题、一行说明、状态）。线从左边进、右边出，不能拖。
import type { NodeBody } from '@oasis/contracts/task';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { Check, Cog } from 'lucide-react';
import { AiAvatar } from '../ui/Avatar.tsx';
import { formatCost } from '../ui/format.ts';
import { AGENT_W, agentHeight, NODE_H, NODE_W, ROW_H } from './layout.ts';
import { adjustText, type FrameRow, type nodeState } from './rules.ts';
import type { Speaker } from './use-speakers.ts';

type CardData = {
  node: NodeBody;
  /** 展开出来的条目、各版（ADR 0026）：叠在卡片后面，数做完了几个 */
  children: NodeBody[];
  state: ReturnType<typeof nodeState>;
  speakers: Speaker[];
  /** 工具名 → 给人看的名字（如 image.generate → 生成图片） */
  toolName: (key: string) => string;
  selected: boolean;
  onPick: (id: string) => void;
};
export type FlowNode = Node<CardData, 'step'>;
/** rows：框里显示的几行（任务清单，或 AI 没列清单时的最近几步） */
export type AgentNode = Node<CardData & { rows: FrameRow[] }, 'agent'>;
export type LineNode = Node<{ title: string; done: number; total: number }, 'line'>;

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

/** 卡片下面那行说明：讨论几轮、几步工具、花了多少、关卡提醒 */
function metaOf(node: NodeBody, toolName: (key: string) => string): string {
  if (node.warning) return '有提醒，点开查看';
  const adjusted = adjustText(node);
  if (adjusted) return adjusted;
  if (node.discussion) {
    const { round, rounds } = node.discussion;
    return round > 0 ? `讨论第 ${round} / ${rounds} 轮` : `讨论 ${rounds} 轮`;
  }
  if (node.steps)
    return `${node.steps.length} 步：${[...new Set(node.steps.map((s) => toolName(s.tool)))].join('、')}`;
  if (node.spentMicro > 0) return `已花 ${formatCost(node.spentMicro)}`;
  return node.role || node.goal;
}

type MarkState = 'done' | 'doing' | 'trouble' | 'todo';

/** 做完的打勾，在做的闪点，出问题的实心点，其余空心圈 */
export function Mark({ state, size = 16 }: { state: MarkState; size?: number }) {
  if (state === 'done')
    return <Check size={size} strokeWidth={2.4} aria-hidden="true" className="shrink-0" />;
  const dot = size >= 16 ? 'size-2.5' : 'size-2';
  // 圆点比对勾小，两边留白，和对勾占一样宽，文字才对得齐
  const box = { width: size, height: size };
  return (
    <span aria-hidden="true" style={box} className="flex shrink-0 items-center justify-center">
      <span
        className={`${dot} rounded-full ${
          state === 'doing'
            ? 'bg-accent motion-safe:animate-pulse'
            : state === 'trouble'
              ? 'bg-accent'
              : 'border-[1.5px] border-ink-muted/40'
        }`}
      />
    </span>
  );
}

const markOf = (data: CardData): MarkState =>
  data.node.status === 'succeeded'
    ? 'done'
    : data.state.tone === 'active'
      ? 'doing'
      : data.state.tone === 'trouble'
        ? 'trouble'
        : 'todo';

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

/** 卡片的底色和描边：选中的、在跑的描一圈；还没开始的淡一些 */
function surface({ node, state, selected }: CardData): string {
  const quiet = node.status === 'waiting' || node.status === 'cancelled';
  const ring = selected
    ? 'shadow-[0_0_0_2px_var(--oasis-accent)]'
    : state.tone === 'active'
      ? 'shadow-[0_0_0_1px_var(--oasis-accent)]'
      : 'shadow-edge-strong';
  return `${quiet ? 'bg-glass-strong' : 'bg-glass-active'} ${ring} ${
    node.status === 'cancelled' ? 'opacity-55' : ''
  }`;
}

/** 卡片最下面一行：是哪种节点、状态，在跑的带一条动的进度 */
function StatusLine({ data, tag }: { data: CardData; tag?: string }) {
  const { tone, label } = data.state;
  return (
    <span
      className={`flex items-center gap-1.5 text-[11.5px] ${
        tone === 'trouble' || tone === 'active' ? 'text-accent' : 'text-ink-muted'
      }`}
    >
      {tag && <span className="rounded-full bg-track px-1.5 text-ink-muted">{tag}</span>}
      {label}
      {tone === 'active' && (
        <span aria-hidden="true" className="h-1 flex-1 overflow-hidden rounded-full bg-track">
          <span className="block h-full w-1/3 rounded-full bg-accent motion-safe:animate-[oasis-slide_1.4s_ease-in-out_infinite]" />
        </span>
      )}
    </span>
  );
}

/** 线的两头：只用来定位，看不见、不能拖 */
function Ends() {
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} className="!opacity-0" />
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        className="!opacity-0"
      />
    </>
  );
}

const TAGS: Partial<Record<NodeBody['kind'], string>> = {
  discussion: '讨论',
  tool: '工具',
  foreach: '展开',
};

export function NodeCard({ data }: NodeProps<FlowNode>) {
  const { node, speakers, selected } = data;
  const group = groupMeta(node, data.children);
  const trouble = node.status !== 'succeeded' && !!node.warning;
  return (
    <>
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
        aria-label={`${node.title}，${data.state.label}`}
        style={{ width: NODE_W, height: NODE_H }}
        className={`relative flex flex-col justify-between rounded-[20px] border-0 p-3 text-left text-ink ${surface(data)}`}
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
          <Mark state={markOf(data)} />
        </span>
        <span className={`truncate text-[11.5px] ${trouble ? 'text-accent' : 'text-ink-muted'}`}>
          {group ?? metaOf(node, data.toolName)}
        </span>
        <StatusLine data={data} {...(TAGS[node.kind] ? { tag: TAGS[node.kind] } : {})} />
      </button>
      <Ends />
    </>
  );
}

/** 一个 AI 从头做到交付的成果：框里是它自己列的任务清单，随运行更新；没列清单时是最近几步 */
export function AgentCard({ data }: NodeProps<AgentNode>) {
  const { node, rows, selected } = data;
  const who = data.speakers[0];
  const listed = rows.some((row) => row.mark !== 'note' && row.mark !== 'adjust');
  return (
    <>
      <button
        type="button"
        onClick={() => data.onPick(node.id)}
        aria-pressed={selected}
        aria-label={`${node.title}，${data.state.label}`}
        style={{ width: AGENT_W, height: agentHeight(rows.length) }}
        className={`relative flex flex-col gap-2 rounded-[20px] border-0 p-3 text-left text-ink ${surface(data)}`}
      >
        <span className="flex items-center gap-2">
          {who && <AiAvatar mono={who.mono} glow={who.glow} size={26} />}
          <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{node.title}</span>
          <Mark state={markOf(data)} />
        </span>
        {rows.length > 0 ? (
          <ol
            aria-label={listed ? '任务清单' : '最近几步'}
            className="m-0 flex min-h-0 flex-1 list-none flex-col p-0"
          >
            {rows.map((row, index) => (
              <li
                key={index}
                style={{ height: ROW_H }}
                className={`flex items-center gap-1.5 text-[12px] ${
                  row.mark === 'adjust'
                    ? 'text-accent'
                    : row.mark === 'doing' || row.mark === 'todo'
                      ? ''
                      : 'text-ink-muted'
                }`}
              >
                {row.mark !== 'note' && row.mark !== 'adjust' && (
                  <Mark state={row.mark} size={14} />
                )}
                <span className="min-w-0 truncate">{row.text}</span>
              </li>
            ))}
          </ol>
        ) : (
          <span className="line-clamp-2 min-h-0 flex-1 text-[12px] leading-[22px] text-ink-muted">
            {node.warning ? '有提醒，点开查看' : node.goal}
          </span>
        )}
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1">
            <StatusLine data={data} />
          </span>
          {node.spentMicro > 0 && (
            <span className="shrink-0 text-[11.5px] text-ink-muted">
              已花 {formatCost(node.spentMicro)}
            </span>
          )}
        </span>
      </button>
      <Ends />
    </>
  );
}

/** 生产线的框：标题和做完了几个；里面的节点由图摆在它上面 */
export function LineFrame({ data }: NodeProps<LineNode>) {
  return (
    <div
      role="group"
      aria-label={`生产线：${data.title}`}
      className="size-full rounded-[28px] bg-track/50 shadow-edge-strong"
    >
      <p className="m-0 flex h-10 items-center gap-2 px-4 text-[12.5px] text-ink-muted">
        <span className="min-w-0 truncate font-medium text-ink">{data.title}</span>
        <span className="shrink-0">
          生产线 · {data.done} / {data.total} 完成
        </span>
      </p>
    </div>
  );
}
