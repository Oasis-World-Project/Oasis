// 音频工具：文字转语音、语音转文字、生成音乐。
import { Readable } from 'node:stream';
import { z } from 'zod';
import {
  clip,
  estimate,
  holdOver,
  MODEL_ARG,
  optionalModel,
  pickModel,
  provider,
  type ToolDef,
} from './kit.ts';

const SpeechArgs = z.object({
  text: z.string().trim().min(1).max(4000),
  voice: z.string().min(1).max(100).optional(),
  instructions: z.string().max(500).optional(),
  model: optionalModel,
});

const TranscribeArgs = z.object({
  audio_base64: z.string().min(1),
  format: z.enum(['mp3', 'wav', 'm4a', 'flac', 'ogg', 'webm']),
  language: z.string().min(2).max(10).optional(),
  model: optionalModel,
});

const MusicFields = z.object({
  prompt: z.string().trim().min(10).max(2000),
  instrumental: z.union([
    z.boolean(),
    z.enum(['true', 'false']).transform((value) => value === 'true'),
  ]),
  lyrics: z.string().max(3500).optional(),
  duration: z.coerce.number().int().min(30).max(300).optional(),
  model: optionalModel,
});
type MusicInput = z.infer<typeof MusicFields>;

/** Lyria 只收一段 prompt（最多 5000 字）：要不要人声、歌词都写在里面 */
const lyriaInput = (a: MusicInput) => ({
  prompt: (a.instrumental
    ? `${a.prompt}\nInstrumental only, no vocals.`
    : `${a.prompt}\n\nLyrics:\n${a.lyrics}`
  ).slice(0, 5000),
});

const MusicResult = z.object({
  audio: z.object({ url: z.url(), content_type: z.string().nullish() }),
  /** 有的型号带实际时长：MiniMax Music 3 是秒，Mureka 是毫秒（按首计价，不用它） */
  duration: z.number().nullish(),
});

/**
 * fal 上的音乐型号：入参各不相同，差别只写在这张表里，目录只列表里有的。
 * micro 是这一次的标价（微美元）：按首计价的不看参数，按时长计价的看 duration（秒，不写用各自的默认）。
 * makes 是做得了什么：both 都行，instrumental 只做纯器乐，song 只做带歌词的歌。
 * actual：结果里带实际时长、又按时长计价的，照实际的算（不超过提交时的标价）。
 */
const MUSIC_MODELS: Record<
  string,
  {
    micro: (a: { duration?: number | undefined }) => number;
    makes: 'both' | 'instrumental' | 'song';
    input: (a: MusicInput) => Record<string, unknown>;
    actual?: (result: z.infer<typeof MusicResult>) => number | undefined;
  }
> = {
  'fal-ai/minimax-music/v2.6': {
    micro: () => 150_000,
    makes: 'both',
    input: (a) => ({
      prompt: a.prompt,
      is_instrumental: a.instrumental,
      lyrics: a.instrumental ? '' : a.lyrics,
      audio_setting: { sample_rate: 44100, bitrate: 256000, format: 'mp3' },
    }),
  },
  'fal-ai/lyria3/pro': { micro: () => 80_000, makes: 'both', input: lyriaInput },
  'google/lyria/v3': { micro: () => 100_000, makes: 'both', input: lyriaInput },
  // 按秒计价（$0.0003/秒，默认开着的 thinking 翻倍）：不写时长出 120 秒；风格说明最多 512 字；出的是 FLAC。
  // 只做纯器乐：给中文歌词，两次都唱成听不出词的哼唱（2026-11-11 真实调用）
  'fal-ai/ace-step-1.5': {
    micro: (a) => (a.duration ?? 120) * 600,
    makes: 'instrumental',
    input: (a) => ({
      prompt: a.prompt.slice(0, 512),
      lyrics: '[Instrumental]',
      duration: a.duration ?? 120,
    }),
  },
  // 按输出分钟计价（$0.6/分钟，不足一分钟按一分钟）：不写时长出 60 秒。没有歌词参数，歌词和 Lyria 一样写进 prompt
  'elevenlabs/music/v2.5': {
    micro: (a) => Math.ceil((a.duration ?? 60) / 60) * 600_000,
    makes: 'both',
    input: (a) => ({
      prompt: a.instrumental ? a.prompt : `${a.prompt}\n\nLyrics:\n${a.lyrics}`,
      music_length_ms: (a.duration ?? 60) * 1000,
      force_instrumental: a.instrumental,
    }),
  },
  // 带歌词 $0.15 一首（只给描述的要 $0.50，不走这条）；风格说明最多 1024 字；时长 120–300 秒，不写由它定
  'mureka/v9.5/generate/song': {
    micro: () => 150_000,
    makes: 'song',
    input: (a) => ({
      lyrics: a.lyrics,
      prompt: a.prompt.slice(0, 1024),
      ...(a.duration ? { duration: Math.max(120, a.duration) } : {}),
    }),
  },
  'mureka/v9.5/generate/instrumental': {
    micro: () => 150_000,
    makes: 'instrumental',
    input: (a) => ({ prompt: a.prompt }),
  },
  // 按秒计价（$0.002/秒）：duration 是上限（不写 60 秒），可能提前结束，照结果里的实际秒数算。
  // 歌词必填、没有器乐开关：器乐把歌词写成一行段落标记。出的是 WAV（一分钟约 10 MB）
  'minimax/music-3': {
    micro: (a) => (a.duration ?? 60) * 2_000,
    makes: 'both',
    input: (a) => ({
      prompt: a.prompt,
      lyrics: a.instrumental ? '[instrumental]' : a.lyrics,
      duration: a.duration ?? 60,
    }),
    actual: (result) =>
      typeof result.duration === 'number' && result.duration > 0
        ? Math.ceil(result.duration * 2_000)
        : undefined,
  },
};
/** 这个型号做不做得了这次要的：有的只做纯器乐，有的只做带歌词的歌 */
function canMake(model: string, instrumental: unknown) {
  const makes = MUSIC_MODELS[model]?.makes ?? 'both';
  const wanted = instrumental === true || instrumental === 'true' ? 'instrumental' : 'song';
  return makes === 'both' || makes === wanted;
}
/** 这次的标价：型号不在表里返回 undefined */
const musicPrice = (model: string | undefined, args: Record<string, unknown>) =>
  MUSIC_MODELS[model ?? '']?.micro({ duration: Number(args.duration) || undefined });

const MusicArgs = MusicFields.refine(
  (args) => args.instrumental || Boolean(args.lyrics?.trim()),
  '歌曲必须提供歌词；器乐请指定 instrumental=true',
).refine(
  (args) => !args.model || canMake(args.model, args.instrumental),
  '点名的型号做不了这一种（有的只做纯器乐，有的只做带歌词的歌）；换一个型号，或不写 model',
);
/** 任务号里没记型号的旧任务：那时只有这一个型号 */
const MUSIC_BEFORE_MEMO = { model: 'fal-ai/minimax-music/v2.6', micro: 150_000 };

/**
 * 各型号出的格式不一样（ACE-Step 出 FLAC，地址却以 .bin 结尾）：按供应商说的类型起名，
 * 没说的看地址后缀；沙箱存的时候再按文件头核对。
 */
function audioFileOf(audio: z.infer<typeof MusicResult>['audio']) {
  const type = (audio.content_type ?? '').toLowerCase();
  const ext = type.includes('flac')
    ? 'flac'
    : type.includes('wav')
      ? 'wav'
      : (/\.(flac|wav)$/i.exec(new URL(audio.url).pathname)?.[1]?.toLowerCase() ?? 'mp3');
  return { name: `music.${ext}`, mediaType: ext === 'mp3' ? 'audio/mpeg' : `audio/${ext}` };
}

/** 供应商说的没生成的原因，原话交给调用方（2026-11-11：一句普通的器乐描述被内容审核误拦，原样重发就过了） */
async function refusalOf(response: Response) {
  const body = (await response.json().catch(() => null)) as { detail?: { msg?: unknown }[] } | null;
  const reason = body?.detail?.[0]?.msg;
  return typeof reason === 'string' && reason ? reason.slice(0, 300) : '没有给出原因';
}

const TranscriptionResponse = z.looseObject({
  text: z.string(),
  usage: z.looseObject({ cost: z.number().optional() }).optional(),
});

export const speech: ToolDef = {
  key: 'audio.speech',
  name: '文字转语音',
  description: '把一段文字读出来（旁白、配音、提示音），结果存成 MP3 文件。',
  usage:
    'oasis-tool audio.speech --text "要读的文字" [--voice 音色] [--instructions "语气"] --out out/配音.mp3',
  unit: '千字',
  estimateMicro: 20_000,
  holdMicro: (args) => 50_000 + String(args.text ?? '').length * 50,
  long: false,
  provider: 'openrouter',
  models: (config) => config.speechModels,
  args: SpeechArgs,
  cli: [
    { name: 'text', kind: 'text', required: true, description: '要念的文字' },
    { name: 'voice', kind: 'text', description: '音色（各型号的不一样；不写用该型号的第一个）' },
    { name: 'instructions', kind: 'text', description: '语气、语速等要求' },
    MODEL_ARG,
  ],
  modelOf: pickModel,
  async run(deps, args, model) {
    const a = SpeechArgs.parse(args);
    // 多数配音型号不点名音色就拒绝（An explicit voice is required）：没写就用目录里这个型号的第一个
    const voice =
      a.voice ?? (await deps.openrouter.speechVoices(model).catch(() => [] as string[]))[0];
    const response = await deps.upstream(() =>
      deps.openrouter.speech(
        {
          model,
          input: a.text,
          response_format: 'mp3',
          ...(voice ? { voice } : {}),
          ...(a.instructions ? { instructions: a.instructions } : {}),
        },
        deps.signal,
      ),
    );
    const audio = Buffer.from(await response.arrayBuffer());
    const generationId = response.headers.get('x-generation-id');
    // 配音的花费不在返回里：按生成 ID 去查，查不到就按字数估
    let cost: number | undefined;
    for (const wait of [500, 1500, 3000]) {
      if (!generationId) break;
      await new Promise((resolve) => setTimeout(resolve, wait));
      cost = await deps.openrouter.generationCost(generationId).catch(() => undefined);
      if (cost !== undefined) break;
    }
    return {
      text: `生成了一段语音（${model}，${audio.length} 字节）。`,
      files: [{ name: 'speech.mp3', mediaType: 'audio/mpeg', base64: audio.toString('base64') }],
      cost:
        cost !== undefined
          ? provider(cost)
          : estimate(a.text.length * deps.config.speechMicroPerChar),
    };
  },
};

export const transcribe: ToolDef = {
  key: 'audio.transcribe',
  name: '语音转文字',
  description: '把一段录音转成文字（会议、采访、视频里的说话）。',
  usage: 'oasis-tool audio.transcribe --file in/录音.mp3 [--language zh]',
  unit: '次',
  estimateMicro: 10_000,
  holdMicro: () => 100_000,
  long: false,
  provider: 'openrouter',
  models: (config) => config.transcribeModels,
  args: TranscribeArgs,
  cli: [
    {
      name: 'file',
      kind: 'path',
      required: true,
      description: '音频文件（mp3、wav、m4a、flac、ogg、webm，不超过 20 MB）',
    },
    { name: 'language', kind: 'text', description: '语言代码，如 zh' },
    MODEL_ARG,
  ],
  modelOf: pickModel,
  async run(deps, args, model) {
    const a = TranscribeArgs.parse(args);
    const response = await deps.upstream(() =>
      deps.openrouter.transcriptions(
        {
          model,
          input_audio: { data: a.audio_base64, format: a.format },
          ...(a.language ? { language: a.language } : {}),
        },
        deps.signal,
      ),
    );
    const body = TranscriptionResponse.parse(await response.json());
    return {
      text: clip(body.text),
      files: [],
      cost: typeof body.usage?.cost === 'number' ? provider(body.usage.cost) : estimate(10_000),
    };
  },
};

export const music: ToolDef = {
  key: 'audio.music',
  name: '生成音乐',
  description:
    '生成完整器乐曲或带歌词的歌曲（有的型号只做其中一种）；结果为混合音频，不保证分轨或精确时长。',
  usage:
    'oasis-tool audio.music --prompt "音乐风格和段落要求" --instrumental true|false [--lyrics "歌词"] [--duration 秒] --out out/音乐.mp3',
  unit: '首',
  estimateMicro: 150_000,
  // 这次标价的 1.2 倍，不低于 $0.5（按时长计价的型号一首能过 $1）
  holdMicro: (args, model) => holdOver(musicPrice(model, args), 500_000),
  long: true,
  provider: 'fal',
  models: (config) =>
    (config.musicModels ?? []).filter((model) => Object.hasOwn(MUSIC_MODELS, model)),
  priceMicro: (model) => MUSIC_MODELS[model]?.micro({}),
  args: MusicArgs,
  cli: [
    {
      name: 'prompt',
      kind: 'text',
      required: true,
      description: '风格、情绪、段落要求（至少 10 个字；ace-step 只读前 512 字）',
    },
    {
      name: 'instrumental',
      kind: 'flag',
      required: true,
      description: 'true 纯音乐；false 唱歌，要给 lyrics 或 lyrics_file',
    },
    { name: 'lyrics', kind: 'text', description: '歌词' },
    { name: 'lyrics_file', kind: 'path', description: '歌词文件' },
    {
      name: 'duration',
      kind: 'number',
      min: 30,
      max: 300,
      description: '时长（秒）。按时长计价的型号按它算钱，不写用型号自己的默认；有的型号不看它',
    },
    MODEL_ARG,
  ],
  // 不点名时用第一个做得了这次要的型号（带歌词的歌跳过只做器乐的）
  modelOf: (args, models) =>
    typeof args.model === 'string'
      ? args.model
      : (models.find((model) => canMake(model, args.instrumental)) ?? ''),
  async start(deps, args, model) {
    if (!deps.fal) throw new Error('音乐供应商未配置');
    const spec = MUSIC_MODELS[model];
    if (!spec) throw new Error(`音乐型号 ${model} 还没有对接`);
    const parsed = MusicArgs.parse(args);
    const input = spec.input(parsed);
    const response = await deps.upstream(() => deps.fal!.submit(model, input, deps.signal));
    return deps.fal.handle(await response.json(), { model, micro: spec.micro(parsed) });
  },
  async check(deps, id) {
    if (!deps.fal) throw new Error('音乐供应商未配置');
    const status = await deps.fal.status(id);
    if (!status.ok) throw new Error(`查音乐进度失败：${status.status}`);
    const state = z
      .object({ status: z.enum(['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED']) })
      .parse(await status.json());
    if (state.status !== 'COMPLETED') return { state: 'pending' };
    const response = await deps.fal.result(id);
    if (response.status === 422 || response.status === 400)
      return { state: 'failed', error: `音乐供应商没有生成：${await refusalOf(response)}` };
    if (!response.ok) throw new Error(`取音乐结果失败：${response.status}`);
    const result = MusicResult.parse(await response.json());
    const memo = deps.fal.memo(id) ?? MUSIC_BEFORE_MEMO;
    const media = await deps.fal.media(result.audio.url);
    if (
      !media.body ||
      !/^(audio\/|application\/octet-stream)/.test(media.headers.get('content-type') ?? '')
    )
      throw new Error('音乐返回格式不合格');
    return {
      state: 'completed',
      outcome: {
        text: '音乐生成完成；这是供应商返回的混合音轨。',
        files: [{ ...audioFileOf(result.audio), body: Readable.fromWeb(media.body) }],
        cost: estimate(
          Math.min(memo.micro, MUSIC_MODELS[memo.model]?.actual?.(result) ?? memo.micro),
        ),
      },
    };
  },
};
