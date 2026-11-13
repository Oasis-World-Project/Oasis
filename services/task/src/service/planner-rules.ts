// 给规划员的方案格式说明（第一次规划和修改规划共用）：成果的两种做法、生产线里的节点、文件怎么流转、交付物。
// 只写事实和硬约束（能做什么、上限、规划门会查什么），不写「只在…时才用」这类倾向；怎么排由规划员判断。

/** 拼成片的工具节点 */
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
 * 按分镜出视频：一个 AI 写分镜；生产线按分镜出每个镜头的关键帧（每帧做两版挑一版）、
 * 每个镜头图生视频、拼成片。只示意结构，型号、参数按工具目录写。
 */
const VIDEO_EXAMPLE = {
  outcomes: [
    {
      key: 'storyboard',
      title: '分镜',
      how: 'agent',
      goal: '……写成 out/shots.json：JSON 数组，每个镜头一项 {"prompt":"画面描述","seconds":4}',
      model: '型号',
      expects: ['shots.json'],
    },
    {
      key: 'film',
      title: '短片',
      how: 'line',
      nodes: [
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
          key: 'cut',
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
        { from: 'clips', to: 'cut' },
      ],
    },
  ],
  deliverables: { 短片: 'cut' },
};

/** 方案格式的说明（第一次规划和修改规划共用） */
export const OUTCOME_FORMAT_RULES = [
  '- how：agent 是一个 AI 在一个沙箱、一次持续会话里把这样成果从头做到交付：步骤它自己定，要用的素材（插图、配乐、配音……）它自己调工具做，交付前它自己校验；【沙箱环境】里的软件和【可以用的工具】它都能用，也能把一件事交给另一个型号的子 AI。它看得到任务、任务单、自己的 goal 和 needs 里交来的文件，看不到别的成果的过程。',
  '- how：line 是一条生产线，不带 AI：nodes 里是工具节点和展开节点，按 edges 接起来，严格照写好的步骤执行，所以步骤和参数要事先定得下来；要看了内容才知道怎么做的事它做不了。',
  `- 工具节点（kind：tool）：在容器里按顺序执行 steps，每步 {"tool":"工具名","args":{参数},"out":"out/结果路径"}（参数按工具的「参数」写；文件写容器里的路径：上游交来的 in/<上游 key>/…，用户素材 materials/…，前面步骤的结果 out/…），每步失败自动重试 2 次，不写 model。例：${JSON.stringify(TOOL_EXAMPLE)}`,
  '- 展开节点（kind：foreach）：上游先交出一份 JSON 清单（over 写 in/<上游 key>/<文件>.json，JSON 数组，每条一项，最多 24 条），清单有几条就开几个分支同时跑；each 是每条的做法，不写 key：一个工具节点，或一个 AI（kind 写 work，带 goal 和 model）。字符串里 {{index}} 换成两位数的条目号（01、02……）、{{item.字段}} 换成这一条的字段；count 写预计几条。下游拿到 in/<展开节点 key>/01/…、02/…（每条交出的文件）和 in/<展开节点 key>/index.json（按顺序列出每条和它的文件），工具步骤里可以写 in/<key>/*/clip.mp4 按顺序取全部。展开节点不能直接交付，后面接一个节点汇总。',
  '- variants（可选，写在工具节点或 foreach 的 each 里）：{"n":2,"pick":"按什么挑"}，同一步同时做 n 版（2–4），都做完后按 pick 挑一版交给下游（图片、视频、音频交给能看能听的型号比较，其他产出由 AI 读完再比较），落选的留着用户可以换。做几版就花几倍的钱，另加一次挑选。',
  `- 按分镜出视频的示例（只示意结构，型号和参数按工具目录写）：${JSON.stringify(VIDEO_EXAMPLE)}`,
  '- 文件怎么流转：agent 的 needs 写要用哪些节点交出的文件——别的 agent 成果的 key，或生产线里交出文件的那个节点的 key；生产线的 edges 写 from → to，to 是线内的节点，from 是线内的节点或别的成果的 key。上游的 out/ 放进下游的 in/<上游 key>/，只有直接接过来的才放。互相没有文件往来的成果同时开跑。',
  '- 一样成果不拆给两个 AI 接力：不是任务单上的交付物、又只被一个 agent 成果用到的 agent 成果，规划门会退回（并进用它的那样成果里，由那个 AI 自己做）。几样成果共用的东西（如统一的设定）、生产线要用的清单可以先单独做出来。',
  '- deliverables：任务单上每样交付物写由哪个节点交出（agent 成果的 key，或生产线里的节点 key）；那个节点要写 deliver（最终交付的文件路径，可用 * 通配，* 只匹配一层，** 递归）。deliver 只放任务单上的交付物；预览图、参考图、草稿不写进 deliver。',
  '- expects：必须产出的文件（可写 {"pattern":"图/*.png","minCount":4} 这类数量要求），系统会核对。',
  '- goal 写这样成果要做成什么、交出什么文件；做的过程中不能再问用户。key 只用英文字母、数字、下划线、短横线，成果和节点的 key 互相不能重复（展开节点、做几版的节点最长 34 个字符）。',
];
