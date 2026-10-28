// GLB is a container, not a trust boundary: validate real geometry and reject external resources.
import sharp from 'sharp';

export class GeometryLimit extends Error {}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const list = (value: unknown): Record<string, unknown>[] => {
  check(Array.isArray(value), 'GLB 数组无效');
  if (value.length > 10000) throw new GeometryLimit('GLB 数组超过检查上限');
  check(
    value.every((v) => v && typeof v === 'object' && !Array.isArray(v)),
    'GLB 条目无效',
  );
  return value as Record<string, unknown>[];
};
const index = (value: unknown, length: number): number => {
  check(Number.isInteger(value) && Number(value) >= 0 && Number(value) < length, 'GLB 引用越界');
  return Number(value);
};

export async function inspectGlb(bytes: Buffer, maxPixels: number): Promise<string> {
  check(bytes.length >= 28 && bytes.toString('ascii', 0, 4) === 'glTF', 'GLB 文件头无效');
  check(
    bytes.readUInt32LE(4) === 2 && bytes.readUInt32LE(8) === bytes.length,
    'GLB 版本或长度无效',
  );
  const chunks: { type: number; bytes: Buffer }[] = [];
  for (let p = 12; p < bytes.length;) {
    check(p + 8 <= bytes.length, 'GLB chunk 头不完整');
    const size = bytes.readUInt32LE(p);
    check(size % 4 === 0 && size > 0 && p + 8 + size <= bytes.length, 'GLB chunk 越界');
    chunks.push({ type: bytes.readUInt32LE(p + 4), bytes: bytes.subarray(p + 8, p + 8 + size) });
    p += 8 + size;
    check(chunks.length <= 2, 'GLB 不支持额外 chunk');
  }
  check(
    chunks.length === 2 && chunks[0]?.type === 0x4e4f534a && chunks[1]?.type === 0x004e4942,
    'GLB 必须包含 JSON 与 BIN',
  );
  if (chunks[0].bytes.length > 4 * 1024 ** 2) throw new GeometryLimit('GLB JSON 超过检查上限');
  const data = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(chunks[0].bytes),
  ) as Record<string, unknown>;
  const bin = chunks[1].bytes;
  // No URI (including external URI hidden in an extension) is fetched by any subsequent loader.
  const queue: unknown[] = [data];
  let visited = 0;
  while (queue.length) {
    const value = queue.pop();
    if (++visited > 200000) throw new GeometryLimit('GLB 结构超过检查上限');
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        check(key !== 'uri', 'GLB 不允许 URI；资源必须自包含');
        queue.push(child);
      }
    }
  }
  check((data.asset as Record<string, unknown>)?.version === '2.0', 'GLB asset.version 无效');
  if (data.extensionsRequired !== undefined) {
    check(Array.isArray(data.extensionsRequired), 'GLB extensionsRequired 无效');
    if (data.extensionsRequired.length) throw new GeometryLimit('GLB 所需扩展尚未支持');
  }
  const buffers = list(data.buffers);
  check(buffers.length === 1, 'GLB 必须只有一个内嵌 buffer');
  const length = Number(buffers[0]?.byteLength);
  check(
    Number.isInteger(buffers[0]?.byteLength) &&
      length > 0 &&
      length <= bin.length &&
      bin.length - length <= 3,
    'GLB buffer 长度无效',
  );
  const views = list(data.bufferViews);
  const ranges = views.map((v) => {
    check(v.buffer === 0, 'GLB buffer 索引无效');
    const start = Number(v.byteOffset ?? 0),
      size = Number(v.byteLength);
    check(
      Number.isInteger(v.byteOffset ?? 0) &&
        start >= 0 &&
        Number.isInteger(v.byteLength) &&
        size > 0 &&
        start + size <= length,
      'GLB bufferView 越界',
    );
    return { start, size, stride: v.byteStride };
  });
  const accessors = list(data.accessors);
  const components: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
  const widths: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
  const spans = accessors.map((a) => {
    if (a.sparse) throw new GeometryLimit('GLB sparse accessor 尚未支持');
    const v = ranges[index(a.bufferView, ranges.length)]!;
    const width = widths[Number(a.componentType)],
      count = Number(a.count),
      n = components[String(a.type)];
    check(
      width && n && Number.isInteger(a.componentType) && Number.isInteger(a.count) && count > 0,
      'GLB accessor 类型或数量无效',
    );
    if (count > 3000000) throw new GeometryLimit('GLB accessor 数量超过检查上限');
    const offset = Number(a.byteOffset ?? 0),
      stride = Number(v.stride ?? width * n);
    check(
      Number.isInteger(a.byteOffset ?? 0) &&
        offset >= 0 &&
        offset % width === 0 &&
        (v.start + offset) % width === 0 &&
        Number.isInteger(v.stride ?? width * n) &&
        stride >= width * n &&
        stride % width === 0 &&
        (count - 1) * stride + width * n + offset <= v.size,
      'GLB accessor 越界或对齐无效',
    );
    return { start: v.start + offset, count, stride, width };
  });
  let vertices = 0,
    triangles = 0;
  const meshes = list(data.meshes);
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const mesh of meshes) {
    for (const p of list(mesh.primitives)) {
      if (p.mode !== undefined && p.mode !== 4) throw new GeometryLimit('GLB 首批仅检查三角面网格');
      const position = index((p.attributes as Record<string, unknown>)?.POSITION, accessors.length);
      const a = accessors[position]!,
        span = spans[position]!;
      check(a.type === 'VEC3' && a.componentType === 5126, 'GLB POSITION 必须为 float VEC3');
      vertices += span.count;
      if (vertices > 1000000) throw new GeometryLimit('GLB 顶点超过检查上限');
      for (let i = 0; i < span.count; i++) {
        for (let axis = 0; axis < 3; axis++) {
          const value = bin.readFloatLE(span.start + i * span.stride + axis * 4);
          check(Number.isFinite(value), 'GLB 顶点包含非有限数值');
          bounds.min[axis] = Math.min(bounds.min[axis]!, value);
          bounds.max[axis] = Math.max(bounds.max[axis]!, value);
        }
      }
      let count = span.count;
      if (p.indices !== undefined) {
        const id = index(p.indices, accessors.length),
          indices = accessors[id]!,
          s = spans[id]!;
        check(
          indices.type === 'SCALAR' && [5121, 5123, 5125].includes(Number(indices.componentType)),
          'GLB 面索引类型无效',
        );
        count = s.count;
        for (let n = 0; n < count; n++)
          check(bin.readUIntLE(s.start + n * s.stride, s.width) < span.count, 'GLB 面索引超出顶点');
      }
      check(count % 3 === 0, 'GLB 三角面数量无效');
      triangles += count / 3;
      if (triangles > 1000000) throw new GeometryLimit('GLB 三角面超过检查上限');
    }
  }
  check(
    vertices > 0 && triangles > 0 && bounds.max.some((v, i) => v > bounds.min[i]!),
    'GLB 几何为空或退化',
  );
  let pixels = 0;
  for (const image of list(data.images ?? [])) {
    const view = ranges[index(image.bufferView, ranges.length)]!;
    check(['image/png', 'image/jpeg'].includes(String(image.mimeType)), 'GLB 贴图格式尚未支持');
    const metadata = await sharp(bin.subarray(view.start, view.start + view.size), {
      limitInputPixels: maxPixels,
    }).metadata();
    pixels += (metadata.width ?? 0) * (metadata.height ?? 0);
    if (pixels > maxPixels) throw new GeometryLimit('GLB 贴图总像素超过检查上限');
  }
  const nodes = list(data.nodes),
    scenes = list(data.scenes);
  let traversed = 0;
  const visibleMeshes = new Set<number>();
  const visit = (id: number, ancestors: Set<number>, depth: number): void => {
    if (++traversed > 20000) throw new GeometryLimit('GLB 场景遍历超过检查上限');
    check(depth < 100 && !ancestors.has(id), 'GLB 场景节点循环或过深');
    const node = nodes[id]!;
    if (node.mesh !== undefined) visibleMeshes.add(index(node.mesh, meshes.length));
    for (const key of ['translation', 'rotation', 'scale', 'matrix']) {
      if (node[key] !== undefined)
        check(
          Array.isArray(node[key]) &&
            node[key].length === (key === 'matrix' ? 16 : key === 'rotation' ? 4 : 3) &&
            (node[key] as unknown[]).every((v) => typeof v === 'number' && Number.isFinite(v)),
          'GLB 变换数值无效',
        );
    }
    if (node.children !== undefined) {
      check(Array.isArray(node.children), 'GLB children 无效');
      for (const child of node.children)
        visit(index(child, nodes.length), new Set([...ancestors, id]), depth + 1);
    }
  };
  check(scenes.length > 0, 'GLB 缺少场景');
  const scene = scenes[index(data.scene ?? 0, scenes.length)]!;
  check(Array.isArray(scene.nodes) && scene.nodes.length > 0, 'GLB 场景为空');
  for (const node of scene.nodes) visit(index(node, nodes.length), new Set(), 0);
  check(visibleMeshes.size > 0, 'GLB 默认场景没有可见网格');
  return JSON.stringify({
    format: 'glTF 2.0',
    vertices,
    triangles,
    meshes: meshes.length,
    nodes: nodes.length,
    images: (data.images as unknown[] | undefined)?.length ?? 0,
    meshLocalBounds: bounds,
    units: '格式使用米；原始来源是否按真实尺度建模仍需独立核对',
    unchecked: ['外观与需求一致性', '场景变换后的实际尺寸', '可打印性/拓扑质量', '动画和材质语义'],
  });
}
