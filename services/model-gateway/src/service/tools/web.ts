// 联网工具：搜索、读取网页正文（Tavily）。
import { createHash } from 'node:crypto';
import { HttpError } from '@oasis/service-kit';
import { z } from 'zod';
import { clip, MAX_TEXT, type ToolDef } from './kit.ts';

const SearchArgs = z.object({
  query: z.string().trim().min(1).max(400),
  max_results: z.coerce.number().int().min(1).max(10).default(5),
  depth: z.enum(['basic', 'advanced']).default('basic'),
  topic: z.enum(['general', 'news', 'finance']).default('general'),
  time_range: z.enum(['day', 'week', 'month', 'year']).optional(),
});

const FetchArgs = z.object({
  urls: z.array(z.url()).min(1).max(5),
  depth: z.enum(['basic', 'advanced']).default('basic'),
  format: z.enum(['text', 'files']).default('text'),
});

const Tavily = z.looseObject({ usage: z.looseObject({ credits: z.number() }).optional() });
const SearchResponse = Tavily.extend({
  results: z.array(z.looseObject({ title: z.string(), url: z.string(), content: z.string() })),
});
const ExtractResponse = Tavily.extend({
  results: z.array(z.looseObject({ url: z.string(), raw_content: z.string().nullable() })),
  failed_results: z.array(z.looseObject({ url: z.string(), error: z.string() })).default([]),
});

export const webSearch: ToolDef = {
  key: 'web.search',
  name: '联网搜索',
  description: '在网上搜索资料，返回最相关的几条结果（标题、网址、摘要）。',
  usage:
    'oasis-tool web.search --query "关键词" [--max_results 5] [--depth basic|advanced] [--topic general|news|finance] [--time_range week]',
  unit: '次',
  estimateMicro: 8_000,
  holdMicro: (args) => (args.depth === 'advanced' ? 2 : 1) * 8_000 * 2,
  long: false,
  provider: 'tavily',
  models: () => [],
  args: SearchArgs,
  cli: [
    { name: 'query', kind: 'text', required: true, description: '搜索词' },
    { name: 'max_results', kind: 'number', min: 1, max: 10, description: '要几条结果（默认 5）' },
    { name: 'depth', kind: 'choice', choices: ['basic', 'advanced'], description: '搜索深度' },
    {
      name: 'topic',
      kind: 'choice',
      choices: ['general', 'news', 'finance'],
      description: '类别（默认 general）',
    },
    {
      name: 'time_range',
      kind: 'choice',
      choices: ['day', 'week', 'month', 'year'],
      description: '只要这段时间内的',
    },
  ],
  modelOf: () => 'tavily/search',
  async run(deps, args) {
    const a = SearchArgs.parse(args);
    const response = await deps.upstream(() =>
      deps.tavily.search(
        {
          query: a.query,
          max_results: a.max_results,
          search_depth: a.depth,
          topic: a.topic,
          include_usage: true,
          ...(a.time_range ? { time_range: a.time_range } : {}),
        },
        deps.signal,
      ),
    );
    const body = SearchResponse.parse(await response.json());
    const credits = body.usage?.credits ?? (a.depth === 'advanced' ? 2 : 1);
    const lines = body.results.map(
      (r, i) =>
        `${i + 1}. ${r.title}\n   ${r.url}\n   ${clip(r.content.replace(/\s+/g, ' '), 800)}`,
    );
    return {
      text: lines.length > 0 ? lines.join('\n\n') : '没有搜到结果。',
      data: body.results.map((r) => ({ title: r.title, url: r.url })),
      files: [],
      cost: { costMicro: credits * deps.config.tavilyCreditMicro, source: 'provider' },
    };
  },
};

export const webFetch: ToolDef = {
  key: 'web.fetch',
  name: '读取网页',
  description: '读取 1–5 个网页的正文（转成 Markdown），用来细看搜索到的资料。',
  usage:
    'oasis-tool web.fetch --urls https://a.com/x,https://b.com/y [--depth basic|advanced] [--out out/资料/（保存全文）]',
  unit: '次',
  estimateMicro: 8_000,
  holdMicro: (args) => (args.depth === 'advanced' ? 2 : 1) * 8_000 * 2,
  long: false,
  provider: 'tavily',
  models: () => [],
  args: FetchArgs,
  cli: [
    {
      name: 'urls',
      kind: 'list',
      required: true,
      min: 1,
      max: 5,
      description: '网页地址（1–5 个）',
    },
    { name: 'depth', kind: 'choice', choices: ['basic', 'advanced'], description: '读取深度' },
  ],
  modelOf: () => 'tavily/extract',
  async run(deps, args) {
    const a = FetchArgs.parse(args);
    const response = await deps.upstream(() =>
      deps.tavily.extract(
        { urls: a.urls, extract_depth: a.depth, format: 'markdown', include_usage: true },
        deps.signal,
      ),
    );
    const body = ExtractResponse.parse(await response.json());
    if (
      a.format === 'files' &&
      body.results.reduce((total, r) => total + Buffer.byteLength(r.raw_content ?? ''), 0) >
        deps.config.fetchMaxBytes
    ) {
      throw new HttpError(
        413,
        'web_content_too_large',
        '网页正文总大小超过配置上限，请减少一次抓取的网址数',
      );
    }
    const perPage = Math.floor(MAX_TEXT / Math.max(1, body.results.length));
    const parts = body.results.map((r) => `## ${r.url}\n\n${clip(r.raw_content ?? '', perPage)}`);
    for (const f of body.failed_results) parts.push(`## ${f.url}\n\n（没读到：${f.error}）`);
    const credits =
      body.usage?.credits ?? Math.ceil(body.results.length / 5) * (a.depth === 'advanced' ? 2 : 1);
    return {
      text:
        a.format === 'files'
          ? [
              ...body.results.map((r) => `${r.url}：${(r.raw_content ?? '').length} 字`),
              ...body.failed_results.map((r) => `${r.url}：没读到（${r.error}）`),
            ].join('\n')
          : parts.join('\n\n'),
      data: { sources: body.results.map((r) => r.url), failed: body.failed_results },
      files:
        a.format === 'files'
          ? body.results.map((r, i) => ({
              name: `${i + 1}-${createHash('sha256').update(r.url).digest('hex').slice(0, 12)}.md`,
              mediaType: 'text/markdown',
              base64: Buffer.from(`来源：${r.url}\n\n${r.raw_content ?? ''}`).toString('base64'),
            }))
          : [],
      cost: { costMicro: credits * deps.config.tavilyCreditMicro, source: 'provider' },
    };
  },
};
