// 对象存储（S3 兼容；本地是 SeaweedFS）。每个服务用自己的桶：harness 存运行产出和会话存档，canvas 存素材和成果。
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { z } from 'zod';
import type { ServiceResource } from './resource.ts';

/** 连接对象存储需要的配置；桶名由各服务自己定（各自给默认值） */
export const objectStoreEnv = {
  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
};

export interface ObjectStore {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
}

export function createObjectStore(options: {
  endpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
}): { store: ObjectStore; resource: ServiceResource; ensureBucket(): Promise<void> } {
  const client = new S3Client({
    endpoint: options.endpoint,
    region: options.region,
    forcePathStyle: true,
    credentials: { accessKeyId: options.accessKey, secretAccessKey: options.secretKey },
  });
  const Bucket = options.bucket;
  return {
    store: {
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
    },
    /** 桶不存在就建（启动时调用一次） */
    async ensureBucket() {
      try {
        await client.send(new HeadBucketCommand({ Bucket }));
      } catch {
        await client.send(new CreateBucketCommand({ Bucket }));
      }
    },
    resource: {
      name: 'object-store',
      ready: async () => {
        await client.send(new HeadBucketCommand({ Bucket }));
      },
      close: async () => client.destroy(),
    },
  };
}
