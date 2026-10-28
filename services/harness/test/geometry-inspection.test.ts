import { describe, expect, it } from 'vitest';
import { inspectFiles } from '../src/service/file-inspection.ts';
import {
  createModelPreviewInspector,
  createModelPosterInspector,
} from '../src/service/file-inspection.ts';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

function fixture(
  change: (data: Record<string, unknown>) => void = () => undefined,
  corrupt = false,
  image?: Buffer,
) {
  const bin = Buffer.alloc(44 + (image ? Math.ceil(image.length / 4) * 4 : 0));
  image?.copy(bin, 44);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((v, i) => bin.writeFloatLE(v, i * 4));
  [0, 1, corrupt ? 9 : 2].forEach((v, i) => bin.writeUInt16LE(v, 36 + i * 2));
  const data: Record<string, unknown> = {
    asset: { version: '2.0' },
    scene: 0,
    buffers: [{ byteLength: image ? bin.length : 42 }],
    bufferViews: [
      { buffer: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
  };
  if (image) {
    (data.bufferViews as object[]).push({ buffer: 0, byteOffset: 44, byteLength: image.length });
    data.images = [{ bufferView: 2, mimeType: 'image/png' }];
  }
  change(data);
  let json = JSON.stringify(data);
  while (Buffer.byteLength(json) % 4) json += ' ';
  const bytes = Buffer.alloc(28 + Buffer.byteLength(json) + bin.length);
  bytes.write('glTF');
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(Buffer.byteLength(json), 12);
  bytes.writeUInt32LE(0x4e4f534a, 16);
  bytes.write(json, 20);
  const offset = 20 + Buffer.byteLength(json);
  bytes.writeUInt32LE(bin.length, offset);
  bytes.writeUInt32LE(0x004e4942, offset + 4);
  bin.copy(bytes, offset + 8);
  return bytes;
}
async function inspect(bytes: Buffer) {
  return (await inspectFiles([{ path: '模型.glb', content: bytes }], 8000)).files[0]!;
}
describe('3D evidence boundary', () => {
  it('reads actual geometry but keeps visual/manufacturing checks unknown', async () => {
    const result = await inspect(fixture());
    expect(result.valid).toBe(true);
    expect(JSON.parse(result.text).triangles).toBe(1);
    expect(JSON.parse(result.text).vertices).toBe(3);
    expect(result.warning).toContain('独立核验');
  });
  it('rejects external URIs, corrupt indices, byte ranges and cyclic scene graphs', async () => {
    for (const bytes of [
      fixture((d) => {
        d.extras = { uri: 'https://example.com/texture.png' };
      }),
      fixture(undefined, true),
      fixture((d) => {
        d.bufferViews = [{ buffer: 0, byteLength: 999 }];
      }),
      fixture((d) => {
        d.nodes = [{ mesh: 0, children: [0] }];
      }),
    ]) {
      const result = await inspect(bytes);
      expect(result.valid).toBe(false);
      expect(result.errorKind).toBe('invalid');
    }
  });
  it('keeps resource limits separate from corrupt file failures', async () => {
    const result = await inspect(
      fixture((d) => {
        d.accessors = [{ bufferView: 0, componentType: 5126, count: 3000001, type: 'VEC3' }];
      }),
    );
    expect(result.errorKind).toBe('incomplete');
  });
  it('keeps required extensions unknown and rejects a default scene without reachable geometry', async () => {
    const unsupported = await inspect(
      fixture((d) => {
        d.extensionsRequired = ['KHR_draco_mesh_compression'];
      }),
    );
    expect(unsupported.errorKind).toBe('incomplete');
    const empty = await inspect(
      fixture((d) => {
        d.nodes = [{}];
      }),
    );
    expect(empty.errorKind).toBe('invalid');
    expect(empty.error).toContain('没有可见网格');
  });
});

describe('受限交互预览检查', () => {
  const check = (content: Buffer) =>
    createModelPreviewInspector()({
      contentBase64: content.toString('base64'),
      sha256: createHash('sha256').update(content).digest('hex'),
    });
  it('生成绑定摘要的预览报告，并校验简单变换动画', async () => {
    const bytes = fixture((data) => {
      const accessors = data.accessors as object[];
      accessors.push(
        { bufferView: 0, byteOffset: 8, componentType: 5126, count: 2, type: 'SCALAR' },
        { bufferView: 0, componentType: 5126, count: 2, type: 'VEC3' },
      );
      data.animations = [
        {
          name: '移动',
          samplers: [{ input: 2, output: 3 }],
          channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }],
        },
      ];
    });
    expect(await check(bytes)).toMatchObject({
      status: 'ready',
      report: { triangles: 1, animations: [{ name: '移动', duration: 1 }] },
    });
    await expect(
      createModelPreviewInspector()({
        contentBase64: bytes.toString('base64'),
        sha256: 'a'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'model_preview_hash' });
  });
  it('隐藏 URI、未支持扩展、骨骼、无效动画与实例化绘制负载不会进入查看器', async () => {
    for (const change of [
      (data: Record<string, unknown>) => {
        data.extras = { nested: { uri: '../stolen' } };
      },
      (data: Record<string, unknown>) => {
        data.extensions = { KHR_lights_punctual: {} };
      },
      (data: Record<string, unknown>) => {
        data.skins = [{ joints: [0] }];
      },
      (data: Record<string, unknown>) => {
        data.animations = [
          {
            samplers: [{ input: 0, output: 0 }],
            channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }],
          },
        ];
      },
      (data: Record<string, unknown>) => {
        data.meshes = [
          {
            primitives: Array.from({ length: 201 }, () => ({
              attributes: { POSITION: 0 },
              indices: 1,
            })),
          },
        ];
        data.nodes = Array.from({ length: 1000 }, () => ({ mesh: 0 }));
        data.scenes = [{ nodes: Array.from({ length: 1000 }, (_, i) => i) }];
      },
    ])
      expect((await check(fixture(change))).status).not.toBe('ready');
  });
  it('封面使用真实完整解码与像素边界，伪装图片不能获得资格', async () => {
    const poster = createModelPosterInspector();
    const png = await sharp({
      create: { width: 2, height: 2, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer();
    const input = (bytes: Buffer) => ({
      name: 'poster.png',
      contentBase64: bytes.toString('base64'),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    expect(await poster(input(png))).toMatchObject({ width: 2, height: 2 });
    await expect(
      poster(input(Buffer.from('<svg><script>evil()</script></svg>'))),
    ).rejects.toMatchObject({ code: 'model_poster_invalid' });
  });
  it('GLB 纹理和封面按真实解码尺寸执行上限，而不是按压缩文件大小放行', async () => {
    const png = await sharp({
      create: { width: 2049, height: 2, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer();
    expect((await check(fixture(undefined, false, png))).status).toBe('unsupported');
    await expect(
      createModelPosterInspector()({
        name: 'poster.png',
        contentBase64: png.toString('base64'),
        sha256: createHash('sha256').update(png).digest('hex'),
      }),
    ).rejects.toMatchObject({ code: 'model_poster_invalid' });
  });
});
