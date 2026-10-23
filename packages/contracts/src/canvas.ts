// canvas 的接口：用户上传的素材（ADR 0007 §3）。5.5c 再加成果登记。
import { z } from 'zod';

/** 文件名：不能带路径、控制字符，也不能是 . 或 .. */
export const FileName = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    // eslint-disable-next-line no-control-regex
    (name) => !/[/\\\u0000-\u001f]/.test(name) && name !== '.' && name !== '..',
    '文件名不能包含路径或控制字符',
  );

/** POST /v1/uploads?name=…：请求体就是文件本身 */
export const UploadQuery = z.object({ name: FileName });

export const UploadBody = z.object({
  id: z.uuid(),
  name: z.string(),
  size: z.number().int().nonnegative(),
  contentType: z.string(),
  createdAt: z.iso.datetime(),
});
export type UploadBody = z.infer<typeof UploadBody>;

/** 内部：按 id 查文件，并核对是不是这个人的（conversation 收附件时用） */
export const UploadLookupBody = z.object({
  ownerId: z.uuid(),
  ids: z.array(z.uuid()).min(1).max(20),
});
export const UploadLookupResult = z.object({ uploads: z.array(UploadBody) });

/** 交给工作流的素材：任务上记着，规划员和每个节点运行时放进沙箱的 materials/ 下 */
export const Material = z.object({
  uploadId: z.uuid(),
  name: z.string(),
  size: z.number().int().nonnegative(),
});
export type Material = z.infer<typeof Material>;
