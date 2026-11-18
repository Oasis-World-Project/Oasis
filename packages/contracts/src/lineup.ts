// 所有型号的清单（2026-11-15 用户定：写在一个地方，哪家更新了只改这里）：
// - 能聊天的 AI 们：每个 AI 的各档型号、标价、量过的说明（agent 的「AI 们」读这里）；
// - 各工具用的型号，按顺序，第一个是默认（model-gateway 的默认配置读这里，.env 只在要临时换时填）；
// - 「只用国内模型」认的国内厂商。
// 改完跑 `pnpm models:check`：对着 OpenRouter 目录列出下架的、价格变了的、同一家新出的。
// 视频、音乐、3D 每个型号怎么调（入参、标价）写在 model-gateway 的 tools/ 里，这里只管用哪些。

/** 这份清单最近一次对着供应商目录核对的日子（models:check 按它找之后新出的型号） */
export const LINEUP_CHECKED = '2026-11-15';

export type Tier = 'fast' | 'balanced' | 'strong' | 'max';

/** 一个 AI 的一档：上游型号、给人看的名字、档位、每百万 token 的大概单价（美元）、量过的说明 */
export interface ChatOption {
  model: string;
  label: string;
  tier: Tier;
  inputPrice: number;
  outputPrice: number;
  note?: string;
}

/** 能聊天的一个 AI（「AI 们」里的一张卡）：第一档是默认 */
export interface ChatAi {
  key: string;
  name: string;
  vendor: string;
  tags: string[];
  /** 头像上的字 */
  mono: string;
  /** 头像光色 */
  glow: string;
  options: ChatOption[];
}

/**
 * 量过的结果和提醒。「实测」是第 4 阶段在 Oasis 里做计数小网页的用时和花费（2026-11-14，一次的结果）；
 * Claude、GPT、Gemini 在开发机所在地区用不了，没量。
 */
const NOTES: Readonly<Record<string, string>> = {
  'openai/gpt-6-astra-pro': '慢',
  'x-ai/grok-4.3': '实测：小网页 53 秒、$0.04',
  'x-ai/grok-4.7': '实测：小网页 4 分钟、$0.29',
  'qwen/qwen3.8-flash': '实测：小网页 62 秒、不到 $0.01',
  'qwen/qwen3.8-max-prime': '实测：小网页 52 秒、$0.19',
  'mistralai/mistral-small-2603': '实测：小网页 55 秒、不到 $0.01',
  'mistralai/mistral-large-4-0': '实测：小网页 48 秒、$0.03',
  // 2026-11-15 新加的几个照同样的做法量过
  'meta/muse-glimmer-30b': '实测：小网页 37 秒、$0.01',
  'meta/muse-spark-open': '实测：小网页 1.7 分钟、$0.10',
  'nvidia/nemotron-3.5-lightning': '实测：小网页 14 秒、不到 $0.01',
  'nvidia/nemotron-3.5-super-vl': '实测：小网页 35 秒、不到 $0.01',
  'nvidia/nemotron-3-ultra-550b-a55b': '实测：小网页 27 秒、$0.05',
  'baidu/ernie-5.5-flash-preview:free': '限时免费；实测：小网页 3.1 分钟',
  'baidu/ernie-light-dt-1.0-intl': '实测：小网页 1.5 分钟、$0.09',
  'bytedance-seed/seed-2.0-mini': '实测：小网页 37 秒、$0.02',
  'bytedance-seed/seed-2.0-lite': '实测：小网页 1.2 分钟、$0.04',
  'bytedance-seed/seed-2-1-turbo': '实测：小网页 1.4 分钟、$0.09',
  'moonshotai/kimi-k2.5': '实测：小网页 63 秒、$0.04',
  'moonshotai/kimi-k3.1-pro': '实测：小网页 68 秒、$0.12',
  'minimax/minimax-m3.1-flash': '实测：小网页 3.2 分钟、$0.01',
  'minimax/minimax-m3': '实测：小网页 1.8 分钟、$0.03',
  'z-ai/glm-5.3-flash': '实测：小网页 29 秒、不到 $0.01',
  'z-ai/glm-5.3-prime': '实测：小网页 40 秒、$0.12；自己看不了图',
  'deepseek/deepseek-v4.1-flash': '实测：小网页 6.5 分钟、$0.04（检查得很细）',
  'deepseek/deepseek-v4-pro': '实测：小网页 47 秒、$0.02；自己看不了图',
  'tencent/hy3': '实测：小网页 2.8 分钟、$0.01；自己看不了图',
  'tencent/hy4': '实测：小网页 3.1 分钟、$0.05',
};

const o = (model: string, label: string, tier: Tier, input: number, output: number) => {
  const note = NOTES[model];
  return { model, label, tier, inputPrice: input, outputPrice: output, ...(note ? { note } : {}) };
};

// 价格按 OpenRouter 目录（DeepSeek 走官方，按官方实测）
export const CHAT_AIS: readonly ChatAi[] = [
  {
    key: 'claude',
    name: 'Claude',
    vendor: 'Anthropic',
    tags: ['长文写作', '写代码'],
    mono: 'Cl',
    glow: '#F0A07C',
    options: [
      o('anthropic/claude-haiku-5.5', 'Claude Haiku 5.5', 'fast', 0.1, 0.5),
      o('anthropic/claude-sonnet-5.5', 'Claude Sonnet 5.5', 'balanced', 2, 10),
      o('anthropic/claude-opus-5.5', 'Claude Opus 5.5', 'strong', 4, 20),
      o('anthropic/claude-fable-5.2', 'Claude Fable 5.2', 'max', 8, 40),
    ],
  },
  {
    key: 'gpt',
    name: 'GPT',
    vendor: 'OpenAI',
    tags: ['全能通用', '多模态'],
    mono: 'GPT',
    glow: '#6FD0AE',
    options: [
      o('openai/gpt-6-luna', 'GPT-6 Luna', 'fast', 0.1, 0.5),
      o('openai/gpt-6.1-terra', 'GPT-6.1 Terra', 'balanced', 1, 5),
      o('openai/gpt-6.1-sol-pro', 'GPT-6.1 Sol Pro', 'strong', 2, 10),
      o('openai/gpt-6-astra-pro', 'GPT-6 Astra Pro', 'max', 10, 50),
    ],
  },
  {
    key: 'gemini',
    name: 'Gemini',
    vendor: 'Google',
    tags: ['超长上下文', '看图看视频'],
    mono: 'Ge',
    glow: '#8FB2FF',
    options: [
      o('google/gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite', 'fast', 0.3, 2.5),
      o('google/gemini-3.8-flash', 'Gemini 3.8 Flash', 'balanced', 0.83, 4.13),
      o('google/gemini-4-argon', 'Gemini 4 Argon', 'strong', 2, 10),
    ],
  },
  {
    key: 'grok',
    name: 'Grok',
    vendor: 'xAI',
    tags: ['实时资讯', '说话直接'],
    mono: 'Gk',
    glow: '#9A9DB2',
    options: [
      o('x-ai/grok-4.3', 'Grok 4.3', 'fast', 1.25, 2.5),
      o('x-ai/grok-4.7', 'Grok 4.7', 'strong', 2, 6),
    ],
  },
  // Meta 自己托管的 Muse（Ember、Spark 1.3、Wonder）开发机这边 403，上线到海外后再加；这里是第三方托管的
  {
    key: 'muse',
    name: 'Muse',
    vendor: 'Meta',
    tags: ['开放权重', '看图'],
    mono: 'Mu',
    glow: '#7FB7E8',
    options: [
      o('meta/muse-glimmer-30b', 'Muse Glimmer 30B', 'fast', 0.3, 1.2),
      o('meta/muse-spark-open', 'Muse Spark Open', 'strong', 1.25, 4.25),
    ],
  },
  {
    key: 'qwen',
    name: 'Qwen',
    vendor: '阿里巴巴',
    tags: ['中文强', '开源'],
    mono: 'Qw',
    glow: '#9C8CFF',
    options: [
      o('qwen/qwen3.8-flash', 'Qwen3.8 Flash', 'fast', 0.15, 0.47),
      o('qwen/qwen3.8-max-prime', 'Qwen3.8 Max Prime', 'strong', 4, 12),
    ],
  },
  {
    key: 'mistral',
    name: 'Mistral',
    vendor: 'Mistral AI',
    tags: ['开源轻量', '欧洲多语言'],
    mono: 'Mi',
    glow: '#FFB36B',
    options: [
      o('mistralai/mistral-small-2603', 'Mistral Small 4', 'fast', 0.15, 0.6),
      o('mistralai/mistral-large-4-0', 'Mistral Large 4', 'strong', 0.7, 2.1),
    ],
  },
  {
    key: 'nemotron',
    name: 'Nemotron',
    vendor: 'NVIDIA',
    tags: ['开放权重', '推理'],
    mono: 'Nv',
    glow: '#8FCB4A',
    options: [
      o('nvidia/nemotron-3.5-lightning', 'Nemotron 3.5 Lightning', 'fast', 0.07, 0.2),
      o('nvidia/nemotron-3.5-super-vl', 'Nemotron 3.5 Super VL', 'balanced', 0.15, 0.47),
      o('nvidia/nemotron-3-ultra-550b-a55b', 'Nemotron 3 Ultra', 'strong', 0.6, 2.4),
    ],
  },
  // 文心 5.5 Flash 预览限时免费（OpenRouter 上带 :free），免费结束后要换
  {
    key: 'ernie',
    name: '文心一言',
    vendor: '百度',
    tags: ['中文知识', '百度生态'],
    mono: '文心',
    glow: '#6F8BFF',
    options: [
      o('baidu/ernie-5.5-flash-preview:free', '文心 5.5 Flash 预览', 'fast', 0, 0),
      o('baidu/ernie-light-dt-1.0-intl', '文心 Light DT 1.0', 'strong', 1.13, 3.94),
    ],
  },
  {
    key: 'kimi',
    name: 'Kimi',
    vendor: '月之暗面',
    tags: ['长文档阅读', '联网搜索'],
    mono: 'Ki',
    glow: '#A3A3B0',
    options: [
      o('moonshotai/kimi-k2.5', 'Kimi K2.5', 'fast', 0.5, 2.5),
      o('moonshotai/kimi-k3.1-pro', 'Kimi K3.1 Pro', 'strong', 2, 10),
    ],
  },
  {
    key: 'minimax',
    name: 'MiniMax',
    vendor: 'MiniMax',
    tags: ['角色扮演', '语音自然'],
    mono: 'MM',
    glow: '#FF8FB1',
    options: [
      o('minimax/minimax-m3.1-flash', 'MiniMax M3.1 Flash', 'fast', 0.075, 0.3),
      o('minimax/minimax-m3', 'MiniMax M3', 'strong', 0.3, 1.2),
    ],
  },
  {
    key: 'glm',
    name: 'GLM',
    vendor: '智谱',
    tags: ['智能体', '工具调用'],
    mono: 'GLM',
    glow: '#8C9BFF',
    options: [
      o('z-ai/glm-5.3-flash', 'GLM-5.3 Flash', 'fast', 0.04, 0.08),
      o('z-ai/glm-5.3-prime', 'GLM-5.3 Prime', 'strong', 2.8, 8.8),
    ],
  },
  {
    key: 'deepseek',
    name: 'DeepSeek',
    vendor: '深度求索',
    tags: ['深度推理', '性价比'],
    mono: 'DS',
    glow: '#6E95FF',
    options: [
      o('deepseek/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', 'fast', 0.15, 0.6),
      o('deepseek/deepseek-v4-pro', 'DeepSeek V4 Pro', 'strong', 0.9, 1.5),
    ],
  },
  {
    key: 'doubao',
    name: '豆包',
    vendor: '字节跳动',
    tags: ['中文对话', '看图'],
    mono: '豆包',
    glow: '#7CB8FF',
    options: [
      o('bytedance-seed/seed-2.0-mini', '豆包 Seed 2.0 Mini', 'fast', 0.1, 0.4),
      o('bytedance-seed/seed-2.0-lite', '豆包 Seed 2.0 Lite', 'balanced', 0.25, 2),
      o('bytedance-seed/seed-2-1-turbo', '豆包 Seed 2.1 Turbo', 'strong', 0.5, 2.5),
    ],
  },
  {
    key: 'hunyuan',
    name: '混元',
    vendor: '腾讯',
    tags: ['中文创作', '腾讯生态'],
    mono: '混元',
    glow: '#64B5F6',
    options: [
      o('tencent/hy3', '混元 Hy3', 'fast', 0.083, 0.33),
      o('tencent/hy4', '混元 Hy4', 'strong', 0.42, 1.25),
    ],
  },
];

/** 工具用的一个型号 */
export interface ToolModel {
  id: string;
  name: string;
  vendor: string;
  note?: string;
}

/** 「AI 们」里只能看的几类（对话 AI 之外） */
export type ToolCategory = 'image' | 'vision' | 'video' | 'audio' | 'embedding' | '3d' | 'other';

/** 一项用到型号的能力：哪个工具（或平台自己的用途）、在「AI 们」哪一类里列、找哪家供应商、按顺序用哪些型号 */
export interface ToolLine {
  /** oasis-tool 的工具名；平台自己用的（数字人、群聊调度的备用）为 null */
  tool: string | null;
  /** 给人看的用途，如「生图」 */
  label: string;
  /** 在「AI 们」哪一类里列；不列的（本来就是对话 AI 的型号）为 null */
  category: ToolCategory | null;
  /** fal 上的型号不在 OpenRouter 目录里，models:check 不核对它们 */
  provider: 'openrouter' | 'fal';
  /** 按顺序：第一个是默认，前一个被限流或地区用不了时换下一个 */
  models: readonly ToolModel[];
}

const t = (id: string, name: string, vendor: string, note?: string): ToolModel => ({
  id,
  name,
  vendor,
  ...(note ? { note } : {}),
});

// 2026-11-05 用户决定：一律登记各家最强的型号，不替用户省钱。
export const TOOL_LINEUP = {
  image: {
    tool: 'image.generate',
    label: '生图',
    category: 'image',
    provider: 'openrouter',
    models: [
      t('bytedance-seed/seedream-5-0-pro', 'Seedream 5.0 Pro', '字节跳动'),
      t('google/gemini-nano-banana-2.1', 'Nano Banana 2.1', 'Google'),
      t('openai/gpt-image-2.5-sunburst', 'GPT Image 2.5 Sunburst', 'OpenAI'),
      t('black-forest-labs/flux-3-image', 'FLUX 3 Image', 'Black Forest Labs'),
      t('qwen/qwen-image-3-pro', 'Qwen Image 3 Pro', '阿里巴巴'),
      t('microsoft/mai-image-2.6', 'MAI-Image-2.6', '微软'),
      t('recraft/recraft-v4.1-pro', 'Recraft V4.1 Pro', 'Recraft'),
      t('bytedance-seed/seedream-4.5', 'Seedream 4.5', '字节跳动'),
      t('black-forest-labs/flux.2-pro', 'FLUX.2 Pro', 'Black Forest Labs'),
    ],
  },
  // 看图、看视频、听音频共用：每个型号读得了哪几种看供应商目录，这里只管先后。三种各至少有三个国内型号，
  // 2026-11-11 逐个真实调用过。qwen3.8-omni-flash：20 秒的单段能听，两段 5 MB 的 mp3 一起给时报「The audio is empty」
  inspect: {
    tool: 'media.inspect',
    label: '看图、看视频、听音频',
    category: 'vision',
    provider: 'openrouter',
    models: [
      t('qwen/qwen3.8-max-prime', 'Qwen3.8 Max Prime', '阿里巴巴'),
      t('moonshotai/kimi-k3.1-pro', 'Kimi K3.1 Pro', '月之暗面'),
      t('xiaomi/mimo-v2.6-pro', 'MiMo V2.6 Pro', '小米'),
      t('xiaomi/mimo-v2.6-flash', 'MiMo V2.6 Flash', '小米'),
      t('xiaomi/mimo-v2.5', 'MiMo V2.5', '小米'),
      t('qwen/qwen3.8-omni-flash', 'Qwen3.8 Omni Flash', '阿里巴巴'),
      t('google/gemini-4-argon', 'Gemini 4 Argon', 'Google'),
      t('anthropic/claude-opus-5.5', 'Claude Opus 5.5', 'Anthropic'),
      t('minimax/minimax-m3', 'MiniMax M3', 'MiniMax'),
      t('stepfun/step-5-preview', 'Step 5 Preview', '阶跃星辰'),
    ],
  },
  // 前四个国内型号 2026-11-11 真实调用过，念出来的中文再转写回来一字不差。seed-audio 排最后：它按描述生成声音，
  // 只给要念的文字时出来的不是这句话。GPT-4o mini TTS 2026-11-15 已从目录下架，去掉了
  speech: {
    tool: 'audio.speech',
    label: '配音',
    category: 'audio',
    provider: 'openrouter',
    models: [
      t('qwen/qwen-audio-3.0-tts-flash', 'Qwen Audio 3.0 TTS Flash', '阿里巴巴'),
      t('minimax/speech-2.8-turbo', 'Speech 2.8 Turbo', 'MiniMax'),
      t('qwen/qwen-audio-3.0-tts-plus', 'Qwen Audio 3.0 TTS Plus', '阿里巴巴'),
      t('minimax/speech-2.8-hd', 'Speech 2.8 HD', 'MiniMax'),
      t('fish-audio/s2.1-pro', 'S2.1 Pro', 'Fish Audio'),
      t('bytedance-seed/seed-audio-1-0', 'Seed Audio 1.0', '字节跳动'),
    ],
  },
  transcribe: {
    tool: 'audio.transcribe',
    label: '转写',
    category: 'audio',
    provider: 'openrouter',
    models: [
      t('openai/whisper-large-v3', 'Whisper Large V3', 'OpenAI'),
      t('qwen/qwen3-asr-1.7b', 'Qwen3 ASR 1.7B', '阿里巴巴'),
      t('qwen/qwen3-asr-0.6b', 'Qwen3 ASR 0.6B', '阿里巴巴'),
      t('google/chirp-3', 'Chirp 3', 'Google'),
    ],
  },
  // fal 上的型号只认 tools/audio.ts 里对接过的（入参、结果、标价写在那里）
  music: {
    tool: 'audio.music',
    label: '音乐',
    category: 'audio',
    provider: 'fal',
    models: [
      t('fal-ai/minimax-music/v2.6', 'MiniMax Music 2.6', 'MiniMax'),
      t('fal-ai/lyria3/pro', 'Lyria 3 Pro', 'Google'),
      t('google/lyria/v3', 'Lyria 3', 'Google'),
      t('fal-ai/ace-step-1.5', 'ACE-Step 1.5', 'ACE Studio', '只做纯器乐'),
      t('elevenlabs/music/v2.5', 'ElevenLabs Music v2.5', 'ElevenLabs', '按分钟计价'),
      t('minimax/music-3', 'MiniMax Music 3', 'MiniMax', '按秒计价'),
    ],
  },
  // 最贵的 Veo 3.1 4K 带声音每秒 $0.60（冻结按每秒 $0.70 算）；换更贵的型号要同时调冻结
  video: {
    tool: 'video.generate',
    label: '生视频',
    category: 'video',
    provider: 'openrouter',
    models: [
      t('google/veo-3.1', 'Veo 3.1', 'Google'),
      t('bytedance/seedance-2.5', 'Seedance 2.5', '字节跳动'),
      t('kwaivgi/kling-v3.0-pro', 'Kling 3.0 Pro', '快手'),
      t('alibaba/wan-3.0-prime', 'Wan 3.0 Prime', '阿里巴巴'),
      t('minimax/hailuo-3-max', '海螺 3 Max', 'MiniMax'),
      t('runway/gen-4.5', 'Gen-4.5', 'Runway'),
      t('alibaba/wan-3.0', 'Wan 3.0', '阿里巴巴'),
      t('kwaivgi/kling-v3.0-std', 'Kling 3.0 标准', '快手'),
    ],
  },
  // fal 上的型号只认 tools/three-d.ts 里对接过的；吃图的和吃文字的写在一起，各用各的第一个
  geometry: {
    tool: '3d.generate',
    label: '生成 3D',
    category: '3d',
    provider: 'fal',
    models: [
      t('fal-ai/trellis-2', 'TRELLIS 2', '微软'),
      t('fal-ai/hunyuan-3d/v3.1/pro/image-to-3d', '混元 3D 3.1 Pro', '腾讯'),
      t('tripo3d/h3.1/image-to-3d', 'Tripo H3.1', 'VAST'),
      t('fal-ai/pixal3d', 'Pixal3D', 'Pixal'),
      t('meshy/v7.1/image-to-3d', 'Meshy 7.1', 'Meshy', '带贴图'),
      t('fal-ai/hyper3d/rodin/v2.5', 'Rodin 2.5', 'Hyper3D', '50 万面，预览要另生成'),
      t(
        'fal-ai/hyper3d/rodin/v2.5/text-to-3d/fast',
        'Rodin 2.5 快速（文字）',
        'Hyper3D',
        '只给文字',
      ),
      t('meshy/v7.1/text-to-3d', 'Meshy 7.1（文字）', 'Meshy', '只给文字，带贴图'),
    ],
  },
  jev: {
    tool: 'jev.decide',
    label: '决策',
    category: 'other',
    provider: 'openrouter',
    models: [t('typesafe/jev-1.14', 'Jev 1.14', 'TypeSafe')],
  },
  // 上面的决策模型用不了时（如「只用国内模型」）回答 jev.decide 的：三个国内的轻量型号
  decideChat: {
    tool: 'jev.decide',
    label: '决策（Jev 用不了时）',
    category: null,
    provider: 'openrouter',
    models: [
      t('deepseek/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', '深度求索'),
      t('qwen/qwen3.8-flash', 'Qwen3.8 Flash', '阿里巴巴'),
      t('z-ai/glm-5.3-flash', 'GLM-5.3 Flash', '智谱'),
    ],
  },
  ask: {
    tool: 'model.ask',
    label: '问另一个模型',
    category: null,
    provider: 'openrouter',
    models: [
      t('deepseek/deepseek-v4-pro-0813', 'DeepSeek V4 Pro 0813', '深度求索'),
      t('deepseek/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', '深度求索'),
      t('qwen/qwen3.8-max-prime', 'Qwen3.8 Max Prime', '阿里巴巴'),
      t('moonshotai/kimi-k3.1-pro', 'Kimi K3.1 Pro', '月之暗面'),
      t('z-ai/glm-5.3-prime', 'GLM-5.3 Prime', '智谱'),
      t('anthropic/claude-sonnet-5.5', 'Claude Sonnet 5.5', 'Anthropic'),
      t('openai/gpt-6.1-sol', 'GPT-6.1 Sol', 'OpenAI'),
      t('google/gemini-4-argon', 'Gemini 4 Argon', 'Google'),
    ],
  },
  // 专用决策模型地区不可用时，证据判断经同一计费链路回退到它
  decisionFallback: {
    tool: null,
    label: '决策回退',
    category: null,
    provider: 'openrouter',
    models: [t('deepseek/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', '深度求索')],
  },
  // 数字人回答：要出字快
  avatar: {
    tool: null,
    label: '数字人回答',
    category: null,
    provider: 'openrouter',
    models: [t('deepseek/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', '深度求索')],
  },
} as const satisfies Record<string, ToolLine>;

/** 一项能力的型号 ID，按顺序（给配置当默认值） */
export const lineupIds = (line: keyof typeof TOOL_LINEUP): string =>
  TOOL_LINEUP[line].models.map((model) => model.id).join(',');

/**
 * 国内厂商（模型 ID 里「/」前面的部分）。用户打开「只用国内模型」后，只给他的 AI 们列这些厂商的模型和
 * 工具型号；不在名单里的都算国外。
 */
export const DOMESTIC_VENDORS: readonly string[] = [
  'deepseek',
  'qwen',
  'alibaba',
  'baidu',
  'moonshotai',
  'bytedance',
  'bytedance-seed',
  'kwaivgi',
  'minimax',
  'stepfun',
  'tencent',
  'xiaomi',
  'z-ai',
];
