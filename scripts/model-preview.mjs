// Free local HTTP/worker + real Electron smoke. No cloud accounts, databases or model calls.
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = path.join(root, 'out', 'model-preview-20261028');
await mkdir(evidence, { recursive: true });
// Uses an already-built local project image; never pulls or creates cloud work.
await new Promise((resolve, reject) => {
  const child = spawn(
    'docker',
    [
      'run',
      '--rm',
      '--pull',
      'never',
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--mount',
      `type=bind,source=${evidence},target=/evidence`,
      '--entrypoint',
      'ffmpeg',
      'oasis/harness-sandbox-base:0.2.1-rc.2',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=orange:s=160x120:r=10',
      '-t',
      '1',
      '-c:v',
      'libvpx',
      '-b:v',
      '100k',
      '-y',
      '/evidence/turntable.webm',
    ],
    { windowsHide: true, stdio: 'inherit' },
  );
  child.once('error', reject);
  child.once('close', (code) =>
    code === 0
      ? resolve()
      : reject(new Error('Local ffmpeg fixture failed; build the sandbox base image first')),
  );
});
const webRequire = createRequire(new URL('../apps/web/package.json', import.meta.url));
const canvasRequire = createRequire(new URL('../services/canvas/package.json', import.meta.url));
const harnessRequire = createRequire(new URL('../services/harness/package.json', import.meta.url));
const { createServer } = await import(pathToFileURL(webRequire.resolve('vite')).href);
const Fastify = canvasRequire('fastify'),
  { pino } = canvasRequire('pino');
const sharp = harnessRequire('sharp');
const { createServiceClient } = await import('../packages/service-kit/dist/index.js');
const { memoryArtifacts, memoryUploads, memoryStore } =
  await import('../services/canvas/test/memory.ts');
const { createArtifactService } =
  await import('../services/canvas/dist/service/artifact-service.js');
const { createUploadService } = await import('../services/canvas/dist/service/upload-service.js');
const { registerRoutes: canvasRoutes } = await import('../services/canvas/dist/api/routes.js');
const { registerRoutes: harnessRoutes } = await import('../services/harness/dist/api/routes.js');
const logger = pino({ level: 'silent' });
const harness = Fastify({ loggerInstance: logger });
harnessRoutes(harness, {});
const harnessUrl = await harness.listen({ host: '127.0.0.1', port: 0 });
const repo = memoryArtifacts(),
  store = memoryStore(),
  owner = randomUUID(),
  taskId = randomUUID(),
  nodeId = randomUUID();
const png = await sharp({
  create: { width: 32, height: 32, channels: 3, background: { r: 242, g: 160, b: 103 } },
})
  .png()
  .toBuffer();
function glb(unsafe = false) {
  const positions = [
    -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1,
  ];
  const indices = [
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2,
    6, 1, 6, 5,
  ];
  const texcoords = [0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1];
  const imageOffset = 264;
  const bin = Buffer.alloc(imageOffset + Math.ceil(png.length / 4) * 4);
  positions.forEach((n, i) => bin.writeFloatLE(n, i * 4));
  texcoords.forEach((n, i) => bin.writeFloatLE(n, 96 + i * 4));
  indices.forEach((n, i) => bin.writeUInt16LE(n, 160 + i * 2));
  [0, 1].forEach((n, i) => bin.writeFloatLE(n, 232 + i * 4));
  [0, 0, 0, 0, 0.5, 0].forEach((n, i) => bin.writeFloatLE(n, 240 + i * 4));
  png.copy(bin, imageOffset);
  const data = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteLength: 96 },
      { buffer: 0, byteOffset: 96, byteLength: 64 },
      { buffer: 0, byteOffset: 160, byteLength: 72 },
      { buffer: 0, byteOffset: 232, byteLength: 8 },
      { buffer: 0, byteOffset: 240, byteLength: 24 },
      { buffer: 0, byteOffset: imageOffset, byteLength: png.length },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 8,
        type: 'VEC3',
        min: [-1, -1, -1],
        max: [1, 1, 1],
      },
      { bufferView: 1, componentType: 5126, count: 8, type: 'VEC2' },
      { bufferView: 2, componentType: 5123, count: 36, type: 'SCALAR' },
      { bufferView: 3, componentType: 5126, count: 2, type: 'SCALAR' },
      { bufferView: 4, componentType: 5126, count: 2, type: 'VEC3' },
    ],
    meshes: [
      { primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] },
    ],
    images: unsafe
      ? [{ uri: 'https://model-exfiltration.invalid/texture.png' }]
      : [{ bufferView: 5, mimeType: 'image/png' }],
    textures: [{ source: 0 }],
    materials: [
      {
        pbrMetallicRoughness: {
          baseColorTexture: { index: 0 },
          metallicFactor: 0,
          roughnessFactor: 0.6,
        },
      },
    ],
    animations: [
      {
        name: '上下移动',
        samplers: [{ input: 3, output: 4, interpolation: 'LINEAR' }],
        channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }],
      },
    ],
  };
  const json = Buffer.from(
    JSON.stringify(data).padEnd(Math.ceil(Buffer.byteLength(JSON.stringify(data)) / 4) * 4, ' '),
  );
  const bytes = Buffer.alloc(28 + json.length + bin.length);
  bytes.write('glTF');
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(json.length, 12);
  bytes.writeUInt32LE(0x4e4f534a, 16);
  json.copy(bytes, 20);
  bytes.writeUInt32LE(bin.length, 20 + json.length);
  bytes.writeUInt32LE(0x004e4942, 24 + json.length);
  bin.copy(bytes, 28 + json.length);
  return bytes;
}
async function add(name, bytes, contentType = 'application/octet-stream') {
  const id = randomUUID(),
    objectKey = `artifacts/${id}`,
    sha256 = createHash('sha256').update(bytes).digest('hex');
  await store.put(objectKey, bytes, contentType);
  const row = {
    id,
    ownerId: owner,
    taskId,
    nodeId,
    path: name,
    name,
    size: bytes.length,
    sha256,
    objectKey,
    contentType,
    category: 'threed',
    deliverable: '模型验证',
    taskTitle: '3D 本地验证',
    conversationId: null,
    appSpec: null,
    models: [],
    syncPath: `模型/${name}`,
  };
  await repo.insert(row);
  return row;
}
const cube = await add('model.glb', glb(), 'model/gltf-binary'),
  native = await add('scene.blend', Buffer.from('Opaque native fixture, never executed')),
  poster = await add('poster.png', png, 'image/png'),
  unsafe = await add('unsafe.glb', glb(true), 'model/gltf-binary'),
  video = await add(
    'turntable.webm',
    await readFile(path.join(evidence, 'turntable.webm')),
    'video/webm',
  );
await add(
  'oasis-model-preview.json',
  Buffer.from(
    JSON.stringify({
      version: 1,
      source: { path: native.name, sha256: native.sha256 },
      glb: { path: cube.name, sha256: cube.sha256 },
      poster: { path: poster.name, sha256: poster.sha256 },
      turntable: { path: video.name, sha256: video.sha256 },
      simplified: true,
    }),
  ),
  'application/json',
);
const task = {
  json: async () => {
    throw new Error('Fixture task API unused');
  },
  stream: async () => {
    throw new Error('Fixture task API unused');
  },
};
const artifacts = createArtifactService({ repo, store, task, logger }),
  uploads = createUploadService({ repo: memoryUploads(), store, logger });
const canvas = Fastify({ loggerInstance: logger });
canvasRoutes(
  canvas,
  {
    artifacts,
    uploads,
    store,
    task,
    harness: createServiceClient('harness', harnessUrl, { timeoutMs: 20000 }),
  },
  { maxBytes: 32 * 1024 ** 2 },
);
const canvasUrl = await canvas.listen({ host: '127.0.0.1', port: 0 });
const files = [
  [cube, '纹理模型'],
  [native, '轻量配套预览'],
  [unsafe, '外部 URI 拒绝'],
].map(([row, label]) => ({
  label,
  path: row.path,
  size: row.size,
  url: `/api/canvas/v1/artifacts/${row.id}/content`,
  downloadUrl: `/api/canvas/v1/artifacts/${row.id}/content?download=1`,
  modelPreview: true,
}));
let dropNextModel = false;
const vite = await createServer({
  root: path.join(root, 'apps/web'),
  mode: 'development',
  server: {
    host: '127.0.0.1',
    port: 0,
    strictPort: false,
    proxy: {
      '/api': {
        target: canvasUrl,
        rewrite: (p) => p.replace(/^\/api\/canvas/, ''),
        configure: (proxy) =>
          proxy.on('proxyReq', (req) => req.setHeader('x-oasis-user-id', owner)),
      },
    },
  },
  plugins: [
    {
      name: 'oasis-model-smoke-host',
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.method === 'POST' && req.url === '/model-preview-fault') {
            dropNextModel = true;
            res.end('armed');
            return;
          }
          if (dropNextModel && req.url === `/api/canvas/v1/artifacts/${cube.id}/content`) {
            dropNextModel = false;
            res.writeHead(200, {
              'content-type': 'model/gltf-binary',
              'content-length': cube.size,
            });
            res.write(glb().subarray(0, 20));
            setTimeout(() => res.destroy(), 20);
            return;
          }
          if (req.url?.split('?')[0] === '/model-preview-fixtures') {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify(files));
            return;
          }
          if (req.url?.split('?')[0] === '/model-preview-test') {
            const html = await server.transformIndexHtml(
              req.url,
              '<!doctype html><meta charset="utf-8"><title>Oasis 3D verification</title><div id="root"></div><script type="module" src="/test/model-preview-host.tsx"></script>',
            );
            res.setHeader('content-type', 'text/html');
            res.end(html);
            return;
          }
          next();
        });
      },
    },
  ],
});
await vite.listen();
const address = vite.httpServer.address();
const url = `http://127.0.0.1:${address.port}/model-preview-test`;
console.log(JSON.stringify({ ready: true, url, evidence }));
await writeFile(
  path.join(evidence, 'fixture.json'),
  JSON.stringify({ url, files, cloudCalls: 0, formalFiles: repo.rows.length }, null, 2),
);
async function stop() {
  await vite.close();
  await canvas.close();
  await harness.close();
}
process.once('SIGINT', () => void stop().then(() => process.exit()));
process.once('SIGTERM', () => void stop().then(() => process.exit()));
if (!process.argv.includes('--serve')) {
  try {
    const desktopRequire = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
    const executable = desktopRequire('electron');
    for (const mode of ['normal', 'no-webgl']) {
      const env = {
        ...process.env,
        OASIS_WEB_URL: url,
        OASIS_MODEL_EVIDENCE: evidence,
        OASIS_MODEL_MODE: mode,
      };
      delete env.ELECTRON_RUN_AS_NODE;
      await new Promise((resolve, reject) => {
        const child = spawn(
          executable,
          [path.join(root, 'apps/desktop/test/model-preview-smoke.cjs')],
          { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let output = '';
        child.stdout.on('data', (bytes) => {
          output += bytes;
        });
        child.stderr.on('data', (bytes) => {
          output += bytes;
        });
        child.once('error', reject);
        child.once('close', async (code) => {
          await writeFile(path.join(evidence, `${mode}.txt`), output);
          if (code === 0) resolve();
          else reject(new Error(`Electron ${mode} failed; see evidence`));
        });
      });
    }
  } finally {
    await stop();
  }
}
