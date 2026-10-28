// 对象存储（S3 兼容；本地是 SeaweedFS）。每个服务用自己的桶：harness 存运行产出和会话存档，canvas 存素材和成果。
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListMultipartUploadsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import type { ServiceResource } from './resource.ts';
import { HttpError } from './http-error.ts';
import type { Logger } from './logger.ts';

/** 连接对象存储需要的配置；桶名由各服务自己定（各自给默认值） */
export const objectStoreEnv = {
  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_MULTIPART_MAX_AGE_MS: z.coerce
    .number()
    .int()
    .min(3600_000)
    .default(24 * 3600_000),
};

/** 读对象的一段（含两端）；不给就是整个 */
export interface ByteRange {
  start: number;
  end: number;
}

export interface ObjectStore {
  sign?(key: string, method: 'GET' | 'PUT', expiresIn: number): Promise<string>;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** 边读边传，不整个读进内存（下载、拖动视频进度用） */
  read(key: string, range?: ByteRange): Promise<Readable>;
  putStream(
    key: string,
    body: Readable,
    contentType: string,
    limits: StreamLimits,
  ): Promise<StoredStream>;
  delete(key: string): Promise<void>;
}

export interface StreamLimits {
  maxBytes: number;
  size?: number;
  sha256?: string;
}
export interface StoredStream {
  size: number;
  sha256: string;
}

/** 每段不超过 8 MiB；调用方与 S3 上传均以背压限制内存。 */
export async function* checkedParts(
  body: Readable,
  limits: StreamLimits,
): AsyncGenerator<Buffer, StoredStream> {
  const hash = createHash('sha256');
  const partSize = 8 * 1024 * 1024;
  let part = Buffer.allocUnsafe(partSize);
  let used = 0;
  let size = 0;
  for await (const value of body) {
    const bytes = Buffer.from(value as Uint8Array);
    size += bytes.length;
    if (size > limits.maxBytes) throw new HttpError(413, 'file_size', '文件超过传输大小上限');
    hash.update(bytes);
    let offset = 0;
    while (offset < bytes.length) {
      const count = Math.min(partSize - used, bytes.length - offset);
      bytes.copy(part, used, offset, offset + count);
      used += count;
      offset += count;
      if (used === partSize) {
        yield part;
        part = Buffer.allocUnsafe(partSize);
        used = 0;
      }
    }
  }
  if (used) yield part.subarray(0, used);
  const sha256 = hash.digest('hex');
  if (limits.size !== undefined && size !== limits.size) throw new Error('文件传输大小不一致');
  if (limits.sha256 !== undefined && sha256 !== limits.sha256) throw new Error('文件校验和不一致');
  return { size, sha256 };
}

export function createObjectStore(options: {
  endpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  multipartMaxAgeMs?: number;
  logger?: Logger;
}): { store: ObjectStore; resource: ServiceResource; ensureBucket(): Promise<void> } {
  const client = new S3Client({
    endpoint: options.endpoint,
    region: options.region,
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: { accessKeyId: options.accessKey, secretAccessKey: options.secretKey },
  });
  const Bucket = options.bucket;
  let timer: ReturnType<typeof setInterval> | undefined;
  let sweeping: Promise<void> | undefined;
  function sweep() {
    if (sweeping) return sweeping;
    const work = (async () => {
      let KeyMarker: string | undefined;
      let UploadIdMarker: string | undefined;
      do {
        const page = await client.send(
          new ListMultipartUploadsCommand({ Bucket, KeyMarker, UploadIdMarker }),
        );
        for (const upload of page.Uploads ?? []) {
          if (
            upload.Key &&
            upload.UploadId &&
            upload.Initiated &&
            upload.Initiated.getTime() < Date.now() - (options.multipartMaxAgeMs ?? 24 * 3600_000)
          )
            await client.send(
              new AbortMultipartUploadCommand({
                Bucket,
                Key: upload.Key,
                UploadId: upload.UploadId,
              }),
            );
        }
        KeyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
        UploadIdMarker = page.IsTruncated ? page.NextUploadIdMarker : undefined;
      } while (KeyMarker);
    })();
    sweeping = work;
    void work
      .finally(() => {
        sweeping = undefined;
      })
      .catch(() => undefined);
    return work;
  }
  return {
    store: {
      sign(key, method, expiresIn) {
        if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 3600)
          throw new Error('Invalid signature lifetime');
        return getSignedUrl(
          client,
          method === 'GET'
            ? new GetObjectCommand({ Bucket, Key: key })
            : new PutObjectCommand({ Bucket, Key: key }),
          { expiresIn },
        );
      },
      async put(key, body, contentType) {
        await client.send(
          new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType }),
        );
      },
      async get(key) {
        const result = await client.send(new GetObjectCommand({ Bucket, Key: key }));
        if (!result.Body) throw new Error(`对象存储里没有 ${key}`);
        return Buffer.from(await result.Body.transformToByteArray());
      },
      async read(key, range) {
        const result = await client.send(
          new GetObjectCommand({
            Bucket,
            Key: key,
            ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
          }),
        );
        if (!result.Body) throw new Error(`对象存储里没有 ${key}`);
        // Node 里 SDK 返回的就是可读流
        return result.Body as Readable;
      },
      async putStream(key, body, contentType, limits) {
        let uploadId: string | undefined;
        const parts: { ETag: string; PartNumber: number }[] = [];
        const iterator = checkedParts(body, limits);
        try {
          for (;;) {
            const item = await iterator.next();
            if (item.done) {
              if (uploadId)
                await client.send(
                  new CompleteMultipartUploadCommand({
                    Bucket,
                    Key: key,
                    UploadId: uploadId,
                    MultipartUpload: { Parts: parts },
                  }),
                );
              else
                await client.send(
                  new PutObjectCommand({
                    Bucket,
                    Key: key,
                    Body: Buffer.alloc(0),
                    ContentType: contentType,
                  }),
                );
              return item.value;
            }
            if (!uploadId) {
              const started = await client.send(
                new CreateMultipartUploadCommand({ Bucket, Key: key, ContentType: contentType }),
              );
              uploadId = started.UploadId;
              if (!uploadId) throw new Error('对象存储没有返回分段上传 ID');
            }
            const PartNumber = parts.length + 1;
            const result = await client.send(
              new UploadPartCommand({
                Bucket,
                Key: key,
                UploadId: uploadId,
                PartNumber,
                Body: item.value,
              }),
            );
            if (!result.ETag) throw new Error('对象存储没有返回分段校验标识');
            parts.push({ ETag: result.ETag, PartNumber });
          }
        } catch (error) {
          body.destroy();
          if (uploadId)
            await client
              .send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId }))
              .catch(() => undefined);
          throw error;
        } finally {
          await iterator.return({ size: 0, sha256: '' });
        }
      },
      async delete(key) {
        await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
      },
    },
    /** 桶不存在就建（启动时调用一次） */
    async ensureBucket() {
      try {
        await client.send(new HeadBucketCommand({ Bucket }));
      } catch {
        await client.send(new CreateBucketCommand({ Bucket }));
      }
      await sweep();
      if (!timer) {
        timer = setInterval(() => {
          void sweep().catch((err: unknown) =>
            options.logger?.warn({ err }, '过期分段上传清理失败'),
          );
        }, 3600_000);
        timer.unref();
      }
    },
    resource: {
      name: 'object-store',
      ready: async () => {
        await client.send(new HeadBucketCommand({ Bucket }));
      },
      close: async () => {
        if (timer) clearInterval(timer);
        await sweeping?.catch(() => undefined);
        client.destroy();
      },
    },
  };
}
