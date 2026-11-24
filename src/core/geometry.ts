import type { Vec2 } from './types';

export const deg2rad = (d: number): number => (d * Math.PI) / 180;
export const rad2deg = (r: number): number => (r * 180) / Math.PI;
export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export function polygonArea(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i];
    const pj = poly[j];
    if (pi.y > p.y !== pj.y > p.y && p.x < ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y) + pi.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** 水平切片：返回 y 高度处多边形内部的 [xLeft, xRight] 区间（可能多段） */
export function horizontalSlice(poly: Vec2[], y: number): Array<[number, number]> {
  const xs: number[] = [];
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
      xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
  }
  xs.sort((u, v) => u - v);
  const out: Array<[number, number]> = [];
  for (let i = 0; i + 1 < xs.length; i += 2) out.push([xs[i], xs[i + 1]]);
  return out;
}

export function polygonBounds(poly: Vec2[]): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of poly) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  return { minX, maxX, minY, maxY };
}

export function dist2(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x, dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function dist(a: Vec2, b: Vec2): number { return Math.sqrt(dist2(a, b)); }

/** 点到线段距离，返回距离与最近点 */
export function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): { d: number; closest: Vec2 } {
  const vx = b.x - a.x, vy = b.y - a.y;
  const wx = p.x - a.x, wy = p.y - a.y;
  const len2 = vx * vx + vy * vy;
  let t = len2 > 0 ? (wx * vx + wy * vy) / len2 : 0;
  t = clamp(t, 0, 1);
  const closest = { x: a.x + t * vx, y: a.y + t * vy };
  return { d: dist(p, closest), closest };
}

/** 两圆相交，返回交点（0~2 个） */
export function circleIntersections(c1: Vec2, r1: number, c2: Vec2, r2: number): Vec2[] {
  const d = dist(c1, c2);
  if (d > r1 + r2 + 1e-9 || d < Math.abs(r1 - r2) - 1e-9 || d < 1e-12) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h2 = r1 * r1 - a * a;
  const h = Math.sqrt(Math.max(0, h2));
  const ux = (c2.x - c1.x) / d, uy = (c2.y - c1.y) / d;
  const mx = c1.x + a * ux, my = c1.y + a * uy;
  return [
    { x: mx + h * -uy, y: my + h * ux },
    { x: mx - h * -uy, y: my - h * ux },
  ];
}

/** 线段交点 */
export function segmentIntersection(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): Vec2 | null {
  const d = (a2.x - a1.x) * (b2.y - b1.y) - (a2.y - a1.y) * (b2.x - b1.x);
  if (Math.abs(d) < 1e-12) return null;
  const t = ((b1.x - a1.x) * (b2.y - b1.y) - (b1.y - a1.y) * (b2.x - b1.x)) / d;
  const u = ((b1.x - a1.x) * (a2.y - a1.y) - (b1.y - a1.y) * (a2.x - a1.x)) / d;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return { x: a1.x + t * (a2.x - a1.x), y: a1.y + t * (a2.y - a1.y) };
}

/** 圆（焊道近似）与多边形边的最短距离 */
export function circlePolygonDistance(c: Vec2, r: number, poly: Vec2[]): { d: number; edge: [Vec2, Vec2]; closest: Vec2 } {
  let best = { d: Infinity, edge: [poly[0], poly[1]] as [Vec2, Vec2], closest: poly[0] };
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const r2 = pointSegmentDistance(c, a, b);
    if (r2.d < best.d) best = { d: r2.d, edge: [a, b], closest: r2.closest };
  }
  return best;
}

export function offsetPolyline(poly: Vec2[], dist_: number): Vec2[] {
  // 简单法线偏移（折线，不做自相交处理），用于已焊焊道占位近似
  return poly.map((p, i) => {
    const a = poly[Math.max(0, i - 1)];
    const b = poly[Math.min(poly.length - 1, i + 1)];
    const tx = b.x - a.x, ty = b.y - a.y;
    const len = Math.hypot(tx, ty) || 1;
    return { x: p.x + (-ty / len) * dist_, y: p.y + (tx / len) * dist_ };
  });
}
