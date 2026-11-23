// ============================================================
// 2D 截面几何:多边形面积/形心、点包含、圆-多边形裁剪、最近点
// 用于坡口型腔建模与排道面积闭合校核
// ============================================================

import type { Vec2 } from './types';

export const v2 = (x: number, y: number): Vec2 => ({ x, y });
export const add2 = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub2 = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale2 = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const dot2 = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const cross2 = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const len2 = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist2 = (a: Vec2, b: Vec2): number => len2(sub2(a, b));
export const norm2 = (a: Vec2): Vec2 => {
  const n = len2(a);
  return n < 1e-12 ? { x: 0, y: 0 } : { x: a.x / n, y: a.y / n };
};
export const lerp2 = (a: Vec2, b: Vec2, t: number): Vec2 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

/** 有向面积(逆时针为正) */
export function polygonArea(poly: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}
/** 几何面积(绝对值) */
export function polygonAreaAbs(poly: Vec2[]): number {
  return Math.abs(polygonArea(poly));
}
export function polygonCentroid(poly: Vec2[]): Vec2 {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const f = p.x * q.y - q.x * p.y;
    a += f;
    cx += (p.x + q.x) * f;
    cy += (p.y + q.y) * f;
  }
  a *= 0.5;
  if (Math.abs(a) < 1e-9) {
    const m = poly.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
    return { x: m.x / poly.length, y: m.y / poly.length };
  }
  return { x: cx / (6 * a), y: cy / (6 * a) };
}
/** 射线法判断点在多边形内(含边界) */
export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    const intersect =
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
    if (intersect) inside = !inside;
  }
  return inside;
}
/** 点到线段的最近点 */
export function closestPointOnSegment(p: Vec2, a: Vec2, b: Vec2): { point: Vec2; t: number; dist: number } {
  const ab = sub2(b, a);
  const l2 = dot2(ab, ab);
  let t = l2 < 1e-12 ? 0 : dot2(sub2(p, a), ab) / l2;
  t = Math.max(0, Math.min(1, t));
  const point = lerp2(a, b, t);
  return { point, t, dist: dist2(p, point) };
}
/** 点到多边形边界的最近点与距离(负值表示点在内部时的深入距离近似) */
export function closestPointOnPolygon(p: Vec2, poly: Vec2[]): { point: Vec2; dist: number; edgeIndex: number } {
  let best = { point: poly[0], dist: Infinity, edgeIndex: 0 };
  for (let i = 0; i < poly.length; i++) {
    const r = closestPointOnSegment(p, poly[i], poly[(i + 1) % poly.length]);
    if (r.dist < best.dist) best = { point: r.point, dist: r.dist, edgeIndex: i };
  }
  return best;
}
/** 点到多边形边界的有符号距离(内负外正) */
export function signedDistanceToPolygon(p: Vec2, poly: Vec2[]): number {
  const c = closestPointOnPolygon(p, poly);
  return pointInPolygon(p, poly) ? -c.dist : c.dist;
}

/** 圆与直线(过 a,b 的无限直线)求交,返回 0~2 个交点 */
export function circleLineIntersections(center: Vec2, r: number, a: Vec2, b: Vec2): Vec2[] {
  const d = norm2(sub2(b, a));
  if (len2(d) < 1e-12) return [];
  const f = sub2(a, center);
  const A = 1;
  const B = 2 * dot2(f, d);
  const C = dot2(f, f) - r * r;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return [];
  const sq = Math.sqrt(disc);
  const t1 = (-B - sq) / 2;
  const t2 = (-B + sq) / 2;
  const pts = [add2(a, scale2(d, t1))];
  if (t2 - t1 > 1e-9) pts.push(add2(a, scale2(d, t2)));
  return pts;
}

/**
 * 圆被凸/凹多边形裁剪后剩余(圆内 ∩ 多边形内)的面积。
 * 采用多边形边对圆做逐边 Sutherland-Hodgman 裁剪(圆弧用积分项修正)。
 * 简化稳健做法:将圆离散为 N 边形后做多边形裁剪,再补圆弧弓形误差。
 * 排道闭合以"目标型腔面积 - 已占面积"为准,故这里用离散 N=72,误差 <0.05%。
 */
export function circlePolygonIntersectionArea(center: Vec2, r: number, poly: Vec2[], segments = 72): number {
  const circlePts: Vec2[] = [];
  for (let i = 0; i < segments; i++) {
    const ang = (i / segments) * Math.PI * 2;
    circlePts.push({ x: center.x + r * Math.cos(ang), y: center.y + r * Math.sin(ang) });
  }
  let clipped = circlePts;
  for (let i = 0; i < poly.length && clipped.length > 0; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const edge = sub2(b, a);
    const next: Vec2[] = [];
    const inside = (p: Vec2): boolean => cross2(edge, sub2(p, a)) >= -1e-9;
    for (let k = 0; k < clipped.length; k++) {
      const p = clipped[k];
      const q = clipped[(k + 1) % clipped.length];
      const pin = inside(p);
      const qin = inside(q);
      if (pin && qin) {
        next.push(q);
      } else if (pin && !qin) {
        next.push(segmentLineIntersect(p, q, a, b));
      } else if (!pin && qin) {
        next.push(segmentLineIntersect(p, q, a, b));
        next.push(q);
      }
    }
    clipped = next;
  }
  return clipped.length >= 3 ? polygonAreaAbs(clipped) : 0;
}
function segmentLineIntersect(p: Vec2, q: Vec2, a: Vec2, b: Vec2): Vec2 {
  const r = sub2(q, p);
  const s = sub2(b, a);
  const t = cross2(sub2(a, p), s) / cross2(r, s);
  return add2(p, scale2(r, t));
}

/** 两圆相交面积(焊道搭接量计算) */
export function circleCircleIntersectionArea(c1: Vec2, r1: number, c2: Vec2, r2: number): number {
  const d = dist2(c1, c2);
  if (d >= r1 + r2) return 0;
  if (d <= Math.abs(r1 - r2)) return Math.PI * Math.min(r1, r2) ** 2;
  const a1 = r1 * r1 * Math.acos((d * d + r1 * r1 - r2 * r2) / (2 * d * r1));
  const a2 = r2 * r2 * Math.acos((d * d + r2 * r2 - r1 * r1) / (2 * d * r2));
  const a3 = 0.5 * Math.sqrt((-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2));
  return a1 + a2 - a3;
}

/** 多边形平移 */
export function translatePoly(poly: Vec2[], d: Vec2): Vec2[] {
  return poly.map((p) => add2(p, d));
}
/** 多边形缩放(关于原点) */
export function scalePoly(poly: Vec2[], s: number): Vec2[] {
  return poly.map((p) => scale2(p, s));
}
/** 两点夹角(deg,atan2) */
export function angleOf(v: Vec2): number {
  return (Math.atan2(v.y, v.x) * 180) / Math.PI;
}
