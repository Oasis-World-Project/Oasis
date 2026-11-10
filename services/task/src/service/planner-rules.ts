// 给规划员的节点格式说明（第一次规划和修改规划共用）：几种节点、连线、交付物、检查，以及每种节点的特点。
// 只写事实和硬约束（能做什么、花什么钱、上限），不写「只在…时才用」这类倾向；用哪种由规划员判断（ADR 0028）。

/** 拼成片的工具节点（ADR 0025） */
const TOOL_EXAMPLE = {
  key: 'cut',
  title: '拼成片',
  kind: 'tool',
  goal: '把两段镜头拼成成片',
  steps: [
    {
      tool: 'op.video.concat',
      args: { in: ['in/shots/1.mp4', 'in/shots/2.mp4'] },
      out: 'out/成片.mp4',
    },
  ],
  expects: ['成片.mp4'],
};

/**
 * 按分镜出视频（ADR 0026）：分镜 → 每个镜头的关键帧（每帧做两版挑一版）→ 每个镜头图生视频 → 拼成片。
 * 只示意结构，型号、参数按工具目录和预算写。
 */
const VIDEO_EXAMPLE = {
  nodes: [
    {
      key: 'storyboard',
      title: '写分镜',
      kind: 'work',
      goal: '……写成 out/shots.json：JSON 数组，每个镜头一项 {"prompt":"画面描述","seconds":4}',
      expects: ['shots.json'],
    },
    {
      key: 'keyframes',
      title: '关键帧',
      kind: 'foreach',
      over: 'in/storyboard/shots.json',
      count: 8,
      goal: '每个镜头生成一张关键帧',
      each: {
        kind: 'tool',
        title: '关键帧 {{index}}',
        goal: '生成镜头 {{index}} 的关键帧',
        steps: [
          { tool: 'image.generate', args: { prompt: '{{item.prompt}}' }, out: 'out/frame.png' },
        ],
        expects: ['frame.png'],
        variants: { n: 2, pick: '构图最贴合镜头描述、人物和物体没有畸变' },
      },
    },
    {
      key: 'clips',
      title: '镜头视频',
      kind: 'foreach',
      over: 'in/storyboard/shots.json',
      count: 8,
      goal: '每个镜头用关键帧做首帧生成视频',
      each: {
        kind: 'tool',
        goal: '生成镜头 {{index}} 的视频',
        steps: [
          {
            tool: 'video.generate',
            args: {
              prompt: '{{item.prompt}}',
              first_frame: 'in/keyframes/{{index}}/frame.png',
              duration: '{{item.seconds}}',
            },
            out: 'out/clip.mp4',
          },
        ],
        expects: ['clip.mp4'],
      },
    },
    {
      key: 'film',
      title: '拼成片',
      kind: 'tool',
      goal: '按镜头顺序拼成成片',
      steps: [
        { tool: 'op.video.concat', args: { in: 'in/clips/*/clip.mp4' }, out: 'out/成片.mp4' },
      ],
      deliver: ['成片.mp4'],
    },
  ],
  edges: [
    { from: 'storyboard', to: 'keyframes' },
    { from: 'storyboard', to: 'clips' },
    { from: 'keyframes', to: 'clips' },
    { from: 'clips', to: 'film' },
  ],
};

/** 节点字段的说明（第一次规划和修改规划共用） */
export const NODE_FORMAT_RULES = [
  '- kind：work 是一个 AI 在独立容器里做一件事，成果写到 out/；它只看得到任务、任务单、自己的 goal 和上游交来的文件，看不到别的节点的过程。discussion 是几位参与者（各自的模型和立场）讨论几轮、由 model 汇总成结论，适合要从几个立场权衡取舍的问题。',
  `- kind：tool 不用 AI，在容器里按顺序执行 steps，每步 {"tool":"工具名","args":{参数},"out":"out/结果路径"}（参数按工具的「参数」写；文件写容器里的路径：上游交来的 in/<上游 key>/…，用户素材 materials/…，前面步骤的结果 out/…），每步失败自动重试 2 次，不写 model。它不调模型、严格照步骤执行，所以步骤和参数要事先定得下来（按分镜生成视频再拼成片、转格式、抽帧、配音轨）；要看了内容才知道怎么做的事它做不了。例：${JSON.stringify(TOOL_EXAMPLE)}`,
  '- kind：foreach 是展开节点：上游先交出一份 JSON 清单（over 写 in/<上游 key>/<文件>.json，JSON 数组，每条一项，最多 24 条），清单有几条就开几个分支同时跑，each 是每条的做法（一个 work 或 tool 节点，不写 key），字符串里 {{index}} 换成两位数的条目号（01、02……）、{{item.字段}} 换成这一条的字段；count 写预计几条（估价用）。下游拿到 in/<展开节点 key>/01/…、02/…（每条交出的文件）和 in/<展开节点 key>/index.json（按顺序列出每条和它的文件），工具步骤里可以写 in/<key>/*/clip.mp4 按顺序取全部。适合条数要等上游定下来的情况（按分镜逐个出镜头、按大纲逐章写）；条数事先就知道时也可以直接排成几个节点。展开节点不能直接交付，后面接一个节点汇总。',
  '- variants（可选，work 和 tool 节点，也可以写在 foreach 的 each 里）：{"n":2,"pick":"按什么挑"}，同一步同时做 n 版（2–4），都做完后按 pick 挑一版交给下游（图片、视频、音频交给能看能听的型号比较，其他产出由 AI 读完再比较），落选的留着用户可以换。做几版就花几倍的钱，另加一次挑选；常见的用法是结果看运气的生成步骤（关键帧、海报、封面）。',
  `- 按分镜出视频的结构示例（只示意结构，型号和参数按工具目录、预算写）：${JSON.stringify(VIDEO_EXAMPLE)}`,
  '- 连线 from → to：上游的 out/ 放进下游的 in/<上游 key>/，只有直接连过来的才放（隔着一个节点的文件要另外连线才拿得到）；没有连线的节点同时开跑。',
  `- deliverables：任务单上每样交付物都指定由哪个节点交出；那个节点要写 deliver（最终交付的文件路径，可用 * 通配，* 只匹配一层，** 递归）。deliver 只放任务单上的交付物；为做它产生的预览图、参考图、草稿只在节点之间传递，不写进 deliver。`,
  '- expects：节点必须产出的文件（可写 {"pattern":"图/*.png","minCount":4} 这类数量要求），系统会核对。checks：可选，节点交付前自己看一眼的几件事，最多 5 条。',
  '- goal 只写这个节点要做什么、交出什么文件，不写检查流程，检查交给节点自己判断；节点不能再问用户。key 只用英文字母、数字、下划线、短横线（展开节点、做几版的节点最长 34 个字符）。',
];
