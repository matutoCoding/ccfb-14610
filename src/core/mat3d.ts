// 轻量 3D 数学（齐次变换 / 旋转 / 雅可比），避免与 three.js 类型耦合，核心算法可单测
import type { Vec3 } from './types';

export type Mat4 = number[]; // 列主序 16 元素，与 THREE.Matrix4 一致

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const norm = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
export const normalize = (a: Vec3): Vec3 => {
  const n = norm(a) || 1;
  return { x: a.x / n, y: a.y / n, z: a.z / n };
};
export const dist3 = (a: Vec3, b: Vec3): number => norm(sub(a, b));

export function identity(): Mat4 {
  const m = new Array(16).fill(0);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

export function makeRotX(t: number): Mat4 {
  const c = Math.cos(t), s = Math.sin(t);
  const m = identity();
  m[5] = c; m[6] = s; m[9] = -s; m[10] = c;
  return m;
}
export function makeRotY(t: number): Mat4 {
  const c = Math.cos(t), s = Math.sin(t);
  const m = identity();
  m[0] = c; m[2] = -s; m[8] = s; m[10] = c;
  return m;
}
export function makeRotZ(t: number): Mat4 {
  const c = Math.cos(t), s = Math.sin(t);
  const m = identity();
  m[0] = c; m[1] = s; m[4] = -s; m[5] = c;
  return m;
}

export function makeTranslate(x: number, y: number, z: number): Mat4 {
  const m = identity();
  m[12] = x; m[13] = y; m[14] = z;
  return m;
}

/** 修改 DH（Craig）：i-1→i 变换，列主序存储
 *  行主序原型：
 *  [ cθ, -sθ, 0, a     ]
 *  [ sθ·cα, cθ·cα, -sα, -d·sα ]
 *  [ sθ·sα, cθ·sα,  cα,  d·cα ]
 *  [ 0, 0, 0, 1 ]
 */
export function mdhTransform(alpha: number, a: number, d: number, theta: number): Mat4 {
  const ca = Math.cos(alpha), sa = Math.sin(alpha);
  const ct = Math.cos(theta), st = Math.sin(theta);
  const R = [
    [ct, -st, 0],
    [st * ca, ct * ca, -sa],
    [st * sa, ct * sa, ca],
  ];
  const t = [a, -d * sa, d * ca];
  // 转列主序
  const m = new Array(16).fill(0);
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) m[c * 4 + r] = R[r][c];
  m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; m[15] = 1;
  return m;
}

export function getTranslation(m: Mat4): Vec3 {
  return { x: m[12], y: m[13], z: m[14] };
}

export function getRotation(m: Mat4): number[] {
  return [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
}

export function getAxis(m: Mat4, axis: 0 | 1 | 2): Vec3 {
  const c = axis * 4;
  return { x: m[c], y: m[c + 1], z: m[c + 2] };
}

/** 旋转矩阵 → ZYX 欧拉角（rad） */
export function rotToEulerZYX(m: Mat4): { rx: number; ry: number; rz: number } {
  const sy = Math.hypot(m[0], m[4]);
  const singular = sy < 1e-9;
  const ry = Math.atan2(-m[8], m[0]);
  const rx = singular ? Math.atan2(-m[9], m[5]) : Math.atan2(m[6], m[10]);
  const rz = singular ? 0 : Math.atan2(m[4], m[5]);
  return { rx, ry, rz };
}

export function orientationAngleError(current: Mat4, target: Mat4): number {
  // R_err = Rt·Rc^T 的转角，与 rotationErrorVector 同约定
  const rc = getRotation(current), rt = getRotation(target);
  let trace = 0;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += rt[i * 3 + k] * rc[j * 3 + k];
      trace += i === j ? s : 0;
    }
  }
  const cosAng = Math.max(-1, Math.min(1, (trace - 1) / 2));
  return Math.acos(cosAng);
}

/** 旋转误差向量（世界系）：ω_world 使 R_current 转到 R_target，与几何雅可比 ω 行同系 */
export function rotationErrorVector(current: Mat4, target: Mat4): Vec3 {
  const rc = getRotation(current), rt = getRotation(target);
  // R_err = Rt·Rc^T（世界系误差旋转）
  const ew: number[] = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    let s = 0;
    for (let k = 0; k < 3; k++) s += rt[i * 3 + k] * rc[j * 3 + k];
    ew[i * 3 + j] = s;
  }
  const lx = ew[7] - ew[5], ly = ew[2] - ew[6], lz = ew[3] - ew[1];
  const trace = ew[0] + ew[4] + ew[8];
  const ang = Math.acos(Math.max(-1, Math.min(1, (trace - 1) / 2)));
  const s = Math.sin(ang);
  if (s < 1e-9) return { x: 0, y: 0, z: 0 };
  return { x: ang * lx / (2 * s), y: ang * ly / (2 * s), z: ang * lz / (2 * s) };
}

/** 绕任意轴旋转 */
export function rotAroundAxis(axis: Vec3, angle: number): Mat4 {
  const u = normalize(axis);
  const c = Math.cos(angle), s = Math.sin(angle), C = 1 - c;
  const m = identity();
  m[0] = c + u.x * u.x * C;
  m[1] = u.y * u.x * C + u.z * s;
  m[2] = u.z * u.x * C - u.y * s;
  m[4] = u.x * u.y * C - u.z * s;
  m[5] = c + u.y * u.y * C;
  m[6] = u.x * u.y * C + u.x * s;
  m[8] = u.x * u.z * C + u.y * s;
  m[9] = u.y * u.z * C - u.x * s;
  m[10] = c + u.z * u.z * C;
  return m;
}

/** 由 z 轴（接近方向）和 x 轴参考构造旋转矩阵 */
export function frameFromZ(z: Vec3, xRef: Vec3): Mat4 {
  const az = normalize(z);
  let x = sub(xRef, scale(az, dot(xRef, az)));
  if (norm(x) < 1e-9) x = sub({ x: 1, y: 0, z: 0 }, scale(az, az.x));
  const ax = normalize(x);
  const ay = cross(az, ax);
  const m = identity();
  [0, 1, 2].forEach((r) => {
    m[0 * 4 + r] = ax[r === 0 ? 'x' : r === 1 ? 'y' : 'z'];
    m[1 * 4 + r] = ay[r === 0 ? 'x' : r === 1 ? 'y' : 'z'];
    m[2 * 4 + r] = az[r === 0 ? 'x' : r === 1 ? 'y' : 'z'];
  });
  return m;
}

export function toThreeMatrix(m: Mat4): { elements: number[] } {
  return { elements: m.slice() };
}
