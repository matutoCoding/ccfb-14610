import type { Vec3 } from './types';
import { frameFromZ, identity, makeRotX, makeRotY, multiply, type Mat4 } from './mat3d';

/**
 * 双轴 L 型变位机：轴1（回转，绕世界 Z）+ 轴2（翻转，绕轴1后的 Y）。
 * 工件装夹面中心相对轴2交点有固定偏置。
 */
export interface PositionerConfig {
  baseOffset: Vec3;
  plateOffset: Vec3; // 轴2交点 → 装夹面中心
  j1Min: number; j1Max: number; // rad
  j2Min: number; j2Max: number;
}

export const DEFAULT_POSITIONER: PositionerConfig = {
  baseOffset: { x: 1400, y: 0, z: 600 },
  plateOffset: { x: 0, y: 0, z: 120 },
  j1Min: -Math.PI, j1Max: Math.PI,
  j2Min: -Math.PI / 2, j2Max: Math.PI / 2,
};

export function positionerFK(j1: number, j2: number, cfg: PositionerConfig = DEFAULT_POSITIONER): Mat4 {
  let T = identity();
  T = multiply(T, { ...identity(), 12: cfg.baseOffset.x, 13: cfg.baseOffset.y, 14: cfg.baseOffset.z });
  T = multiply(T, makeRotY(j1)); // 回转轴
  T = multiply(T, makeRotX(j2)); // 翻转轴（随动后绕本地 X）
  T = multiply(T, { ...identity(), 12: cfg.plateOffset.x, 13: cfg.plateOffset.y, 14: cfg.plateOffset.z });
  return T;
}

export interface CoordGoal {
  point: Vec3;        // 焊缝点（工件系）
  tangent: Vec3;      // 焊缝走向
  normal: Vec3;       // 坡口法向（焊缝截面“朝上”方向）
}

export interface CoordSolution {
  j1: number; j2: number;
  posture: 'flat' | 'ship' | 'tilted';
  tiltDeg: number;             // 坡口法向与世界 Z 的夹角
  worldPoint: Vec3;
  worldNormal: Vec3;
  worldTangent: Vec3;
  warnings: string[];
}

const deg = (r: number) => (r * 180) / Math.PI;

function rotVec(m: Mat4, v: Vec3): Vec3 {
  return {
    x: m[0] * v.x + m[4] * v.y + m[8] * v.z,
    y: m[1] * v.x + m[5] * v.y + m[9] * v.z,
    z: m[2] * v.x + m[6] * v.y + m[10] * v.z,
  };
}
function transVec(m: Mat4, v: Vec3): Vec3 {
  return {
    x: m[0] * v.x + m[4] * v.y + m[8] * v.z + m[12],
    y: m[1] * v.x + m[5] * v.y + m[9] * v.z + m[13],
    z: m[2] * v.x + m[6] * v.y + m[10] * v.z + m[14],
  };
}

/**
 * 协调求解：在变位机限位内搜索 (j1,j2)，使焊缝点坡口法向尽量对齐世界 +Z（平焊）。
 * 角接/船形焊目标为法向偏 45°（船形），由 targetTiltDeg 指定。
 * 网格搜索 + 局部细化，确定性、可复现。
 */
export function solveCoordination(
  goal: CoordGoal,
  targetTiltDeg = 0,
  cfg: PositionerConfig = DEFAULT_POSITIONER,
): CoordSolution {
  const targetTilt = (targetTiltDeg * Math.PI) / 180;
  const holder: { best: CoordSolution | null } = { best: null };
  let bestCost = Infinity;
  const warnings: string[] = [];

  const evaluate = (j1: number, j2: number): number => {
    const T = positionerFK(j1, j2, cfg);
    const n = rotVec(T, goal.normal);
    const t = rotVec(T, goal.tangent);
    const p = transVec(T, goal.point);
    const tilt = Math.acos(Math.max(-1, Math.min(1, n.z / Math.hypot(n.x, n.y, n.z))));
    // 主目标：法向倾角偏差；次目标：焊缝走向尽量水平（便于机器人侧挂）
    const horiz = Math.abs(t.z / Math.hypot(t.x, t.y, t.z));
    const cost = Math.abs(tilt - targetTilt) + 0.25 * horiz;
    if (cost < bestCost) {
      bestCost = cost;
      holder.best = {
        j1, j2,
        posture: tilt < 0.12 ? 'flat' : tilt < 0.9 ? 'ship' : 'tilted',
        tiltDeg: deg(tilt), worldPoint: p, worldNormal: n, worldTangent: t, warnings: [],
      };
    }
    return cost;
  };

  // 粗网格 24×16
  const N1 = 24, N2 = 16;
  for (let i = 0; i <= N1; i++) {
    const j1 = cfg.j1Min + (cfg.j1Max - cfg.j1Min) * (i / N1);
    for (let k = 0; k <= N2; k++) {
      const j2 = cfg.j2Min + (cfg.j2Max - cfg.j2Min) * (k / N2);
      evaluate(j1, j2);
    }
  }
  // 细化三轮
  let span1 = (cfg.j1Max - cfg.j1Min) / N1, span2 = (cfg.j2Max - cfg.j2Min) / N2;
  for (let pass = 0; pass < 3 && holder.best; pass++) {
    const c1 = holder.best.j1, c2 = holder.best.j2;
    span1 /= 4; span2 /= 4;
    for (let i = -4; i <= 4; i++) for (let k = -4; k <= 4; k++) {
      const j1 = c1 + i * span1, j2 = c2 + k * span2;
      if (j1 >= cfg.j1Min && j1 <= cfg.j1Max && j2 >= cfg.j2Min && j2 <= cfg.j2Max) evaluate(j1, j2);
    }
  }

  const best = holder.best;
  if (!best) throw new Error('变位机协调求解失败');
  if (best.tiltDeg > 15) warnings.push(`无法达到目标平焊位姿，实际倾角 ${best.tiltDeg.toFixed(1)}°（受变位机限位约束）`);
  best.warnings = warnings;
  return best;
}

/** 由世界系焊缝点 + 焊枪工作角/行走角构造 TCP 目标位姿 */
export function torchTargetFrame(
  point: Vec3, tangent: Vec3, normal: Vec3,
  workAngleDeg: number, travelAngleDeg: number,
  standoff: number,
): Mat4 {
  // 焊枪接近方向：在法向/切向平面内由工作角、行走角偏转
  const t = norm3(tangent);
  const n = norm3(normal);
  const side = norm3(cross3(n, t)); // 截面横向
  const wa = (workAngleDeg - 90) * Math.PI / 180; // 90°= 垂直
  const ta = (travelAngleDeg * Math.PI) / 180;
  const approach = norm3({
    x: n.x * Math.cos(wa) * Math.cos(ta) + side.x * Math.sin(wa) - t.x * Math.sin(ta),
    y: n.y * Math.cos(wa) * Math.cos(ta) + side.y * Math.sin(wa) - t.y * Math.sin(ta),
    z: n.z * Math.cos(wa) * Math.cos(ta) + side.z * Math.sin(wa) - t.z * Math.sin(ta),
  });
  const tcp: Vec3 = {
    x: point.x + approach.x * standoff,
    y: point.y + approach.y * standoff,
    z: point.z + approach.z * standoff,
  };
  const R = frameFromZ(approach, t);
  return multiply(
    { ...identity(), 12: tcp.x, 13: tcp.y, 14: tcp.z },
    R,
  );
}

const norm3 = (v: Vec3): Vec3 => {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
};
const cross3 = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x,
});
