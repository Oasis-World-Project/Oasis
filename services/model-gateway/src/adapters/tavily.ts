// Tavily 的最小客户端：联网搜索和网页抓取（ADR 0006）。换供应商只换这个文件。
export interface SearchClient {
  readonly configured: boolean;
  search(body: Record<string, unknown>, signal: AbortSignal): Promise<Response>;
  extract(body: Record<string, unknown>, signal: AbortSignal): Promise<Response>;
}

export function createTavilyClient(options: {
  baseUrl: string;
  apiKey: string | undefined;
}): SearchClient {
  const base = options.baseUrl.replace(/\/$/, '');
  const post = (path: string, body: Record<string, unknown>, signal: AbortSignal) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.apiKey ?? ''}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
  return {
    configured: Boolean(options.apiKey),
    search: (body, signal) => post('/search', body, signal),
    extract: (body, signal) => post('/extract', body, signal),
  };
}
