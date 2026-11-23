// ============================================================
// 轻量 3D 数学:齐次变换 / 欧拉角 / 几何工具(纯 TS,无 three 依赖)
// 矩阵为 4x4 列主序(与 three/OpenGL 一致):m[column*4 + row]
// ============================================================

export type Vec3 = [number, number, number];
export type Mat4 = number[]; // 长度 16

export const deg2rad = (d: number): number => (d * Math.PI) / 180;
export const rad2deg = (r: number): number => (r * 180) / Math.PI;

export function v3(x = 0, y = 0, z = 0): Vec3 {
  return [x, y, z];
}
export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
export function norm(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}
export function normalize(a: Vec3): Vec3 {
  const n = norm(a);
  return n < 1e-12 ? [0, 0, 0] : [a[0] / n, a[1] / n, a[2] / n];
}
export function distance(a: Vec3, b: Vec3): number {
  return norm(sub(a, b));
}
/** 角度包裹到 [-180,180] */
export function wrapDeg(a: number): number {
  let x = a % 360;
  if (x > 180) x -= 360;
  if (x < -180) x += 360;
  return x;
}
export function angleDiffDeg(a: number, b: number): number {
  return wrapDeg(a - b);
}
export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ---------------- 4x4 矩阵 ----------------

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
export function translation(x: number, y: number, z: number): Mat4 {
  const m = identity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}
export function rotAxis(axis: 'x' | 'y' | 'z', angleRad: number): Mat4 {
  const m = identity();
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  if (axis === 'x') {
    m[5] = c; m[6] = s; m[9] = -s; m[10] = c;
  } else if (axis === 'y') {
    m[0] = c; m[2] = -s; m[8] = s; m[10] = c;
  } else {
    m[0] = c; m[1] = s; m[4] = -s; m[5] = c;
  }
  return m;
}
/** three.js 欧拉 'XYZ' 顺序:R = Rx(rx)·Ry(ry)·Rz(rz) */
export function eulerXYZToMatrix(rx: number, ry: number, rz: number): Mat4 {
  return multiply(rotAxis('x', rx), multiply(rotAxis('y', ry), rotAxis('z', rz)));
}
export function applyMatrix(m: Mat4, p: Vec3): Vec3 {
  const [x, y, z] = p;
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}
export function applyDir(m: Mat4, p: Vec3): Vec3 {
  const [x, y, z] = p;
  return [
    m[0] * x + m[4] * y + m[8] * z,
    m[1] * x + m[5] * y + m[9] * z,
    m[2] * x + m[6] * y + m[10] * z,
  ];
}
export function getTranslation(m: Mat4): Vec3 {
  return [m[12], m[13], m[14]];
}
/** 从旋转矩阵提取欧拉角 [rx,ry,rz](rad),与 three.js Euler 'XYZ' 完全一致 */
export function matrixToEulerXYZ(m: Mat4): [number, number, number] {
  // 转换:three.js 行主序 te[r*4+c] = 本库列主序 m[c*4+r]
  //   te[0]=m[0] te[1]=m[4] te[2]=m[8]
  //   te[5]=m[5] te[6]=m[9] te[10]=m[10]
  const te2 = m[8];
  const clampv = Math.max(-1, Math.min(1, te2));
  if (Math.abs(clampv) < 0.9999999) {
    const x = Math.atan2(-m[9], m[10]);
    const y = Math.asin(clampv);
    const z = Math.atan2(-m[4], m[0]);
    return [x, y, z];
  }
  // 万向锁:three 源码 x=atan2(te[6],te[5])
  const x = Math.atan2(m[9], m[5]);
  return [x, Math.asin(clampv), 0];
}
/** 通用 4x4 求逆(Gauss-Jordan 列主元,按 (行,列) 访问列主序数组) */
export function invert(a: Mat4): Mat4 {
  const get = (m: Mat4, r: number, c: number): number => m[c * 4 + r];
  const set = (m: Mat4, r: number, c: number, v: number): void => {
    m[c * 4 + r] = v;
  };
  const m = a.slice();
  const inv = identity();
  for (let col = 0; col < 4; col++) {
    let pivot = col;
    for (let r = col + 1; r < 4; r++) {
      if (Math.abs(get(m, r, col)) > Math.abs(get(m, pivot, col))) pivot = r;
    }
    if (Math.abs(get(m, pivot, col)) < 1e-12) return identity();
    if (pivot !== col) {
      for (let k = 0; k < 4; k++) {
        const t1 = get(m, col, k);
        set(m, col, k, get(m, pivot, k));
        set(m, pivot, k, t1);
        const t2 = get(inv, col, k);
        set(inv, col, k, get(inv, pivot, k));
        set(inv, pivot, k, t2);
      }
    }
    const pv = get(m, col, col);
    for (let k = 0; k < 4; k++) {
      set(m, col, k, get(m, col, k) / pv);
      set(inv, col, k, get(inv, col, k) / pv);
    }
    for (let r = 0; r < 4; r++) {
      if (r === col) continue;
      const factor = get(m, r, col);
      if (factor === 0) continue;
      for (let k = 0; k < 4; k++) {
        set(m, r, k, get(m, r, k) - factor * get(m, col, k));
        set(inv, r, k, get(inv, r, k) - factor * get(inv, col, k));
      }
    }
  }
  return inv;
}
