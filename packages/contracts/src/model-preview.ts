import { z } from 'zod';

/** Bounds of the first self-contained GLB viewer protocol, enforced on both sides. */
export const MODEL_PREVIEW_LIMITS = {
  bytes: 16 * 1024 ** 2,
  vertices: 200000,
  triangles: 200000,
  nodes: 2000,
  texturePixels: 8 * 1024 ** 2,
  textureSide: 2048,
  images: 32,
  clips: 8,
  channels: 200,
  keyframes: 100000,
  durationSeconds: 600,
} as const;
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const path = z
  .string()
  .min(1)
  .max(500)
  .refine((p) =>
    p
      .split('/')
      .every(
        (s) => /^[\p{L}\p{N} _.-]+$/u.test(s) && s !== '.' && s !== '..' && !s.startsWith('.'),
      ),
  );
const fileRef = z.strictObject({ path, sha256: sha });
/** An explicit sidecar can reference only files already in the formal delivery list. */
export const ModelPreviewSpec = z.strictObject({
  version: z.literal(1),
  source: fileRef,
  glb: fileRef.optional(),
  poster: fileRef.optional(),
  turntable: fileRef.optional(),
  simplified: z.boolean().default(false),
});
export const ModelPreviewSource = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('artifact'), id: z.uuid() }),
  z.strictObject({ kind: z.literal('upload'), id: z.uuid() }),
  z.strictObject({ kind: z.literal('task'), taskId: z.uuid(), nodeId: z.uuid(), path }),
]);
export type ModelPreviewSource = z.infer<typeof ModelPreviewSource>;
const vec = z.array(z.number().finite()).length(3);
export const GeometryPreviewReport = z.object({
  vertices: z.number().int().positive().max(MODEL_PREVIEW_LIMITS.vertices),
  triangles: z.number().int().positive().max(MODEL_PREVIEW_LIMITS.triangles),
  nodes: z.number().int().positive().max(MODEL_PREVIEW_LIMITS.nodes),
  images: z.number().int().nonnegative().max(MODEL_PREVIEW_LIMITS.images),
  texturePixels: z.number().int().nonnegative().max(MODEL_PREVIEW_LIMITS.texturePixels),
  meshLocalBounds: z.object({ min: vec, max: vec }),
  animations: z
    .array(
      z.object({
        name: z.string().max(100),
        duration: z.number().finite().nonnegative().max(MODEL_PREVIEW_LIMITS.durationSeconds),
      }),
    )
    .max(MODEL_PREVIEW_LIMITS.clips),
  unchecked: z.array(z.string()).max(30),
});
export type GeometryPreviewReport = z.infer<typeof GeometryPreviewReport>;
export const ModelInspectionBody = z.strictObject({
  sha256: sha,
  contentBase64: z
    .string()
    .min(1)
    .max(Math.ceil(MODEL_PREVIEW_LIMITS.bytes / 3) * 4),
});
export const ModelInspectionResult = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), sha256: sha, report: GeometryPreviewReport }),
  z.object({
    status: z.enum(['unsupported', 'invalid']),
    sha256: sha,
    reason: z.string().max(1000),
  }),
]);
export const ModelPosterResult = z.object({
  sha256: sha,
  width: z.number().int().positive().max(MODEL_PREVIEW_LIMITS.textureSide),
  height: z.number().int().positive().max(MODEL_PREVIEW_LIMITS.textureSide),
});
const media = z.object({
  url: z.string().startsWith('/api/'),
  sha256: sha,
  size: z.number().int().positive(),
  name: z.string(),
});
export const ModelPreviewHint = z.object({
  kind: z.literal('model'),
  posterId: z.uuid().optional(),
});
export const ModelPreviewBody = z.object({
  source: media,
  simplified: z.boolean(),
  glb: media.extend({ report: GeometryPreviewReport }).optional(),
  poster: media.optional(),
  turntable: media.optional(),
  warning: z.string().max(1000).optional(),
});
export type ModelPreviewBody = z.infer<typeof ModelPreviewBody>;
