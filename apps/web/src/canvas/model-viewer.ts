// Trusted script compiled into the opaque iframe; receives checked bytes through a private MessagePort.
import {
  AmbientLight,
  AnimationMixer,
  Box3,
  BufferGeometry,
  Color,
  DirectionalLight,
  Float32BufferAttribute,
  LoadingManager,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
  type Object3D,
  type Material,
  type Texture,
} from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SVGRenderer } from 'three/addons/renderers/SVGRenderer.js';
import { MODEL_PREVIEW_LIMITS as L } from '@oasis/contracts/model-preview';

declare global {
  interface Window {
    __OASIS_MODEL_NONCE__?: string;
  }
}
let connected = false;
window.addEventListener('message', (event) => {
  if (
    connected ||
    event.source !== parent ||
    event.data?.type !== 'connect' ||
    event.data.nonce !== window.__OASIS_MODEL_NONCE__ ||
    event.ports.length !== 1
  )
    return;
  connected = true;
  run(event.ports[0]!);
});
function run(port: MessagePort) {
  let renderer: WebGLRenderer | SVGRenderer | undefined,
    scene: Scene | undefined,
    camera: PerspectiveCamera | undefined;
  let controls: OrbitControls | undefined,
    model: GLTF | undefined,
    mixer: AnimationMixer | undefined;
  let disposed = false,
    loaded = false,
    playing = false,
    animation = 0,
    last = 0,
    radius = 1;
  let structure = false;
  // 观看控制（ADR 0012 §12）：只改这个画面里的灯光、视角和线框，不改模型文件
  let ambient: AmbientLight | undefined,
    sun: DirectionalLight | undefined,
    baseColor = new Color(),
    baseAmbient = 0,
    baseSun = 0;
  const LEVELS = { dim: 0.5, normal: 1, bright: 1.6 } as const;
  /** 色温：在主题光色上乘一个系数（暖偏黄、冷偏蓝） */
  const TONES = { warm: [1, 0.86, 0.7], neutral: [1, 1, 1], cool: [0.78, 0.88, 1] } as const;
  const VIEWS = {
    iso: [1, 0.7, 1.3],
    front: [0, 0, 1],
    side: [1, 0, 0],
    top: [0, 1, 0.0001],
  } as const;
  function setLight(level: unknown, tone: unknown) {
    if (!ambient || !sun) return;
    const k = LEVELS[level as keyof typeof LEVELS] ?? 1;
    const [r, g, b] = TONES[tone as keyof typeof TONES] ?? TONES.neutral;
    const color = baseColor.clone().multiply(new Color(r, g, b));
    ambient.color.copy(color);
    sun.color.copy(color);
    ambient.intensity = baseAmbient * k;
    sun.intensity = baseSun * k;
  }
  function setView(preset: unknown) {
    const direction = VIEWS[preset as keyof typeof VIEWS];
    if (!direction || !camera || !controls) return;
    controls.target.set(0, 0, 0);
    camera.position
      .set(direction[0], direction[1], direction[2])
      .normalize()
      .multiplyScalar(radius * 3.6);
    controls.update();
  }
  function setWireframe(on: boolean) {
    model?.scene.traverse((object) => {
      const mesh = object as Object3D & { material?: Material | Material[] };
      for (const material of mesh.material
        ? Array.isArray(mesh.material)
          ? mesh.material
          : [mesh.material]
        : []) {
        if ('wireframe' in material) {
          (material as Material & { wireframe: boolean }).wireframe = on;
          material.needsUpdate = true;
        }
      }
    });
  }
  const manager = new LoadingManager();
  const urls = new Set<string>();
  let releasedObjects = { geometries: 0, materials: 0, textures: 0 };
  const makeUrl = URL.createObjectURL.bind(URL),
    revokeUrl = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (blob) => {
    const url = makeUrl(blob);
    urls.add(url);
    return url;
  };
  URL.revokeObjectURL = (url) => {
    urls.delete(url);
    revokeUrl(url);
  };
  manager.setURLModifier((url) => {
    if (!urls.has(url)) throw new Error('External resource denied');
    return url;
  });
  const render = () => {
    if (!disposed && renderer && scene && camera) {
      renderer.render(scene, camera);
      if (renderer instanceof SVGRenderer)
        for (const path of renderer.domElement.querySelectorAll('path')) {
          // Use trusted SVG presentation attributes; keep CSP's inline-style ban.
          for (const declaration of (path.getAttribute('style') ?? '').split(';')) {
            const [property, value] = declaration.split(':');
            if (
              property &&
              [
                'fill',
                'fill-opacity',
                'stroke',
                'stroke-opacity',
                'stroke-width',
                'stroke-linecap',
                'stroke-linejoin',
              ].includes(property) &&
              value &&
              !value.includes('url') &&
              value.length <= 100
            )
              path.setAttribute(property, value);
          }
          path.removeAttribute('style');
        }
    }
  };
  const releaseObjects = (roots: Object3D[]) => {
    const geometries = new Set<BufferGeometry>(),
      materials = new Set<Material>(),
      textures = new Set<Texture>();
    for (const root of roots)
      root.traverse((object) => {
        const mesh = object as Object3D & {
          geometry?: BufferGeometry;
          material?: Material | Material[];
        };
        if (mesh.geometry) geometries.add(mesh.geometry);
        for (const material of mesh.material
          ? Array.isArray(mesh.material)
            ? mesh.material
            : [mesh.material]
          : []) {
          materials.add(material);
          for (const value of Object.values(material))
            if (value?.isTexture) textures.add(value as Texture);
        }
      });
    for (const texture of textures) {
      (texture.image as { close?: () => void } | undefined)?.close?.();
      texture.dispose();
    }
    for (const material of materials) material.dispose();
    for (const geometry of geometries) geometry.dispose();
    releasedObjects = {
      geometries: geometries.size,
      materials: materials.size,
      textures: textures.size,
    };
  };
  const resize = () => {
    if (!renderer || !camera) return;
    const width = Math.max(1, innerWidth),
      height = Math.max(1, innerHeight);
    const scale = Math.min(1, 1024 / width, 768 / height);
    renderer.setSize(Math.round(width * scale), Math.round(height * scale), false);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    render();
  };
  const stopFrame = () => {
    cancelAnimationFrame(animation);
    animation = 0;
    last = 0;
  };
  const tick = (time: number) => {
    animation = 0;
    if (!playing || disposed || document.hidden) return;
    mixer?.update(last ? Math.min(0.1, (time - last) / 1000) : 0);
    last = time;
    render();
    animation = requestAnimationFrame(tick);
  };
  const setPlaying = (value: boolean) => {
    playing = value;
    stopFrame();
    if (playing && !document.hidden) animation = requestAnimationFrame(tick);
  };
  const visibility = () => setPlaying(playing);
  function dispose() {
    if (disposed) return;
    disposed = true;
    setPlaying(false);
    manager.abort();
    controls?.dispose();
    if (model) {
      mixer?.stopAllAction();
      mixer?.uncacheRoot(model.scene);
      releaseObjects(model.scenes);
    }
    scene?.clear();
    for (const url of urls) revokeUrl(url);
    urls.clear();
    URL.createObjectURL = makeUrl;
    URL.revokeObjectURL = revokeUrl;
    if (renderer instanceof WebGLRenderer) {
      renderer.dispose();
      renderer.forceContextLoss();
    }
    renderer?.domElement.remove();
    window.removeEventListener('resize', resize);
    document.removeEventListener('visibilitychange', visibility);
    const report = {
      type: 'disposed',
      urls: urls.size,
      frame: animation,
      memory: renderer instanceof WebGLRenderer ? renderer.info.memory : undefined,
      structure,
      releasedObjects,
      contextLost: renderer instanceof WebGLRenderer ? renderer.getContext().isContextLost() : true,
    };
    port.postMessage(report);
    port.close();
  }
  function fit() {
    if (!camera || !controls) return;
    controls.target.set(0, 0, 0);
    camera.position
      .set(1, 0.7, 1.3)
      .normalize()
      .multiplyScalar(radius * 3.6);
    camera.near = Math.max(radius / 1000, 0.00001);
    camera.far = radius * 100;
    camera.updateProjectionMatrix();
    controls.minDistance = radius * 0.2;
    controls.maxDistance = radius * 25;
    controls.update();
    controls.saveState();
    render();
  }
  async function load(data: {
    bytes: ArrayBuffer;
    theme: { light: string; ground: string };
    structure: boolean;
    fallbackAvailable: boolean;
  }) {
    if (loaded || !(data.bytes instanceof ArrayBuffer) || data.bytes.byteLength > L.bytes)
      throw new Error('Invalid model payload');
    loaded = true;
    structure = data.structure;
    if (!structure) {
      try {
        renderer = new WebGLRenderer({
          antialias: true,
          alpha: true,
          powerPreference: 'low-power',
        });
      } catch (error) {
        if (data.fallbackAvailable) throw error;
        structure = true;
      }
    }
    if (structure) {
      renderer = new SVGRenderer();
      renderer.setQuality('low');
      renderer.setPrecision(2);
    }
    if (!renderer) throw new Error('Renderer missing');
    if (renderer instanceof WebGLRenderer) renderer.setPixelRatio(1);
    document.body.append(renderer.domElement);
    renderer.domElement.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      if (!disposed) {
        port.postMessage({ type: 'error', reason: 'WebGL 资源不可用，已切换配套预览。' });
        dispose();
      }
    });
    scene = new Scene();
    scene.background = new Color(data.theme.ground);
    baseColor = new Color(data.theme.light);
    baseAmbient = structure ? 1 : 2;
    baseSun = structure ? 0.6 : 3;
    ambient = new AmbientLight(baseColor.clone().multiplyScalar(structure ? 0.2 : 1), baseAmbient);
    scene.add(ambient);
    sun = new DirectionalLight(baseColor.clone(), baseSun);
    sun.position.set(3, 4, 5);
    scene.add(sun);
    camera = new PerspectiveCamera(35, 1, 0.01, 1000);
    controls = new OrbitControls(camera, document.body);
    controls.addEventListener('change', render);
    controls.minPolarAngle = 0.05;
    controls.maxPolarAngle = Math.PI - 0.05;
    model = await new GLTFLoader(manager).parseAsync(data.bytes, '');
    if (disposed) {
      releaseObjects(model.scenes);
      return;
    }
    if (structure) {
      const meshes: (Object3D & { geometry: BufferGeometry })[] = [];
      model.scene.traverse((object) => {
        if ((object as { isMesh?: boolean }).isMesh)
          meshes.push(object as Object3D & { geometry: BufferGeometry });
      });
      const count = (geometry: BufferGeometry) =>
        Math.floor((geometry.index?.count ?? geometry.getAttribute('position').count) / 3);
      const total = meshes.reduce((sum, mesh) => sum + count(mesh.geometry), 0);
      let left = 4000;
      for (const mesh of meshes) {
        const original = mesh.geometry,
          faces = count(original);
        const take = Math.min(left, faces, Math.max(1, Math.floor((faces / total) * 4000)));
        left -= take;
        if (!take) {
          mesh.visible = false;
          continue;
        }
        const reduced = new BufferGeometry();
        const positions: number[] = [],
          colors: number[] = [];
        const position = original.getAttribute('position'),
          color = original.getAttribute('color');
        for (let i = 0; i < take; i++) {
          const start = Math.floor((i * faces) / take) * 3;
          for (let j = 0; j < 3; j++) {
            const id = original.index ? original.index.getX(start + j) : start + j;
            positions.push(position.getX(id), position.getY(id), position.getZ(id));
            if (color) colors.push(color.getX(id), color.getY(id), color.getZ(id));
          }
        }
        reduced.setAttribute('position', new Float32BufferAttribute(positions, 3));
        if (colors.length) reduced.setAttribute('color', new Float32BufferAttribute(colors, 3));
        reduced.computeVertexNormals();
        mesh.geometry = reduced;
      }
    }
    const box = new Box3().setFromObject(model.scene),
      size = box.getSize(new Vector3()),
      center = box.getCenter(new Vector3());
    radius = Math.max(size.x, size.y, size.z);
    if (
      ![...size.toArray(), ...center.toArray()].every(Number.isFinite) ||
      radius <= 0 ||
      radius > 10000000
    )
      throw new Error('Model bounds exceed preview limits');
    model.scene.position.sub(center);
    scene.add(model.scene);
    mixer = new AnimationMixer(model.scene);
    if (model.animations[0]) {
      const action = mixer.clipAction(model.animations[0]);
      action.play();
    }
    fit();
    resize();
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', visibility);
    port.postMessage({
      type: 'ready',
      structure,
      dimensions: size.toArray(),
      animations: model.animations.map((clip, i) => ({
        name: clip.name.slice(0, 100) || `动画 ${i + 1}`,
        duration: clip.duration,
      })),
    });
  }
  port.onmessage = (event) => {
    const data = event.data as Record<string, unknown>;
    if (data?.type === 'dispose') {
      dispose();
      return;
    }
    if (disposed) return;
    if (data?.type === 'load') {
      void load(data as unknown as Parameters<typeof load>[0]).catch(() => {
        if (disposed) return;
        port.postMessage({ type: 'error', reason: '此模型无法交互显示，可使用配套图片/视频。' });
        dispose();
      });
      return;
    }
    if (!controls || !camera || !model) return;
    if (data.type === 'fit' || data.type === 'reset') fit();
    if (data.type === 'zoom-in' || data.type === 'zoom-out') {
      camera.position
        .sub(controls.target)
        .multiplyScalar(data.type === 'zoom-in' ? 0.8 : 1.25)
        .add(controls.target);
      controls.update();
    }
    if (data.type === 'left' || data.type === 'right') {
      camera.position
        .sub(controls.target)
        .applyAxisAngle(new Vector3(0, 1, 0), data.type === 'left' ? 0.25 : -0.25)
        .add(controls.target);
      controls.update();
    }
    if (data.type === 'pan-left' || data.type === 'pan-right') {
      const shift = new Vector3(data.type === 'pan-left' ? -radius * 0.1 : radius * 0.1, 0, 0);
      controls.target.add(shift);
      camera.position.add(shift);
      controls.update();
    }
    if (data.type === 'view') setView(data.preset);
    // 结构预览（SVG）没有材质和灯光，只给视角
    if (data.type === 'wireframe' && !structure) setWireframe(data.on === true);
    if (data.type === 'light' && !structure) setLight(data.level, data.tone);
    if (data.type === 'play' && !structure) setPlaying(data.playing === true);
    if (
      data.type === 'clip' &&
      Number.isInteger(data.index) &&
      Number(data.index) >= 0 &&
      Number(data.index) < model.animations.length
    ) {
      mixer?.stopAllAction();
      mixer?.clipAction(model.animations[Number(data.index)]!).play();
      render();
    }
    render();
  };
  port.start();
  window.addEventListener('pagehide', dispose, { once: true });
}
