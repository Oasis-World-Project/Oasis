import { describe, expect, it } from 'vitest';
import { inspectFiles } from '../src/service/file-inspection.ts';

function fixture(
  change: (data: Record<string, unknown>) => void = () => undefined,
  corrupt = false,
) {
  const bin = Buffer.alloc(44);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((v, i) => bin.writeFloatLE(v, i * 4));
  [0, 1, corrupt ? 9 : 2].forEach((v, i) => bin.writeUInt16LE(v, 36 + i * 2));
  const data: Record<string, unknown> = {
    asset: { version: '2.0' },
    scene: 0,
    buffers: [{ byteLength: 42 }],
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
