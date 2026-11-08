import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(address, prefix);

export function websiteUrl(value: string, origins: string[]) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    !origins.includes(url.origin)
  )
    throw new Error('网站来源未放行');
  return url;
}

/** 容器无网，服务端逐请求校验来源和 DNS，并把连接固定到刚校验的地址。 */
export function createWebsiteFetch(origins: string[]) {
  let requests = 0,
    total = 0;
  return async (value: { url: string; method: string }) => {
    if (++requests > 100 || !['GET', 'HEAD'].includes(value.method))
      throw new Error('网站请求超出限制');
    const url = websiteUrl(value.url, origins);
    const addresses = isIP(url.hostname)
      ? [{ address: url.hostname }]
      : await lookup(url.hostname, { all: true, family: 4 });
    if (
      !addresses.length ||
      addresses.some((item) => isIP(item.address) !== 4 || blocked.check(item.address))
    )
      throw new Error('网站地址不是允许的公网 IPv4');
    return new Promise<{ status: number; headers: Record<string, string>; body: string }>(
      (resolve, reject) => {
        const req = request(
          url,
          {
            method: value.method,
            family: 4,
            agent: false,
            lookup: (_name, _options, callback) => callback(null, addresses[0]!.address, 4),
            headers: { 'accept-encoding': 'identity', 'user-agent': 'Oasis-Website-Test/1' },
          },
          (response) => {
            const chunks: Buffer[] = [];
            let size = 0;
            response.on('data', (chunk: Buffer) => {
              size += chunk.length;
              total += chunk.length;
              if (size > 1024 * 1024 || total > 10 * 1024 * 1024) {
                response.destroy(new Error('网站响应超过大小上限'));
                return;
              }
              chunks.push(chunk);
            });
            response.on('error', reject);
            response.on('end', () => {
              const headers: Record<string, string> = {};
              for (const name of ['content-type', 'location', 'content-encoding']) {
                const entry = response.headers[name];
                if (typeof entry === 'string') headers[name] = entry;
              }
              // 不转发 Cookie、鉴权或任意来源头。重定向由浏览器发起，再通过同一校验。
              resolve({
                status: response.statusCode ?? 502,
                headers,
                body: Buffer.concat(chunks).toString('base64'),
              });
            });
          },
        );
        const timer = setTimeout(() => req.destroy(new Error('网站请求超时')), 8000);
        req.on('close', () => clearTimeout(timer));
        req.on('error', reject);
        req.end();
      },
    );
  };
}
