// 工作流图（ADR 0030 §3.2）：每样成果一个框。一个 AI 做的成果，框里是它自己列的任务清单；
// 生产线的框里是它的节点。线是「谁要用谁交出的文件」。只能看：平移、缩放、点开详情；位置由 layout.ts 自动排。
import type { EdgeBody, NodeBody, TaskBody } from '@oasis/contracts/task';
import { Background, BackgroundVariant, ReactFlow, useReactFlow, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import { Minus, Plus, Scan } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import {
  AgentCard,
  LineFrame,
  NodeCard,
  type AgentNode,
  type FlowNode,
  type LineNode,
} from './NodeCard.tsx';
import {
  AGENT_W,
  agentHeight,
  layout,
  LINE_PAD,
  LINE_TITLE,
  NODE_H,
  NODE_W,
  type Layout,
} from './layout.ts';
import {
  adjustText,
  childrenOf,
  frameRows,
  isAgentOutcome,
  nodeState,
  type FrameRow,
  type Progress,
} from './rules.ts';
import type { useSpeakers } from './use-speakers.ts';

const nodeTypes = { step: NodeCard, agent: AgentCard, line: LineFrame };

function edgeClass(task: TaskBody, edge: EdgeBody): string {
  const target = task.nodes.find((n) => n.id === edge.to);
  if (target?.status === 'running' || target?.status === 'checking') return 'oasis-edge-active';
  if (target?.status === 'succeeded') return 'oasis-edge-done';
  return 'oasis-edge-wait';
}

/** 图上的一块：一条生产线（line 不为空，装着它的节点），或单独的一个节点 */
interface Block {
  id: string;
  line: NodeBody['line'];
  nodes: NodeBody[];
}

function blocksOf(roots: NodeBody[]): Block[] {
  const blocks: Block[] = [];
  for (const node of roots) {
    const block = node.line && blocks.find((b) => b.line?.key === node.line?.key);
    if (block) block.nodes.push(node);
    else {
      blocks.push({
        id: node.line ? `line-${node.line.key}` : node.id,
        line: node.line,
        nodes: [node],
      });
    }
  }
  return blocks;
}

function ZoomControls() {
  const flow = useReactFlow();
  const button =
    'flex size-9 items-center justify-center rounded-full border-0 bg-transparent text-ink hover:bg-glass-active';
  return (
    <div className="absolute bottom-4 left-4 z-10 flex items-center gap-0.5 rounded-full bg-glass-strong p-1 shadow-edge-strong backdrop-blur-xl">
      <button
        type="button"
        aria-label="缩小"
        className={button}
        onClick={() => void flow.zoomOut()}
      >
        <Minus size={16} aria-hidden="true" />
      </button>
      <button type="button" aria-label="放大" className={button} onClick={() => void flow.zoomIn()}>
        <Plus size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={`${button} w-auto gap-1.5 px-3 text-[12.5px]`}
        onClick={() => void flow.fitView({ padding: 0.2, duration: 300 })}
      >
        <Scan size={15} aria-hidden="true" />
        适应屏幕
      </button>
    </div>
  );
}

/** 图上的块数变了（规划好了、修改后多了少了成果）就重新适应屏幕 */
function FitOnChange({ count }: { count: number }) {
  const flow = useReactFlow();
  useEffect(() => {
    const timer = setTimeout(
      () => void flow.fitView({ padding: 0.2, maxZoom: 1, duration: 200 }),
      30,
    );
    return () => clearTimeout(timer);
  }, [count, flow]);
  return null;
}

export function WorkflowGraph({
  task,
  selected,
  speakers,
  progress,
  onPick,
}: {
  task: TaskBody;
  selected: string | null;
  speakers: ReturnType<typeof useSpeakers>;
  /** 每样「一个 AI 做」的成果做到哪了（任务清单、最近几步） */
  progress: Map<string, Progress>;
  onPick: (nodeId: string | null) => void;
}) {
  const { speakersOf, toolName } = speakers;
  const { nodes, edges } = useMemo(() => {
    // 图上只有工作流图里的节点：展开出来的条目、各版叠在父节点的卡片里（ADR 0026）
    const roots = task.nodes.filter((n) => !n.parentId);
    const shown = new Set(roots.map((n) => n.id));
    const links = task.edges.flatMap((e) =>
      e.from && e.to && shown.has(e.from) && shown.has(e.to) ? [{ from: e.from, to: e.to }] : [],
    );
    const blocks = blocksOf(roots);
    const blockOf = new Map(blocks.flatMap((b) => b.nodes.map((n) => [n.id, b.id] as const)));
    // 框里的几行：被调整过的先写调整了什么，再是任务清单
    const rowsOf = new Map(
      roots.filter(isAgentOutcome).map((n) => {
        const adjusted = adjustText(n);
        const rows: FrameRow[] = adjusted ? [{ mark: 'adjust', text: adjusted }] : [];
        return [n.id, [...rows, ...frameRows(progress.get(n.id), toolName)]];
      }),
    );

    // 生产线里面先排一遍，得出框有多大；再把所有块排一遍
    const inner = new Map<string, Layout>();
    for (const block of blocks) {
      if (!block.line) continue;
      const own = new Set(block.nodes.map((n) => n.id));
      inner.set(
        block.id,
        layout(
          block.nodes.map((n) => ({ id: n.id, w: NODE_W, h: NODE_H })),
          links.filter((l) => own.has(l.from) && own.has(l.to)),
        ),
      );
    }
    const sizeOf = (block: Block) => {
      const within = inner.get(block.id);
      if (within)
        return { w: within.width + LINE_PAD * 2, h: within.height + LINE_TITLE + LINE_PAD };
      const rows = rowsOf.get(block.id);
      return rows ? { w: AGENT_W, h: agentHeight(rows.length) } : { w: NODE_W, h: NODE_H };
    };
    const outer = layout(
      blocks.map((b) => ({ id: b.id, ...sizeOf(b) })),
      links.flatMap((l) => {
        const from = blockOf.get(l.from);
        const to = blockOf.get(l.to);
        return from && to && from !== to ? [{ from, to }] : [];
      }),
    );

    const card = (node: NodeBody) => ({
      node,
      children: childrenOf(task, node),
      state: nodeState(node),
      speakers: speakersOf(node),
      toolName,
      selected: node.id === selected,
      onPick: (id: string) => onPick(id === selected ? null : id),
    });
    // 不可拖、不可选的节点 React Flow 默认不接收鼠标；卡片本身是按钮，要能点
    const fixed = { draggable: false, selectable: false } as const;
    const clickable = { ...fixed, style: { pointerEvents: 'all' } } as const;
    const flowNodes: (FlowNode | AgentNode | LineNode)[] = [];
    for (const block of blocks) {
      const position = outer.positions.get(block.id) ?? { x: 0, y: 0 };
      const { w: width, h: height } = sizeOf(block);
      const within = inner.get(block.id);
      if (within && block.line) {
        // 框要排在它的节点前面：React Flow 按这个顺序认父子、定前后
        flowNodes.push({
          id: block.id,
          type: 'line',
          position,
          width,
          height,
          data: {
            title: block.line.title,
            done: block.nodes.filter((n) => n.status === 'succeeded').length,
            total: block.nodes.length,
          },
          ...fixed,
        });
        for (const node of block.nodes) {
          const at = within.positions.get(node.id) ?? { x: 0, y: 0 };
          flowNodes.push({
            id: node.id,
            type: 'step',
            parentId: block.id,
            position: { x: at.x + LINE_PAD, y: at.y + LINE_TITLE },
            width: NODE_W,
            height: NODE_H,
            data: card(node),
            ...clickable,
          });
        }
        continue;
      }
      const node = block.nodes[0]!;
      const rows = rowsOf.get(node.id);
      flowNodes.push(
        rows
          ? {
              id: node.id,
              type: 'agent',
              position,
              width,
              height,
              ...clickable,
              data: { ...card(node), rows },
            }
          : { id: node.id, type: 'step', position, width, height, ...clickable, data: card(node) },
      );
    }
    const flowEdges: Edge[] = task.edges.flatMap((edge) => {
      if (!edge.from || !edge.to || !shown.has(edge.from) || !shown.has(edge.to)) return [];
      const className = edgeClass(task, edge);
      return [
        {
          id: edge.id,
          source: edge.from,
          target: edge.to,
          className,
          animated: className === 'oasis-edge-active',
        },
      ];
    });
    return { nodes: flowNodes, edges: flowEdges };
  }, [task, selected, speakersOf, toolName, progress, onPick]);

  return (
    <div className="oasis-flow absolute inset-0">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        deleteKeyCode={null}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        minZoom={0.3}
        maxZoom={1.6}
        onPaneClick={() => onPick(null)}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={22}
          size={2.4}
          color="var(--oasis-hairline)"
        />
        <ZoomControls />
        <FitOnChange count={nodes.length} />
      </ReactFlow>
    </div>
  );
}
