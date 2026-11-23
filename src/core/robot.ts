// ============================================================
// 6R 关节机器人运动学(球形腕)+ 双轴变位机协调
// 构型:关节1 绕基座 Z;关节2/3 平行连杆平面;腕心 J5;法兰 J6
//        d1            a2      a3            d4      d6
//   J1(基) ── Z 向肩 ── J2 ── 上臂 ── J3 ── 前臂 ── 腕心 ── 法兰(TCP)
// 逆解:腕心位置解析解(8 组取最优),腕部 ZYZ 欧拉解
// ============================================================

import type { JointAngles, PositionerAngles, PositionerConfig, RobotConfig } from './types';
import {
  add,
  applyDir,
  applyMatrix,
  deg2rad,
  distance,
  eulerXYZToMatrix,
  identity,
  invert,
  matrixToEulerXYZ,
  multiply,
  norm,
  rad2deg,
  rotAxis,
  sub,
  translation,
  wrapDeg,
  type Mat4,
  type Vec3,
} from './math3d';

export interface IKResult {
  ok: boolean;
  joints: JointAngles;
  /** 全部可行解(deg) */
  candidates: JointAngles[];
  /** 逆解→正解回代后的 TCP 位置与目标偏差 mm */
  positionError: number;
  /** 姿态偏差 deg */
  orientationError: number;
  warnings: string[];
  reason?: string;
}

const J = (a: number, b: number, c: number, d: number, e: number, f: number): JointAngles => [a, b, c, d, e, f];

// ---------------- 正解 ----------------

/** 各关节坐标系相对基座的变换链(返回每个关节后系的世界矩阵) */
export function forwardChain(cfg: RobotConfig, jointsDeg: JointAngles): Mat4[] {
  const [j1, j2, j3, j4, j5, j6] = jointsDeg.map(deg2rad);
  const T: Mat4[] = [];
  // 基座→J1(绕 Z)
  let M = rotAxis('z', j1);
  T.push(M);
  // J1→J2:沿 Z 升 d1,绕 Y 转 j2(正角使臂向前下,与逆解平面约定一致)
  M = multiply(M, multiply(translation(0, 0, cfg.d1), rotAxis('y', -j2)));
  T.push(M);
  // J2→J3:沿 X 伸 a2,绕 Y 转 j3
  M = multiply(M, multiply(translation(cfg.a2, 0, 0), rotAxis('y', -j3)));
  T.push(M);
  // J3→腕心:沿 X 伸 a3,再沿 X 偏 d4(本构型 d4 并入腕偏置),绕 X 转 j4
  M = multiply(M, translation(cfg.a3 + cfg.d4, 0, 0));
  T.push(M);
  const wrist = M;
  // 腕部:j4 绕当前 X,j5 绕当前 Y,j6 绕当前 X(球形腕 ZYZ 等价 X-Y-X)
  M = multiply(M, rotAxis('x', j4));
  T.push(M);
  M = multiply(M, rotAxis('y', j5));
  T.push(M);
  M = multiply(M, rotAxis('x', j6));
  T.push(M);
  // 法兰→TCP:沿 X 伸 d6
  M = multiply(M, translation(cfg.d6, 0, 0));
  T.push(M);
  void wrist;
  return T;
}

/** 正解:TCP 位姿矩阵 */
export function forward(cfg: RobotConfig, jointsDeg: JointAngles): Mat4 {
  return forwardChain(cfg, jointsDeg).at(-1)!;
}

/** 腕心位置(正解链第 4 系的原点) */
export function wristCenter(cfg: RobotConfig, jointsDeg: JointAngles): Vec3 {
  const chain = forwardChain(cfg, jointsDeg);
  return applyMatrix(chain[3], [0, 0, 0]);
}

// ---------------- 逆解 ----------------

/**
 * 给定 TCP 位姿矩阵(基座系),求关节角。
 * 步骤:
 *  1) 腕心 Pw = Ptcp - R·(d6·X)
 *  2) J1 = atan2(Pw.y, Pw.x),取 ±180 两组(肩前/肩后)
 *  3) 平面二连杆(a2,a3+... )解 J2/J3,肘上/肘下两组
 *  4) 由 R03 与 Rtcp 求腕部 j4/j5/j6
 *  共最多 8 组,按关节行程/限位/与当前值接近度选优
 */
export function inverse(cfg: RobotConfig, target: Mat4, preferred?: JointAngles): IKResult {
  const warnings: string[] = [];
  const tcpX: Vec3 = applyDir(target, [cfg.d6, 0, 0]);
  const Pw = sub(applyMatrix(target, [0, 0, 0]), tcpX);
  const [x, y, z] = Pw;
  const reach = Math.hypot(x, y);
  const zRel = z - cfg.d1;
  const planarR = Math.hypot(reach, zRel);
  const L2 = cfg.a2;
  const L3 = cfg.a3 + cfg.d4;

  // 可达性
  const maxReach = L2 + L3;
  if (planarR > maxReach - 0.5) {
    return fail(`超出工作半径:平面半径 ${planarR.toFixed(1)} > 最大臂展 ${maxReach.toFixed(1)}`);
  }
  if (planarR < Math.abs(L2 - L3) + 0.5) {
    return fail(`过于靠近基座:平面半径 ${planarR.toFixed(1)} < 最小半径 ${Math.abs(L2 - L3).toFixed(1)}`);
  }

  const candidates: JointAngles[] = [];
  // J1 两组
  const baseAng = Math.atan2(y, x);
  const j1Set = [baseAng, wrapDeg(rad2deg(baseAng) + 180) * Math.PI / 180];

  for (const j1 of j1Set) {
    // 转到 J1 平面坐标
    const c1 = Math.cos(-j1);
    const s1 = Math.sin(-j1);
    const xr = c1 * x - s1 * y;
    const zr = zRel;
    const r = Math.hypot(xr, zr);
    // 余弦定理求肘关节
    const cosElbow = (r * r - L2 * L2 - L3 * L3) / (2 * L2 * L3);
    if (cosElbow < -1 || cosElbow > 1) continue;
    const elbowOffset = Math.acos(clamp(cosElbow, -1, 1));
    for (const elbowSign of [1, -1]) {
      // 正解腕部绕 Y 取 -j3,故逆解 j3 = -elbowSign·elbowOffset
      const j3 = -elbowSign * elbowOffset;
      // J2:基座平面俯仰角;正解取 -j2,匹配 ψ 的符号分支
      const phi = Math.atan2(zr, xr);
      const psi = Math.atan2(L3 * Math.sin(j3), L2 + L3 * Math.cos(j3));
      const j2 = phi - psi;
      // 求 R03 旋转部分(与正解同号:绕 Y 取负角)
      const R03 = multiply(
        rotAxis('z', j1),
        multiply(rotAxis('y', -j2), rotAxis('y', -j3)),
      );
      // 目标旋转部分(去掉平移,避免 solveWrist 读到位置分量)
      const Rtarget = rotationOnly(target);
      // Rwrist = R03^-1 · Rtarget(纯旋转)
      const Rwrist = multiply(invert(R03), Rtarget);
      const wrist = solveWrist(Rwrist);
      if (!wrist) continue;
      for (const w of wrist) {
        const joints = J(
          rad2deg(j1),
          rad2deg(j2),
          rad2deg(j3),
          rad2deg(w[0]),
          rad2deg(w[1]),
          rad2deg(w[2]),
        );
        candidates.push(joints);
      }
    }
  }

  if (candidates.length === 0) return fail('腕部姿态不可达(无解)');

  // 限位过滤 + 评分
  const feasible = candidates.filter((c) => withinLimits(cfg, c));
  if (feasible.length === 0) {
    return fail('存在逆解但全部超出关节限位,请调整变位机/工件安装位置');
  }
  const pool = feasible;
  warnings.push(...limitWarnings(cfg, feasible[0]));

  const scored = pool
    .map((c) => ({ c, score: scoreJoints(cfg, c, preferred) }))
    .sort((a, b) => a.score - b.score);
  const best = scored[0].c;

  // 回代校验
  const fk = forward(cfg, best);
  const posErr = distance(applyMatrix(fk, [0, 0, 0]), applyMatrix(target, [0, 0, 0]));
  const e1 = matrixToEulerXYZ(fk);
  const e2 = matrixToEulerXYZ(target);
  const oriErr =
    Math.abs(wrapDeg(rad2deg(e1[0] - e2[0]))) +
    Math.abs(wrapDeg(rad2deg(e1[1] - e2[1]))) +
    Math.abs(wrapDeg(rad2deg(e1[2] - e2[2])));

  // 奇异/限位警告
  const sw = singularityWarnings(cfg, best);
  warnings.push(...sw);
  const limitW = limitWarnings(cfg, best);
  warnings.push(...limitW);

  return {
    ok: posErr <= 0.1,
    joints: best,
    candidates,
    positionError: posErr,
    orientationError: oriErr,
    warnings,
  };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** 取矩阵的纯旋转部分(平移清零) */
function rotationOnly(m: Mat4): Mat4 {
  const r = m.slice();
  r[12] = 0;
  r[13] = 0;
  r[14] = 0;
  r[3] = 0;
  r[7] = 0;
  r[11] = 0;
  r[15] = 1;
  return r;
}

/** 球形腕 X-Y-X 角解(j4,j5,j6),R = Rx(j4)·Ry(j5)·Rx(j6) */
function solveWrist(R: Mat4): [number, number, number][] | null {
  // 列主序:r(行 i,列 j) = R[j*4+i]
  const r11 = R[0], r12 = R[4], r13 = R[8];
  const r21 = R[1], r23 = R[9];
  const r31 = R[2], r22 = R[5];
  const sb = Math.sqrt(r21 * r21 + r31 * r31); // |sin(j5)|
  if (sb < 1e-7) {
    // 奇异:j5 ≈ 0,令 j4=0,j6 由 r22/r23 解
    const j5 = r11 > 0 ? 0 : Math.PI;
    const j4 = 0;
    const j6 = Math.atan2(-r23, r22);
    return [[j4, j5, j6]];
  }
  const out: [number, number, number][] = [];
  for (const j5 of [Math.atan2(sb, r11), Math.atan2(-sb, r11)]) {
    const s = Math.sin(j5);
    // sin(j4)=r21/sb,cos(j4)=-r31/sb;sin(j6)=r12/sb,cos(j6)=r13/sb
    const j4 = Math.atan2(r21 / s, -r31 / s);
    const j6 = Math.atan2(r12 / s, r13 / s);
    out.push([j4, j5, j6]);
  }
  return out;
}

function withinLimits(cfg: RobotConfig, j: JointAngles): boolean {
  return j.every((v, i) => v >= cfg.limits[i].min && v <= cfg.limits[i].max);
}
function limitWarnings(cfg: RobotConfig, j: JointAngles): string[] {
  const out: string[] = [];
  j.forEach((v, i) => {
    const L = cfg.limits[i];
    const span = L.max - L.min;
    if (v < L.min + span * 0.05 || v > L.max - span * 0.05) {
      out.push(`J${i + 1}=${v.toFixed(1)}° 接近关节限位[${L.min},${L.max}]`);
    }
  });
  return out;
}
function singularityWarnings(cfg: RobotConfig, j: JointAngles): string[] {
  const out: string[] = [];
  // 腕奇异:J5 接近 0/180
  if (Math.abs(wrapDeg(j[4])) < cfg.singularityWristThreshold ||
      Math.abs(Math.abs(wrapDeg(j[4])) - 180) < cfg.singularityWristThreshold) {
    out.push(`腕部奇异:J5=${j[4].toFixed(1)}° 接近共轴`);
  }
  // 肘奇异:J3 接近 0(完全伸直)
  if (Math.abs(j[2]) < cfg.singularityElbowThreshold) {
    out.push(`肘部奇异:J3=${j[2].toFixed(1)}° 接近伸直`);
  }
  return out;
}
function scoreJoints(cfg: RobotConfig, j: JointAngles, preferred?: JointAngles): number {
  let s = 0;
  j.forEach((v, i) => {
    const L = cfg.limits[i];
    const mid = (L.min + L.max) / 2;
    s += Math.abs(v - mid) * 0.1;
    if (v < L.min || v > L.max) s += 1e6;
    if (preferred) s += Math.abs(wrapDeg(v - preferred[i])) * 0.5;
  });
  return s;
}
function fail(reason: string): IKResult {
  return {
    ok: false,
    joints: J(0, 0, 0, 0, 0, 0),
    candidates: [],
    positionError: Infinity,
    orientationError: Infinity,
    warnings: [reason],
    reason,
  };
}

// ---------------- 变位机 ----------------

/** 变位机双轴变换:轴1 绕 Z 回转,轴2 绕 X 倾斜(头尾架翻转) */
export function positionerMatrix(cfg: PositionerConfig, ang: PositionerAngles): Mat4 {
  const base = translation(...cfg.baseToPositioner);
  const a1 = rotAxis('z', deg2rad(ang[0]));
  const a2 = rotAxis('x', deg2rad(ang[1]));
  return multiply(base, multiply(a1, a2));
}

/**
 * 协调求解:选择变位机角度,使焊缝截面法向尽量朝上(平焊)或 45°(船形)。
 * 输入:焊缝在工件系的方向 d(沿缝)与截面法向 n(坡口朝上方向)。
 * 输出:变位机两轴角度 + 变换后在机器人基坐标系的焊缝方向/法向。
 */
export function coordinatePositioner(
  cfg: PositionerConfig,
  seamDir: Vec3,
  seamNormal: Vec3,
  mode: 'flat' | 'boat' = 'flat',
  reachRadius = 1580,
): { angles: PositionerAngles; worldDir: Vec3; worldNormal: Vec3; matrix: Mat4 } {
  // 网格搜索轴2 倾斜(±90),轴1 回转(0~360,步长 5°),评分:法向与世界 Z 对齐(平焊)
  // 船形:目标法向与 Z 夹角 45°
  let best: { angles: PositionerAngles; score: number; M: Mat4 } | null = null;
  const targetTilt = mode === 'flat' ? 0 : Math.PI / 4;
  const originR = Math.hypot(cfg.baseToPositioner[0], cfg.baseToPositioner[1]);
  const reachPenalty = originR > reachRadius * 0.92 ? (originR - reachRadius * 0.92) * 0.02 : 0;
  for (let a2deg = -90; a2deg <= 90; a2deg += 5) {
    for (let a1deg = 0; a1deg < 360; a1deg += 10) {
      const ang: PositionerAngles = [a1deg, a2deg];
      if (ang[1] < cfg.axis2Limit.min || ang[1] > cfg.axis2Limit.max) continue;
      const M = positionerMatrix(cfg, ang);
      const wn = applyDir(M, seamNormal);
      const tilt = Math.acos(clamp(wn[2] / (norm(wn) || 1), -1, 1));
      const score = Math.abs(tilt - targetTilt) + 0.002 * Math.abs(a2deg) + reachPenalty;
      if (!best || score < best.score) best = { angles: ang, score, M };
    }
  }
  const M = best!.M;
  return {
    angles: best!.angles,
    worldDir: applyDir(M, seamDir),
    worldNormal: applyDir(M, seamNormal),
    matrix: M,
  };
}

/** 工具坐标系:焊枪 Z 轴沿焊丝指向(默认 -Z 接近工件),构造 TCP 位姿 */
export function makeTCP(center: Vec3, approach: Vec3, travelDir: Vec3): Mat4 {
  // 工具 +Z 沿焊丝接近方向,+X 沿行走方向(正交化)
  const z = normalize3(approach);
  const y = cross3(z, normalize3(travelDir));
  const x = cross3(y, z);
  const m = identity();
  const cols = [x, y, z];
  for (let c = 0; c < 3; c++) {
    m[c * 4 + 0] = cols[c][0];
    m[c * 4 + 1] = cols[c][1];
    m[c * 4 + 2] = cols[c][2];
  }
  m[12] = center[0];
  m[13] = center[1];
  m[14] = center[2];
  return m;
}
function normalize3(a: Vec3): Vec3 {
  const n = norm(a);
  return n < 1e-9 ? [1, 0, 0] : [a[0] / n, a[1] / n, a[2] / n];
}
function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** 欧拉角(deg)→ 矩阵便捷封装 */
export function eulerDegMatrix(rx: number, ry: number, rz: number): Mat4 {
  return eulerXYZToMatrix(deg2rad(rx), deg2rad(ry), deg2rad(rz));
}

/** 机器人各连杆关键点(用于 3D 渲染骨架) */
export function robotKeyPoints(cfg: RobotConfig, joints: JointAngles): { name: string; p: Vec3 }[] {
  const chain = forwardChain(cfg, joints);
  const names = ['J1 基座', 'J2 肩', 'J3 肘', '腕心', 'J4', 'J5', 'J6/TCP'];
  return chain.map((m, i) => ({ name: names[i] ?? `J${i}`, p: applyMatrix(m, [0, 0, 0]) }));
}

export function addVec(a: Vec3, b: Vec3): Vec3 {
  return add(a, b);
}
