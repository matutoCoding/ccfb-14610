import * as THREE from 'three';
import type { PartSolid, PlannedBead, Vec3 } from '../core/types';
import { getTranslation, type Mat4 } from '../core/mat3d';

export interface Scene3D {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  group: THREE.Group;
  dispose: () => void;
  setMatrix: (obj: THREE.Object3D, m: Mat4) => void;
}

export function createScene3D(host: HTMLElement): Scene3D {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(host.clientWidth, host.clientHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0e14);
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 1.1);
  key.position.set(1200, 1800, 1400);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  scene.add(key);
  scene.add(new THREE.DirectionalLight(0x88aaff, 0.35));

  const camera = new THREE.PerspectiveCamera(45, host.clientWidth / host.clientHeight, 1, 20000);
  camera.position.set(1800, 1400, 2200);
  camera.lookAt(0, 200, 0);

  const group = new THREE.Group();
  scene.add(group);

  // 轨道控制器（轻量自实现，避免额外依赖）
  const target = new THREE.Vector3(0, 200, 0);
  let azimuth = -0.8, elevation = 0.5, distance = 3200;
  let dragging = false, px = 0, py = 0;
  const onDown = (e: MouseEvent): void => { dragging = true; px = e.clientX; py = e.clientY; };
  const onMove = (e: MouseEvent): void => {
    if (!dragging) return;
    azimuth -= (e.clientX - px) * 0.006;
    elevation = Math.max(0.08, Math.min(1.45, elevation - (e.clientY - py) * 0.006));
    px = e.clientX; py = e.clientY;
  };
  const onUp = (): void => { dragging = false; };
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    distance = Math.max(600, Math.min(8000, distance * (1 + Math.sign(e.deltaY) * 0.1)));
  };
  renderer.domElement.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  renderer.domElement.addEventListener('wheel', onWheel, { passive: false });

  let raf = 0;
  const render = (): void => {
    camera.position.set(
      target.x + distance * Math.cos(elevation) * Math.cos(azimuth),
      target.y + distance * Math.sin(elevation),
      target.z + distance * Math.cos(elevation) * Math.sin(azimuth),
    );
    camera.lookAt(target);
    renderer.render(scene, camera);
    raf = requestAnimationFrame(render);
  };
  render();

  const onResize = (): void => {
    camera.aspect = host.clientWidth / host.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(host.clientWidth, host.clientHeight);
  };
  const ro = new ResizeObserver(onResize);
  ro.observe(host);

  return {
    renderer, scene, camera, group,
    setMatrix: (obj, m) => obj.matrix.fromArray(m),
    dispose: (): void => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      renderer.domElement.removeEventListener('wheel', onWheel);
      renderer.dispose();
      host.removeChild(renderer.domElement);
    },
  };
}

/** OBB 工件实体 → three.js 网格 */
export function buildWorkpieceMeshes(solids: PartSolid[]): THREE.Group {
  const g = new THREE.Group();
  for (const s of solids) {
    const geo = new THREE.BoxGeometry(s.size.x, s.size.y, s.size.z);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x4a5a6e, metalness: 0.6, roughness: 0.45,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(s.center.x, s.center.y, s.center.z);
    mesh.rotation.set(
      (s.rpyDeg.x * Math.PI) / 180,
      (s.rpyDeg.y * Math.PI) / 180,
      (s.rpyDeg.z * Math.PI) / 180,
    );
    mesh.castShadow = mesh.receiveShadow = true;
    g.add(mesh);
  }
  return g;
}

/** 关节连杆胶囊/方管机器人模型，按 6 关节角更新 */
export function buildRobotModel(dh: { a: number; d: number; alpha: number }[]): {
  root: THREE.Group;
  update: (joints: number[], toolLen: number) => void;
  frames: THREE.Group[];
} {
  const root = new THREE.Group();
  const frames: THREE.Group[] = [];
  const linkMat = new THREE.MeshStandardMaterial({ color: 0xd8862c, metalness: 0.5, roughness: 0.4 });
  const jointMat = new THREE.MeshStandardMaterial({ color: 0x2c3e57, metalness: 0.7, roughness: 0.3 });

  let parent: THREE.Object3D = root;
  for (let i = 0; i < 6; i++) {
    const frame = new THREE.Group();
    frame.matrixAutoUpdate = false;
    // 连杆可视化（沿 z 或 x 的简化圆柱）
    const linkLen = Math.max(Math.abs(dh[i].a), Math.abs(dh[i].d), 60);
    const cyl = new THREE.Mesh(new THREE.CylinderGeometry(40, 46, linkLen, 12), linkMat);
    cyl.position.y = linkLen / 2;
    const joint = new THREE.Mesh(new THREE.SphereGeometry(62, 16, 16), jointMat);
    frame.add(cyl, joint);
    parent.add(frame);
    frames.push(frame);
    parent = frame;
  }
  // 焊枪
  const torch = new THREE.Mesh(
    new THREE.CylinderGeometry(14, 20, 320, 12),
    new THREE.MeshStandardMaterial({ color: 0x888e96, metalness: 0.8, roughness: 0.25 }),
  );
  torch.position.y = 160;
  parent.add(torch);

  return {
    root, frames,
    update: (joints: number[], _toolLen: number): void => {
      let T: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      for (let i = 0; i < 6; i++) {
        const p = dh[i];
        const ca = Math.cos(p.alpha), sa = Math.sin(p.alpha);
        const ct = Math.cos(joints[i]), st = Math.sin(joints[i]);
        const Ti: Mat4 = [
          ct, st, 0, 0,
          -st * ca, ct * ca, sa, 0,
          st * sa, -ct * sa, ca, 0,
          p.a, -p.d * sa, p.d * ca, 1,
        ];
        T = multiply4(T, Ti);
        frames[i].matrix.fromArray(T);
        frames[i].matrixWorldNeedsUpdate = true;
      }
    },
  };
}

function multiply4(a: Mat4, b: Mat4): Mat4 {
  const out = new Array(16).fill(0) as Mat4;
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    out[c * 4 + r] =
      a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return out;
}

/**
 * 焊道扫掠网格：沿焊缝路径扫掠椭圆截面。
 * 鱼鳞纹按摆动频率/焊速调制表面半径。
 */
export function buildBeadSweep(
  path: Vec3[],
  bead: PlannedBead,
  opts: { ripples?: boolean; progress?: number } = {},
): THREE.Mesh {
  const nPath = Math.max(8, path.length);
  const nRing = 14;
  const w = bead.beadWidth / 2;
  const h = bead.beadHeight / 2;
  const positions: number[] = [];
  const indices: number[] = [];
  const rippleLambda = bead.weaveFreq > 0 && opts.ripples
    ? bead.travelSpeed / bead.weaveFreq // 一个摆动周期的长度 mm
    : 0;
  const upto = opts.progress === undefined ? 1 : opts.progress;

  for (let i = 0; i < nPath; i++) {
    const t = i / (nPath - 1);
    if (t > upto) break;
    const p = path[Math.min(path.length - 1, Math.round(t * (path.length - 1)))];
    let mod = 1;
    if (rippleLambda > 0) {
      const s = t * path.length * 4;
      mod = 1 + 0.06 * Math.sin((s * Math.PI * 2) / Math.max(rippleLambda, 1));
    }
    for (let j = 0; j < nRing; j++) {
      const ang = (j / nRing) * Math.PI * 2;
      // 截面椭圆，下半圆收进母材
      const ex = Math.cos(ang) * w * mod;
      const ey = Math.sin(ang) * h * mod;
      positions.push(p.x + ex, p.y + ey, p.z);
    }
  }
  const rings = positions.length / (nRing * 3);
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < nRing; j++) {
      const a = i * nRing + j;
      const b = i * nRing + (j + 1) % nRing;
      const c = (i + 1) * nRing + j;
      const d = (i + 1) * nRing + (j + 1) % nRing;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    color: bead.role === 'cap' ? 0xf0a93b : 0xc1452e,
    metalness: 0.35, roughness: 0.55,
    side: THREE.DoubleSide,
  });
  return new THREE.Mesh(geo, mat);
}

export function vec3FromMat(m: Mat4): Vec3 { return getTranslation(m); }
