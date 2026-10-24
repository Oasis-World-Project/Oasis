// 工作流图：节点和连线（React Flow 负责平移、缩放和拖线），位置由 layout.ts 自动排。
// 拖线规则和 task 一致：只能接到还没开始的节点；有断开的线头时，拖出来的线优先接上它。
import type { EdgeBody, TaskBody } from '@oasis/contracts/task';
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  ReactFlow,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import { Minus, Plus, Scan } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { NodeCard, StubCard, type FlowNode, type StubNode } from './NodeCard.tsx';
import { layout, NODE_H, NODE_W } from './layout.ts';
import { nodeActions } from './rules.ts';
import type { useSpeakers } from './use-speakers.ts';

type FlowEdge = Edge<{ deletable: boolean; onDelete: (edgeId: string) => void }, 'flow'>;

/** 选中连线时在线中间出现「删除连线」 */
function FlowEdgeLine(props: EdgeProps<FlowEdge>) {
  const [path, labelX, labelY] = getBezierPath(props);
  return (
    <>
      <BaseEdge path={path} markerEnd={props.markerEnd} interactionWidth={18} />
      {props.selected && props.data?.deletable && (
        <EdgeLabelRenderer>
          <button
            type="button"
            onClick={() => props.data?.onDelete(props.id)}
            className="nodrag nopan pointer-events-auto absolute h-8 rounded-full border-0 bg-solid px-3 text-[12.5px] font-medium text-on-solid shadow-raised"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            删除连线
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes = { step: NodeCard, stub: StubCard };
const edgeTypes = { flow: FlowEdgeLine };

function edgeClass(task: TaskBody, edge: EdgeBody): string {
  if (!edge.from || !edge.to) return 'oasis-edge-broken';
  const target = task.nodes.find((n) => n.id === edge.to);
  if (target?.status === 'running' || target?.status === 'checking') return 'oasis-edge-active';
  if (target?.status === 'succeeded') return 'oasis-edge-done';
  return 'oasis-edge-wait';
}

export interface GraphHandlers {
  onPick: (nodeId: string | null) => void;
  /** 拖了一条线：from 的产出交给 to */
  onConnect: (from: string, to: string) => void;
  onDeleteEdge: (edgeId: string) => void;
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

/** 节点数变了（加了、删了节点）就重新适应屏幕 */
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
  handlers,
}: {
  task: TaskBody;
  selected: string | null;
  speakers: ReturnType<typeof useSpeakers>;
  handlers: GraphHandlers;
}) {
  const { nodes, edges } = useMemo(() => {
    const links = task.edges
      .filter((e) => e.from && e.to)
      .map((e) => ({ from: e.from as string, to: e.to as string }));
    const positions = layout(
      task.nodes.map((n) => n.id),
      links,
    );
    const flowNodes: (FlowNode | StubNode)[] = task.nodes.map((node) => {
      const actions = nodeActions(task, node);
      return {
        id: node.id,
        type: 'step',
        position: positions.get(node.id) ?? { x: 0, y: 0 },
        data: {
          node,
          speakers: speakers.speakersOf(node),
          toolName: speakers.toolName,
          selected: node.id === selected,
          acceptsInput: actions.acceptsInput,
          givesOutput: actions.givesOutput,
          onPick: (id: string) => handlers.onPick(id === selected ? null : id),
        },
        width: NODE_W,
        height: NODE_H,
        draggable: false,
        selectable: false,
        // 不可拖、不可选的节点 React Flow 默认不接收鼠标；卡片本身是按钮，要能点
        style: { pointerEvents: 'all' },
      };
    });
    const flowEdges: FlowEdge[] = [];
    for (const edge of task.edges) {
      // 断开的线头：在缺的那一端放一个小圈
      let from = edge.from;
      let to = edge.to;
      const anchor = positions.get(edge.from ?? edge.to ?? '');
      if (!anchor) continue;
      if (!from || !to) {
        const stubId = `stub-${edge.id}`;
        const side = from ? 'out' : 'in';
        flowNodes.push({
          id: stubId,
          type: 'stub',
          position: {
            x: side === 'out' ? anchor.x + NODE_W + 48 : anchor.x - 72,
            y: anchor.y + NODE_H / 2 - 12,
          },
          data: { side },
          width: 24,
          height: 24,
          draggable: false,
          selectable: false,
        });
        if (side === 'out') to = stubId;
        else from = stubId;
      }
      const target = task.nodes.find((n) => n.id === edge.to);
      flowEdges.push({
        id: edge.id,
        type: 'flow',
        source: from as string,
        target: to as string,
        className: edgeClass(task, edge),
        animated: edgeClass(task, edge) === 'oasis-edge-active',
        data: {
          deletable: !target || nodeActions(task, target).acceptsInput,
          onDelete: handlers.onDeleteEdge,
        },
      });
    }
    return { nodes: flowNodes, edges: flowEdges };
  }, [task, selected, speakers, handlers]);

  const isValidConnection = (connection: Connection | Edge) => {
    if (connection.source === connection.target) return false;
    const from = task.nodes.find((n) => n.id === connection.source);
    const to = task.nodes.find((n) => n.id === connection.target);
    if (!from || !to) return false;
    if (!nodeActions(task, from).givesOutput || !nodeActions(task, to).acceptsInput) return false;
    return !task.edges.some((e) => e.from === from.id && e.to === to.id);
  };

  return (
    <div className="oasis-flow absolute inset-0">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={false}
        nodesFocusable={false}
        deleteKeyCode={null}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        minZoom={0.3}
        maxZoom={1.6}
        isValidConnection={isValidConnection}
        onConnect={(c) => c.source && c.target && handlers.onConnect(c.source, c.target)}
        onPaneClick={() => handlers.onPick(null)}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={22}
          size={2.4}
          color="var(--oasis-hairline)"
        />
        <ZoomControls />
        <FitOnChange count={task.nodes.length} />
      </ReactFlow>
    </div>
  );
}
