import type { PartSolid, Vec3 } from './types';
import { dist3, type Mat4 } from './mat3d';

export interface Capsule {
  a: Vec3; b: Vec3; r: number;
}

export interface CollisionHit {
  solidId: string;
  clearance: number; // 负=穿透
  point: Vec3;
}

/** OBB（有向包围盒） */
interface OBB {
  center: Vec3;
  half: Vec3;
  axes: [Vec3, Vec3, Vec3];
  solidId: string;
}

const rotZYX = (rpy: Vec3): [Vec3, Vec3, Vec3] => {
  const [rx, ry, rz] = [rpy.x, rpy.y, rpy.z].map((d) => (d * Math.PI) / 180);
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);
  // R = Rz·Ry·Rx 列向量
  const xAxis: Vec3 = { x: cz * cy, y: sz * cy, z: -sy };
  const yAxis: Vec3 = { x: cz * sy * sx - sz * cx, y: sz * sy * sx + cz * cx, z: cy * sx };
  const zAxis: Vec3 = { x: cz * sy * cx + sz * sx, y: sz * sy * cx - cz * sx, z: cy * cx };
  return [xAxis, yAxis, zAxis];
};

export function solidsToOBBs(solids: PartSolid[]): OBB[] {
  return solids.map((s) => {
    const [ax, ay, az] = rotZYX(s.rpyDeg);
    return {
      solidId: s.id, center: s.center,
      half: { x: s.size.x / 2, y: s.size.y / 2, z: s.size.z / 2 },
      axes: [ax, ay, az],
    };
  });
}

function closestPointOBB(p: Vec3, obb: OBB): { point: Vec3; d: number } {
  const d = { x: p.x - obb.center.x, y: p.y - obb.center.y, z: p.z - obb.center.z };
  const clamped: Vec3 = { ...obb.center };
  const local = [
    d.x * obb.axes[0].x + d.y * obb.axes[0].y + d.z * obb.axes[0].z,
    d.x * obb.axes[1].x + d.y * obb.axes[1].y + d.z * obb.axes[1].z,
    d.x * obb.axes[2].x + d.y * obb.axes[2].y + d.z * obb.axes[2].z,
  ];
  const q = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const h = i === 0 ? obb.half.x : i === 1 ? obb.half.y : obb.half.z;
    q[i] = Math.max(-h, Math.min(h, local[i]));
  }
  for (let i = 0; i < 3; i++) {
    const ax = obb.axes[i];
    clamped.x += ax.x * q[i]; clamped.y += ax.y * q[i]; clamped.z += ax.z * q[i];
  }
  return { point: clamped, d: dist3(p, clamped) };
}

/** 线段（胶囊轴线）与 OBB 最近距离：沿轴线采样 + 端点投影，工程上足够保守 */
function capsuleOBBDistance(cap: Capsule, obb: OBB): { d: number; point: Vec3 } {
  const len = dist3(cap.a, cap.b);
  const steps = Math.max(4, Math.ceil(len / 20));
  let best = { d: Infinity, point: cap.a };
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p = {
      x: cap.a.x + (cap.b.x - cap.a.x) * t,
      y: cap.a.y + (cap.b.y - cap.a.y) * t,
      z: cap.a.z + (cap.b.z - cap.a.z) * t,
    };
    const r = closestPointOBB(p, obb);
    const clearance = r.d - cap.r;
    if (clearance < best.d) best = { d: clearance, point: r.point };
  }
  return best;
}

/** 焊枪（TCP→法兰方向的胶囊）与工件碰撞检测 */
export function checkTorchCollision(
  torch: Capsule, solids: PartSolid[], existingBeadCapsules: Capsule[] = [],
): CollisionHit[] {
  const obbs = solidsToOBBs(solids);
  const hits: CollisionHit[] = [];
  for (const obb of obbs) {
    const r = capsuleOBBDistance(torch, obb);
    if (r.d < 2) hits.push({ solidId: obb.solidId, clearance: r.d, point: r.point });
  }
  for (const cap of existingBeadCapsules) {
    const r = capsuleCapsule(torch, cap);
    if (r < 2) hits.push({ solidId: '已焊焊道', clearance: r, point: cap.a });
  }
  return hits;
}

function capsuleCapsule(a: Capsule, b: Capsule): number {
  // 双线段最近距离 - 两半径
  const steps = 6;
  let best = Infinity;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p = {
      x: a.a.x + (a.b.x - a.a.x) * t, y: a.a.y + (a.b.y - a.a.y) * t,
      z: a.a.z + (a.b.z - a.a.z) * t,
    };
    for (let k = 0; k <= steps; k++) {
      const u = k / steps;
      const q = {
        x: b.a.x + (b.b.x - b.a.x) * u, y: b.a.y + (b.b.y - b.a.y) * u,
        z: b.a.z + (b.b.z - b.a.z) * u,
      };
      best = Math.min(best, dist3(p, q));
    }
  }
  return best - a.r - b.r;
}

export interface AvoidResult {
  via: Vec3;              // 避让中间点（TCP 世界坐标）
  path: Vec3[];           // 起→via→终
  clearance: number;
  iterations: number;
}

/**
 * 自动避碰：沿焊枪接近反方向抬枪，再在安全高度平移，最后落枪。
 * 若直接抬升仍碰撞（筋板根部深坡口），沿截面横向 + 法向螺旋搜索最近安全点。
 */
export function avoidTorch(
  start: Vec3, end: Vec3, approach: Vec3, solids: PartSolid[],
  torchRadius: number, torchLength: number,
): AvoidResult {
  const obbs = solidsToOBBs(solids);
  const safeAt = (tcp: Vec3): number => {
    const cap: Capsule = {
      a: tcp,
      b: { x: tcp.x + approach.x * torchLength, y: tcp.y + approach.y * torchLength, z: tcp.z + approach.z * torchLength },
      r: torchRadius,
    };
    let worst = Infinity;
    for (const obb of obbs) {
      const r = capsuleOBBDistance(cap, obb);
      worst = Math.min(worst, r.d);
    }
    return worst;
  };

  let lift = 40;
  let via: Vec3 = end;
  let clearance = 0;
  let iterations = 0;
  // 逐级抬枪（最大 320mm）
  while (lift <= 320) {
    iterations++;
    via = {
      x: end.x - approach.x * lift,
      y: end.y - approach.y * lift,
      z: end.z - approach.z * lift,
    };
    clearance = safeAt(via);
    if (clearance >= 3) break;
    lift += 20;
  }

  // 抬枪仍不满足：横向搜索（在 start/end 中点高度平面内八方向）
  if (clearance < 3) {
    const base = {
      x: (start.x + via.x) / 2, y: (start.y + via.y) / 2, z: (start.z + via.z) / 2,
    };
    outer:
    for (const radius of [60, 120, 200, 300]) {
      for (let k = 0; k < 8; k++) {
        iterations++;
        const ang = (k / 8) * Math.PI * 2;
        const cand: Vec3 = {
          x: base.x + Math.cos(ang) * radius,
          y: base.y + Math.sin(ang) * radius,
          z: base.z + 30,
        };
        const c = safeAt(cand);
        if (c >= 3) { via = cand; clearance = c; break outer; }
      }
    }
  }

  // 路径：起点抬到安全高度 → 平移到 via → 落枪
  const startUp = {
    x: start.x - approach.x * Math.max(40, lift * 0.5),
    y: start.y - approach.y * Math.max(40, lift * 0.5),
    z: start.z - approach.z * Math.max(40, lift * 0.5),
  };
  return { via, path: [startUp, via, end], clearance, iterations };
}

export function frameToCapsule(worldTcp: Vec3, frame: Mat4, torchRadius: number, torchLength: number): Capsule {
  // 焊枪沿法兰 -z 方向（frame 的 z 指向焊丝伸出方向时为 +z，按约定取 +z）
  const z = { x: frame[8], y: frame[9], z: frame[10] };
  return {
    a: worldTcp,
    b: {
      x: worldTcp.x + z.x * torchLength,
      y: worldTcp.y + z.y * torchLength,
      z: worldTcp.z + z.z * torchLength,
    },
    r: torchRadius,
  };
}
