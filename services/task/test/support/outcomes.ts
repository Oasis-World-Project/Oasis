// 测试里按节点和连线写的方案 → 规划员按成果写的格式：干活节点各是一样由 AI 做的成果，
// 其余节点（工具、展开）同在一条生产线里；连到干活节点的线变成它的 needs。
export function outcomePlan(plan: {
  nodes: unknown[];
  edges?: { from: string; to: string }[];
  deliverables: Record<string, string>;
}) {
  const nodes = plan.nodes as ({ key: string; kind: string } & Record<string, unknown>)[];
  const edges = plan.edges ?? [];
  const lineNodes = nodes.filter((n) => n.kind !== 'work');
  const inLine = new Set(lineNodes.map((n) => n.key));
  return {
    outcomes: [
      ...nodes
        .filter((n) => n.kind === 'work')
        .map(({ kind: _kind, ...n }) => ({
          ...n,
          how: 'agent',
          needs: edges.filter((e) => e.to === n.key).map((e) => e.from),
        })),
      ...(lineNodes.length
        ? [
            {
              key: 'line',
              title: '生产线',
              how: 'line',
              nodes: lineNodes,
              edges: edges.filter((e) => inLine.has(e.to)),
            },
          ]
        : []),
    ],
    deliverables: plan.deliverables,
  };
}
