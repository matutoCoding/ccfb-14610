import type { IKSolution, RobotLimits } from './types';
import {
  dist3, getRotation, getTranslation, identity, mdhTransform,
  multiply, orientationAngleError, rotationErrorVector, type Mat4,
} from './mat3d';
import { rad2deg } from './geometry';

/**
 * 六轴关节型焊接机器人（球形腕），修改 DH（Craig 约定）。
 * 逆解：6 自由度全位姿阻尼最小二乘（DLS），多初值 + 构型种子，
 * 对 FK 自洽，FK(IK(target)) 回差由收敛阈值保证 ≤0.1mm。
 */
export interface RobotDHParm { alpha: number; a: number; d: number }

export const ROBOT_DH: RobotDHParm[] = [
  // 标准工业 6R 球腕序列 α=[0,-90,0,-90,90,-90]，雅可比满秩
  { alpha: 0, a: 0, d: 620 },
  { alpha: -Math.PI / 2, a: 180, d: 0 },
  { alpha: 0, a: 780, d: 0 },
  { alpha: -Math.PI / 2, a: 120, d: 860 },
  { alpha: Math.PI / 2, a: 0, d: 0 },
  { alpha: -Math.PI / 2, a: 0, d: 0 },
];

export const DEFAULT_LIMITS: RobotLimits = {
  jMin: [-170, -90, -160, -180, -135, -360].map((d) => (d * Math.PI) / 180),
  jMax: [170, 110, 80, 180, 135, 360].map((d) => (d * Math.PI) / 180),
  jMaxSpeed: [2.6, 2.4, 2.6, 3.2, 3.2, 4.5],
};

export const TOOL_LENGTH = 350;
const wrapPi = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
const clampN = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

type Vec3Like = { x: number; y: number; z: number };

export function fk(joints: number[]): Mat4 {
  let T = identity();
  for (let i = 0; i < 6; i++) {
    const p = ROBOT_DH[i];
    T = multiply(T, mdhTransform(p.alpha, p.a, p.d, joints[i]));
  }
  return multiply(T, mdhTransform(0, 0, TOOL_LENGTH, 0));
}

function fkN(joints: number[]): Mat4 {
  let T = identity();
  for (let i = 0; i < 6; i++) {
    const p = ROBOT_DH[i];
    T = multiply(T, mdhTransform(p.alpha, p.a, p.d, joints[i]));
  }
  return T;
}

export interface ArmResult { joints: number[]; posErr: number; oriErr: number; converged: boolean; iterations: number }

/** 腕心目标：TCP 沿目标姿态 -z 方向退工具长度（腕心 = TCP − R·z·L） */
function wristTargetOf(target: Mat4): { wc: Vec3Like; R6: number[] } {
  const tcp = getTranslation(target);
  const z = { x: target[8], y: target[9], z: target[10] };
  const wc = {
    x: tcp.x - z.x * TOOL_LENGTH,
    y: tcp.y - z.y * TOOL_LENGTH,
    z: tcp.z - z.z * TOOL_LENGTH,
  };
  return { wc, R6: getRotation(target) };
}

function wristOfArm(q: number[]): Vec3Like {
  let M = identity();
  for (let i = 0; i < 4; i++) {
    const p = ROBOT_DH[i];
    M = multiply(M, mdhTransform(p.alpha, p.a, p.d, q[i] ?? 0));
  }
  return getTranslation(M);
}

/** 第一级：前 3 关节 DLS 收敛腕心位置（纯 mm 量纲，鲁棒） */
function solveArmPosition(wc: Vec3Like, seed: number[], limits: RobotLimits): { q: number[]; err: number; converged: boolean } {
  const q = seed.slice(0, 3);
  let lam = 0.02;
  let err = Infinity;
  for (let it = 0; it < 200; it++) {
    let M = identity();
    const origins: Vec3Like[] = [{ x: 0, y: 0, z: 0 }];
    const axes: Vec3Like[] = [];
    for (let i = 0; i < 3; i++) {
      const p = ROBOT_DH[i];
      M = multiply(M, mdhTransform(p.alpha, p.a, p.d, q[i]));
      axes.push({ x: M[8], y: M[9], z: M[10] });
      origins.push({ x: M[12], y: M[13], z: M[14] });
    }
    const pc = wristOfArm(q);
    const J: number[][] = [[], [], []];
    for (let i = 0; i < 3; i++) {
      const z = axes[i], o = origins[i];
      const dx = pc.x - o.x, dy = pc.y - o.y, dz = pc.z - o.z;
      J[0][i] = z.y * dz - z.z * dy;
      J[1][i] = z.z * dx - z.x * dz;
      J[2][i] = z.x * dy - z.y * dx;
    }
    const e = [wc.x - pc.x, wc.y - pc.y, wc.z - pc.z];
    err = Math.hypot(e[0], e[1], e[2]);
    if (err < 0.01) return { q, err, converged: true };
    const JJt = Array.from({ length: 3 }, () => new Array(3).fill(0));
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += J[r][k] * J[c][k];
      JJt[r][c] = s;
    }
    for (let r = 0; r < 3; r++) JJt[r][r] += lam * Math.max(JJt[r][r], 1e-6);
    const A = JJt.map((row, i) => [...row, e[i]]);
    for (let col = 0; col < 3; col++) {
      let piv = col;
      for (let r = col + 1; r < 3; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
      [A[col], A[piv]] = [A[piv], A[col]];
      const d = A[col][col] || 1e-12;
      for (let c = col; c < 4; c++) A[col][c] /= d;
      for (let r = 0; r < 3; r++) {
        if (r === col) continue;
        const f = A[r][col];
        for (let c = col; c < 4; c++) A[r][c] -= f * A[col][c];
      }
    }
    const y = A.map((r) => r[3]);
    const qTry = q.slice();
    for (let k = 0; k < 3; k++) {
      let s = 0;
      for (let r = 0; r < 3; r++) s += J[r][k] * y[r];
      qTry[k] = clampN(q[k] + s, limits.jMin[k] - 0.05, limits.jMax[k] + 0.05);
    }
    const newErr = dist3(wristOfArm(qTry), wc);
    if (newErr < err) { q.splice(0, 3, ...qTry); lam = Math.max(0.005, lam * 0.7); }
    else lam = Math.min(2, lam * 1.8);
    if (lam >= 1.9) break;
  }
  return { q, err, converged: err < 0.05 };
}

/** 由目标姿态在腕心系下的轴向量，估算腕部关节角初值（球腕几何闭式） */
function estimateWristSeed(qArm: number[], target: Mat4): number[] {
  let R03m = identity();
  for (let i = 0; i < 3; i++) {
    const p = ROBOT_DH[i];
    R03m = multiply(R03m, mdhTransform(p.alpha, p.a, p.d, qArm[i]));
  }
  const R03 = getRotation(R03m);
  // 目标工具 z 轴转换到腕心系（工具纯平移不改变旋转）
  const zWorld = { x: target[8], y: target[9], z: target[10] };
  const z3 = {
    x: R03[0] * zWorld.x + R03[3] * zWorld.y + R03[6] * zWorld.z,
    y: R03[1] * zWorld.x + R03[4] * zWorld.y + R03[7] * zWorld.z,
    z: R03[2] * zWorld.x + R03[5] * zWorld.y + R03[8] * zWorld.z,
  };
  // 本 DH 腕：J4 绕 z3，J5 绕变换后 y，J6 绕最终 z；用 z 轴极角估 θ5，方位角估 θ4
  const theta5 = Math.acos(clampN(z3.z, -1, 1));
  const theta4 = Math.atan2(z3.y, z3.x);
  return [theta4, theta5, 0];
}

/** 第二级：多腕部初值数值牛顿，选姿态误差最小者 */
function solveWrist(qArm: number[], target: Mat4, limits: RobotLimits): { q: number[]; oriErr: number; converged: boolean } {
  const estimated = estimateWristSeed(qArm, target);
  const wristSeeds: number[][] = [
    estimated,
    [estimated[0], -estimated[1], estimated[2] + Math.PI],
    [0, 0.7, 0], [0, -0.7, 0],
    [1.4, 0.7, 0], [-1.4, -0.7, 0],
    [0, 1.2, 1.4], [0, -1.2, -1.4],
  ];
  let best: { q: number[]; oriErr: number; converged: boolean } | null = null;
  for (const ws of wristSeeds) {
    const r = refineWrist([...qArm, ...ws], target, limits);
    if (!best || r.oriErr < best.oriErr) best = r;
    if (r.converged && r.oriErr < 0.001) return r;
  }
  return best ?? { q: [...qArm, 0, 0.7, 0], oriErr: Infinity, converged: false };
}

/** 全 6 维数值雅可比：位置误差 + 姿态误差分别对 6 关节差分，与误差严格同系 */
function fullNumericJacobian(q: number[], target: Mat4): {
  Jpos: number[][]; Jori: number[][]; ePos: number[]; eOri: number[]; posNorm: number; oriNorm: number;
} {
  const eps = 1e-6;
  const T0 = fk(q);
  const p0 = getTranslation(T0);
  const tp = getTranslation(target);
  const r0 = rotationErrorVector(T0, target);
  const ePos = [tp.x - p0.x, tp.y - p0.y, tp.z - p0.z];
  const eOri = [r0.x, r0.y, r0.z];
  const Jpos = [[0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0]];
  const Jori = [[0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0]];
  for (let k = 0; k < 6; k++) {
    const qp = q.slice();
    qp[k] += eps;
    const T1 = fk(qp);
    const p1 = getTranslation(T1);
    const r1 = rotationErrorVector(T1, target);
    for (let r = 0; r < 3; r++) {
      Jpos[r][k] = (([p1.x, p1.y, p1.z][r]) - ([p0.x, p0.y, p0.z][r])) / eps;
      Jori[r][k] = (([r1.x, r1.y, r1.z][r]) - ([r0.x, r0.y, r0.z][r])) / eps;
    }
  }
  return {
    Jpos, Jori, ePos, eOri,
    posNorm: Math.hypot(...ePos), oriNorm: Math.hypot(...eOri),
  };
}

/** 高斯消元解 n 阶线性方程组 */
function solveN(A: number[][], b: number[]): number[] {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col] || 1e-12;
    for (let c = col; c < n + 1; c++) M[col][c] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      for (let c = col; c < n + 1; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}

function refineWrist(seed: number[], target: Mat4, limits: RobotLimits): { q: number[]; oriErr: number; converged: boolean } {
  let q = seed.slice();
  let lam = 1e-4;
  for (let it = 0; it < 200; it++) {
    // 仅腕部 3 关节的数值姿态雅可比（与 rotationErrorVector 严格同系）
    const eps = 1e-6;
    const T0 = fk(q);
    const r0 = rotationErrorVector(T0, target);
    const oriNorm = Math.hypot(r0.x, r0.y, r0.z);
    const posNorm = dist3(getTranslation(T0), getTranslation(target));
    if (posNorm < 0.02 && oriNorm < 0.0015) return { q, oriErr: oriNorm, converged: true };
    const J = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let k = 0; k < 3; k++) {
      const qp = q.slice();
      qp[3 + k] += eps;
      const r1 = rotationErrorVector(fk(qp), target);
      J[0][k] = (r1.x - r0.x) / eps;
      J[1][k] = (r1.y - r0.y) / eps;
      J[2][k] = (r1.z - r0.z) / eps;
    }
    const JJ = J.map((row, r) => row.map((_, c) => {
      let s = 0;
      for (let k = 0; k < 3; k++) s += row[k] * J[c][k];
      return s + (r === c ? lam * lam : 0);
    }));
    const y = solve3(JJ, [-r0.x, -r0.y, -r0.z]);
    const dqw = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      dqw[k] = J[0][k] * y[0] + J[1][k] * y[1] + J[2][k] * y[2];
    }
    const qTry = q.slice();
    for (let k = 0; k < 3; k++) {
      qTry[3 + k] = clampN(q[3 + k] + dqw[k], limits.jMin[3 + k] - 0.05, limits.jMax[3 + k] + 0.05);
    }
    const nTry = Math.hypot(...Object.values(rotationErrorVector(fk(qTry), target)).slice(0, 3) as number[]);
    if (nTry < oriNorm) { q = qTry; lam = Math.max(1e-7, lam * 0.5); }
    else lam = Math.min(0.2, lam * 3);
    if (lam >= 0.19) break;
  }
  const final = fullNumericJacobian(q, target);
  return { q, oriErr: final.oriNorm, converged: final.posNorm < 0.1 && final.oriNorm < 0.01 };
}

function solve3(A: number[][], b: number[]): number[] {
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col] || 1e-12;
    for (let c = col; c < 4; c++) M[col][c] /= d;
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = M[r][col];
      for (let c = col; c < 4; c++) M[r][c] -= f * M[col][c];
    }
  }
  return [M[0][3], M[1][3], M[2][3]];
}

function dlsIK(target: Mat4, seed: number[], limits: RobotLimits): ArmResult {
  const { wc } = wristTargetOf(target);
  const arm = solveArmPosition(wc, seed, limits);
  if (!arm.converged) {
    const T = fk(seed);
    return {
      joints: seed,
      posErr: dist3(getTranslation(T), getTranslation(target)),
      oriErr: orientationAngleError(T, target),
      converged: false, iterations: 0,
    };
  }
  const w = solveWrist(arm.q, target, limits);
  const T = fk(w.q);
  return {
    joints: w.q,
    posErr: dist3(getTranslation(T), getTranslation(target)),
    oriErr: orientationAngleError(T, target),
    converged: w.converged, iterations: 0,
  };
}

/** 多初值逆解，返回去重后的不同构型 */
export function ikAll(target: Mat4): Array<{ joints: number[]; reachable: boolean }> {
  const out: Array<{ joints: number[]; reachable: boolean }> = [];
  const seen: string[] = [];
  const seeds = buildSeeds();
  for (const seed of seeds) {
    const r = dlsIK(target, seed, DEFAULT_LIMITS);
    if (!r.converged) continue;
    const key = r.joints.map((x) => Math.round(wrapPi(x) * 50)).join('|');
    if (seen.includes(key)) continue;
    seen.push(key);
    out.push({ joints: r.joints.map(wrapPi), reachable: true });
    if (out.length >= 8) break;
  }
  return out;
}

function buildSeeds(target?: Mat4): number[][] {
  const seeds: number[][] = [];
  // 若已知目标，按腕心方位角生成对齐的 J1 种子（显著提高收敛率）
  const j1Set = new Set<number>([0, 1.2, -1.2, 0.6, -0.6]);
  if (target) {
    const wc = wristTargetOf(target).wc;
    j1Set.add(Math.atan2(wc.y, wc.x));
  }
  for (const j1 of j1Set) {
    for (const j2 of [-0.3, 0.2, 0.5, 0.8]) {
      for (const j3 of [0.2, 0.5, 0.9, -0.6]) {
        seeds.push([j1, j2, j3, 0, 0.7, 0]);
      }
    }
  }
  return seeds;
}

/** 雅可比奇异值（供奇异点分析，使用未缩放的物理雅可比） */
export function jacobian(joints: number[]): { J: number[][]; minSigma: number; condition: number } {
  const n = 6;
  let T = identity();
  const origins: Vec3Like[] = [{ x: 0, y: 0, z: 0 }];
  const axes: Vec3Like[] = [];
  for (let i = 0; i < n; i++) {
    const p = ROBOT_DH[i];
    T = multiply(T, mdhTransform(p.alpha, p.a, p.d, joints[i]));
    axes.push({ x: T[8], y: T[9], z: T[10] });
    origins.push({ x: T[12], y: T[13], z: T[14] });
  }
  const Ttcp = multiply(T, mdhTransform(0, 0, TOOL_LENGTH, 0));
  const pc = getTranslation(Ttcp);
  const J: number[][] = Array.from({ length: 6 }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    const z = axes[i], o = origins[i];
    const dx = pc.x - o.x, dy = pc.y - o.y, dz = pc.z - o.z;
    J[0][i] = z.y * dz - z.z * dy;
    J[1][i] = z.z * dx - z.x * dz;
    J[2][i] = z.x * dy - z.y * dx;
    J[3][i] = z.x; J[4][i] = z.y; J[5][i] = z.z;
  }
  const A = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => {
      let s = 0;
      for (let k = 0; k < n; k++) s += J[k][i] * J[k][j];
      return s;
    }));
  const eigs = jacobiEigen(A).map((e) => Math.sqrt(Math.max(0, e))).sort((a, b) => b - a);
  const minSigma = Math.min(...eigs);
  const maxSigma = Math.max(...eigs);
  return { J, minSigma, condition: maxSigma / Math.max(minSigma, 1e-12) };
}

function jacobiEigen(A: number[][]): number[] {
  const n = A.length;
  const M = A.map((r) => r.slice());
  for (let iter = 0; iter < 60; iter++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += M[p][q] * M[p][q];
    if (off < 1e-20) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(M[p][q]) < 1e-14) continue;
      const tau = (M[q][q] - M[p][p]) / (2 * M[p][q]);
      const t = Math.sign(tau || 1) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
      const c = 1 / Math.sqrt(1 + t * t), s = t * c;
      for (let k = 0; k < n; k++) {
        const ap = M[k][p], aq = M[k][q];
        M[k][p] = c * ap - s * aq; M[k][q] = s * ap + c * aq;
      }
      for (let k = 0; k < n; k++) {
        const ap = M[p][k], aq = M[q][k];
        M[p][k] = c * ap - s * aq; M[q][k] = s * ap + c * aq;
      }
    }
  }
  return M.map((_, i) => M[i][i]);
}

export interface IKOptions {
  limits?: RobotLimits;
  preferred?: number[];
}

export function solveIK(target: Mat4, options: IKOptions = {}): IKSolution {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const warnings: string[] = [];

  // 优先用连续性种子（上一帧），失败再全局多初值
  let candidates: ArmResult[] = [];
  if (options.preferred) {
    const r = dlsIK(target, options.preferred, limits);
    if (r.converged) candidates.push(r);
  }
  if (!candidates.length) {
    candidates = buildSeeds(target).map((s) => dlsIK(target, s, limits)).filter((r) => r.converged);
  }

  if (!candidates.length) {
    return {
      joints: new Array(6).fill(0), reachable: false, withinLimits: false,
      limitMarginDeg: 0,
      singularity: { wristSin: 0, minSigma: 0, condition: Infinity, nearSingular: true },
      fkRoundTrip: { positionErrorMm: Infinity, orientationErrorDeg: Infinity },
      warnings: ['目标位姿超出工作空间或 DLS 逆解不收敛'],
    };
  }

  const scored = candidates.map((r) => {
    const j = r.joints.map(wrapPi);
    const margin = Math.min(...j.map((jj, i) =>
      Math.min(rad2deg(jj - limits.jMin[i]), rad2deg(limits.jMax[i] - jj))));
    const within = j.every((jj, i) => jj >= limits.jMin[i] - 1e-6 && jj <= limits.jMax[i] + 1e-6);
    const T = fk(j);
    const posErr = dist3(getTranslation(T), getTranslation(target));
    const oriErr = rad2deg(orientationAngleError(T, target));
    const continuity = options.preferred
      ? Math.sqrt(j.reduce((s, jj, i) => s + wrapPi(jj - options.preferred![i]) ** 2, 0)) : 0;
    return { j, margin, within, posErr, oriErr, score: (within ? 0 : 1e6) - margin + continuity * 3 };
  }).sort((a, b) => a.score - b.score);

  const best = scored[0];
  const { minSigma, condition } = jacobian(best.j);
  const wristSin = Math.abs(Math.sin(best.j[4]));
  const nearSingular = wristSin < 0.12 || condition > 500 || minSigma < 0.05;

  if (!best.within) warnings.push('所有候选解均存在关节越限，已选裕量最大者并标红');
  else if (best.margin < 8) warnings.push(`关节限位裕量仅 ${best.margin.toFixed(1)}°，接近硬限位`);
  if (wristSin < 0.12) warnings.push(`腕部奇异：|sin θ5|=${wristSin.toFixed(3)} < 0.12，J4/J6 易超速`);
  if (condition > 500) warnings.push(`雅可比条件数 ${condition.toFixed(0)} > 500，接近奇异点`);
  if (best.posErr > 0.1) warnings.push(`正逆解回差 ${best.posErr.toFixed(3)}mm 超 0.1mm 验收线`);

  return {
    joints: best.j, reachable: true, withinLimits: best.within,
    limitMarginDeg: best.margin,
    singularity: { wristSin, minSigma, condition, nearSingular },
    fkRoundTrip: { positionErrorMm: best.posErr, orientationErrorDeg: best.oriErr },
    warnings,
  };
}
