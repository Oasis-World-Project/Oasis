// 音频工具：文字转语音、语音转文字、生成音乐。
import { Readable } from 'node:stream';
import { z } from 'zod';
import {
  clip,
  estimate,
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

const MusicArgs = z
  .object({
    prompt: z.string().trim().min(10).max(2000),
    instrumental: z.union([
      z.boolean(),
      z.enum(['true', 'false']).transform((value) => value === 'true'),
    ]),
    lyrics: z.string().max(3500).optional(),
    model: optionalModel,
  })
  .refine(
    (args) => args.instrumental || Boolean(args.lyrics?.trim()),
    '歌曲必须提供歌词；器乐请指定 instrumental=true',
  );

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
    { name: 'voice', kind: 'text', description: '音色' },
    { name: 'instructions', kind: 'text', description: '语气、语速等要求' },
    MODEL_ARG,
  ],
  modelOf: pickModel,
  async run(deps, args, model) {
    const a = SpeechArgs.parse(args);
    const response = await deps.upstream(() =>
      deps.openrouter.speech(
        {
          model,
          input: a.text,
          response_format: 'mp3',
          ...(a.voice ? { voice: a.voice } : {}),
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
  description: '生成完整器乐曲或带歌词的歌曲；结果为混合音频，不保证分轨或精确时长。',
  usage:
    'oasis-tool audio.music --prompt "音乐风格和段落要求" --instrumental true|false [--lyrics "歌词"] --out out/音乐.mp3',
  unit: '首',
  estimateMicro: 150_000,
  holdMicro: () => 500_000,
  long: true,
  provider: 'fal',
  models: (config) => config.musicModels ?? [],
  args: MusicArgs,
  cli: [
    {
      name: 'prompt',
      kind: 'text',
      required: true,
      description: '风格、情绪、段落要求（至少 10 个字）',
    },
    {
      name: 'instrumental',
      kind: 'flag',
      required: true,
      description: 'true 纯音乐；false 唱歌，要给 lyrics 或 lyrics_file',
    },
    { name: 'lyrics', kind: 'text', description: '歌词' },
    { name: 'lyrics_file', kind: 'path', description: '歌词文件' },
    MODEL_ARG,
  ],
  modelOf: pickModel,
  async start(deps, args, model) {
    if (!deps.fal) throw new Error('音乐供应商未配置');
    const a = MusicArgs.parse(args);
    const response = await deps.upstream(() =>
      deps.fal!.submit(
        model,
        {
          prompt: a.prompt,
          is_instrumental: a.instrumental,
          lyrics: a.instrumental ? '' : a.lyrics,
          audio_setting: { sample_rate: 44100, bitrate: 256000, format: 'mp3' },
        },
        deps.signal,
      ),
    );
    return deps.fal.handle(await response.json());
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
      return { state: 'failed', error: '音乐供应商报告生成失败' };
    if (!response.ok) throw new Error(`取音乐结果失败：${response.status}`);
    const result = z.object({ audio: z.object({ url: z.url() }) }).parse(await response.json());
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
        files: [{ name: 'music.mp3', mediaType: 'audio/mpeg', body: Readable.fromWeb(media.body) }],
        cost: estimate(deps.config.musicMicroPerGeneration ?? 150_000),
      },
    };
  },
};
