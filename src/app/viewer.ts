// ============================================================
// three.js 三维场景:工件拉伸 / 机器人骨架 / 变位机 / 焊道 / 焊枪
// ============================================================

import * as THREE from 'three';
import type { BeadPlacement, JointAngles, PositionerAngles, Workpiece } from '../core/types';
import { forwardChain } from '../core/robot';
import type { RobotConfig, PositionerConfig } from '../core/types';
import { positionerMatrix } from '../core/robot';
import type { Mat4 } from '../core/math3d';
import { buildBeadGeometry, DEFAULT_SWEEP } from '../core/beadMesh';

function mat4ToThree(m: Mat4): THREE.Matrix4 {
  return new THREE.Matrix4().set(
    m[0], m[4], m[8], m[12],
    m[1], m[5], m[9], m[13],
    m[2], m[6], m[10], m[14],
    m[3], m[7], m[11], m[15],
  );
}

export class Scene3D {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  private raf = 0;
  private disposers: (() => void)[] = [];
  group = new THREE.Group();
  robotGroup = new THREE.Group();
  positionerGroup = new THREE.Group();
  beadGroup = new THREE.Group();

  constructor(container: HTMLElement) {
    const w = container.clientWidth || 800;
    const h = container.clientHeight || 560;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.setSize(w, h);
    this.renderer.setClearColor(0x0e131b, 1);
    container.append(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(1200, 1600, 900);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.35);
    fill.position.set(-900, 400, -800);
    this.scene.add(fill);

    this.camera = new THREE.PerspectiveCamera(45, w / h, 1, 20000);
    this.camera.position.set(1800, 1300, 2200);
    this.camera.lookAt(400, 0, 400);

    const grid = new THREE.GridHelper(4000, 40, 0x2c3a52, 0x1c2635);
    grid.position.y = -2;
    this.scene.add(grid);
    const axes = new THREE.AxesHelper(300);
    this.scene.add(axes);

    this.scene.add(this.group, this.positionerGroup, this.robotGroup, this.beadGroup);
    this.animate();

    const ro = new ResizeObserver(() => this.resize(container));
    ro.observe(container);
    this.disposers.push(() => ro.disconnect());
    this.orbit(container);
  }

  // 简易轨道控制(无额外依赖)
  private orbit(container: HTMLElement): void {
    let dragging = false;
    let px = 0;
    let py = 0;
    const sph = new THREE.Spherical().setFromVector3(
      this.camera.position.clone().sub(new THREE.Vector3(400, 0, 400)),
    );
    const target = new THREE.Vector3(400, 0, 400);
    const update = (): void => {
      sph.phi = Math.max(0.15, Math.min(Math.PI - 0.15, sph.phi));
      sph.radius = Math.max(300, Math.min(9000, sph.radius));
      this.camera.position.setFromSpherical(sph).add(target);
      this.camera.lookAt(target);
    };
    const down = (e: PointerEvent): void => {
      dragging = true;
      px = e.clientX;
      py = e.clientY;
      container.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent): void => {
      if (!dragging) return;
      sph.theta -= (e.clientX - px) * 0.006;
      sph.phi -= (e.clientY - py) * 0.006;
      px = e.clientX;
      py = e.clientY;
      update();
    };
    const up = (): void => {
      dragging = false;
    };
    const wheel = (e: WheelEvent): void => {
      e.preventDefault();
      sph.radius *= 1 + Math.sign(e.deltaY) * 0.1;
      update();
    };
    container.addEventListener('pointerdown', down);
    container.addEventListener('pointermove', move);
    container.addEventListener('pointerup', up);
    container.addEventListener('wheel', wheel, { passive: false });
    this.disposers.push(() => {
      container.removeEventListener('pointerdown', down);
      container.removeEventListener('pointermove', move);
      container.removeEventListener('pointerup', up);
      container.removeEventListener('wheel', wheel);
    });
  }

  resize(container: HTMLElement): void {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  private animate = (): void => {
    this.raf = requestAnimationFrame(this.animate);
    this.renderer.render(this.scene, this.camera);
  };

  clearGroup(g: THREE.Group): void {
    g.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        const m = o.material;
        if (Array.isArray(m)) m.forEach((x) => x.dispose());
        else m.dispose();
      }
    });
    g.clear();
  }

  /** 工件:截面多边形沿 z 拉伸 */
  showWorkpiece(wp: Workpiece): void {
    this.clearGroup(this.group);
    const shape = new THREE.Shape();
    wp.outline.forEach((p, i) => (i === 0 ? shape.moveTo(p.x, p.y) : shape.lineTo(p.x, p.y)));
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, { depth: wp.extrudeLength, bevelEnabled: false });
    geo.rotateY(Math.PI / 2); // 拉伸方向 → z
    geo.translate(0, 0, 0);
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ color: 0x3b4c66, metalness: 0.55, roughness: 0.5, transparent: true, opacity: 0.92 }),
    );
    // ExtrudeGeometry 沿 +z;旋转使工件 z 与世界 z 对齐(x 截面保持)
    mesh.rotation.y = -Math.PI / 2;
    this.group.add(mesh);
    // 焊缝标记
    for (const s of wp.seams) {
      const a = new THREE.Vector3(...s.start);
      const b = new THREE.Vector3(...s.end);
      const lineGeo = new THREE.BufferGeometry().setFromPoints([a, b]);
      const line = new THREE.Line(
        lineGeo,
        new THREE.LineDashedMaterial({ color: 0xffb74d, dashSize: 18, gapSize: 10, linewidth: 2 }),
      );
      line.computeLineDistances();
      this.group.add(line);
    }
  }

  /** 变位机台面 */
  showPositioner(cfg: PositionerConfig, ang: PositionerAngles): void {
    this.clearGroup(this.positionerGroup);
    const root = new THREE.Group();
    root.matrixAutoUpdate = false;
    root.matrix.copy(mat4ToThree(positionerMatrix(cfg, ang)));
    const table = new THREE.Mesh(
      new THREE.CylinderGeometry(cfg.tableRadius, cfg.tableRadius, 40, 40),
      new THREE.MeshStandardMaterial({ color: 0x455a78, metalness: 0.6, roughness: 0.4 }),
    );
    table.rotation.x = Math.PI / 2;
    root.add(table);
    const stand = new THREE.Mesh(
      new THREE.BoxGeometry(120, 260, 120),
      new THREE.MeshStandardMaterial({ color: 0x2e3c52 }),
    );
    stand.position.y = -160;
    root.add(stand);
    this.positionerGroup.add(root);
  }

  /** 机器人骨架:连杆圆柱 + 关节球 */
  showRobot(cfg: RobotConfig, joints: JointAngles): void {
    this.clearGroup(this.robotGroup);
    const chain = forwardChain(cfg, joints);
    const pts = chain.map((m) => new THREE.Vector3(m[12], m[13], m[14]));
    const linkMat = new THREE.MeshStandardMaterial({ color: 0xdfe7f2, metalness: 0.5, roughness: 0.35 });
    const jointMat = new THREE.MeshStandardMaterial({ color: 0xff8f40, metalness: 0.4, roughness: 0.4 });
    for (let i = 0; i < pts.length - 1; i++) {
      this.robotGroup.add(cylinderBetween(pts[i], pts[i + 1], i === pts.length - 2 ? 14 : 26, linkMat));
    }
    for (const p of pts) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(22, 20, 20), jointMat);
      s.position.copy(p);
      this.robotGroup.add(s);
    }
  }

  /** 焊枪(TCP 处,沿工具 -Z 画枪体) */
  showTorch(tcpMat: Mat4): void {
    const old = this.robotGroup.getObjectByName('torch');
    if (old) this.robotGroup.remove(old);
    const g = new THREE.Group();
    g.name = 'torch';
    g.matrixAutoUpdate = false;
    g.matrix.copy(mat4ToThree(tcpMat));
    const nozzle = new THREE.Mesh(
      new THREE.CylinderGeometry(12, 18, 120, 20),
      new THREE.MeshStandardMaterial({ color: 0x9fd0ff, metalness: 0.7, roughness: 0.25 }),
    );
    // 圆柱默认沿 y;枪体沿工具 -Z
    nozzle.rotation.x = Math.PI / 2;
    nozzle.position.z = -65;
    const wire = new THREE.Mesh(
      new THREE.CylinderGeometry(2, 2, 24, 10),
      new THREE.MeshStandardMaterial({ color: 0xffd54f, metalness: 0.8, roughness: 0.3 }),
    );
    wire.rotation.x = Math.PI / 2;
    wire.position.z = 8;
    g.add(nozzle, wire);
    this.robotGroup.add(g);
  }

  /** 焊道:沿焊缝 z 方向扫掠,逐道显示(到 passLimit 为止) */
  showBeads(beads: BeadPlacement[], seamStart: [number, number, number], seamEnd: [number, number, number], passLimit?: number): void {
    this.clearGroup(this.beadGroup);
    const dir = new THREE.Vector3(seamEnd[0] - seamStart[0], seamEnd[1] - seamStart[1], seamEnd[2] - seamStart[2]);
    const len = dir.length();
    dir.normalize();
    const frameX = new THREE.Vector3(1, 0, 0);
    const frameY = new THREE.Vector3(0, 1, 0);
    const n = passLimit === undefined ? beads.length : Math.min(passLimit + 1, beads.length);
    for (let i = 0; i < n; i++) {
      const b = beads[i];
      const start = new THREE.Vector3(seamStart[0] + b.center.x, seamStart[1] + b.center.y, seamStart[2]);
      const path: THREE.Vector3[] = [];
      const steps = 24;
      for (let k = 0; k <= steps; k++) {
        path.push(start.clone().addScaledVector(dir, (len * k) / steps));
      }
      const geo = buildBeadGeometry(b, path, frameX, frameY, { ...DEFAULT_SWEEP, lengthSegments: 40, ripple: b.wps.weaveFrequency > 0.1 });
      const color = new THREE.Color(beadColorHex(b));
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({ color, metalness: 0.65, roughness: 0.38 }),
      );
      this.beadGroup.add(mesh);
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.disposers.forEach((d) => d());
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

function beadColorHex(b: BeadPlacement): number {
  if (b.role === 'root') return 0xff7043;
  if (b.role === 'cap') return 0x7e9cff;
  const palette = [0xe8a33d, 0xe07b39, 0xd95f43, 0xc94752, 0x9c3d8a, 0x5b6ee1, 0x3d9ae0, 0x37b89a];
  return palette[b.layer % palette.length];
}

function cylinderBetween(a: THREE.Vector3, b: THREE.Vector3, radius: number, mat: THREE.Material): THREE.Mesh {
  const len = a.distanceTo(b);
  const geo = new THREE.CylinderGeometry(radius, radius, Math.max(1, len), 16);
  const mesh = new THREE.Mesh(geo, mat);
  const mid = a.clone().add(b).multiplyScalar(0.5);
  mesh.position.copy(mid);
  const up = new THREE.Vector3(0, 1, 0);
  const d = b.clone().sub(a).normalize();
  mesh.quaternion.setFromUnitVectors(up, d);
  return mesh;
}
