import type { GrooveParams, Vec2 } from './types';
import { clamp, horizontalSlice, polygonArea } from './geometry';

export interface GrooveSection {
  fill: Vec2[];              // 待焊填充区域多边形（含余高）
  plates: Vec2[];            // 母材合并多边形（2D 示意/碰撞用，可能凹）
  sidewalls: Sidewall[];     // 熔合侧壁
  topY: number;              // 母材上表面高度
  bottomY: number;
  widthAtTop: number;
  requiredArea: number;      // 需求面积 mm²（含余高）
  rootGap: number;
  capSpan: number;           // 盖面宽
}

export interface Sidewall {
  id: string;
  side: 'left' | 'right' | 'bottom' | 'fillet-v' | 'fillet-h';
  a: Vec2;
  b: Vec2;
  angleDeg: number; // 相对水平的倾角
}

/** 余高抛物线弧：从左端 xL 到右端 xR，中点鼓出高度 h，返回左→右有序点 */
const capArc = (xL: number, xR: number, yBase: number, h: number, n = 16): Vec2[] => {
  const mid = (xL + xR) / 2;
  const half = (xR - xL) / 2;
  const pts: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = xL + (xR - xL) * t;
    const u = (x - mid) / half; // -1(左) → 1(右)
    pts.push({ x, y: yBase + h * (1 - u * u) });
  }
  return pts;
};

export function buildGrooveSection(p: GrooveParams, gapOverride?: number): GrooveSection {
  const g = gapOverride ?? p.rootGap;
  switch (p.kind) {
    case 'V': return buildV(p, g);
    case 'X': return buildX(p, g);
    case 'U': return buildU(p, g);
    case 'fillet': return buildFillet(p, g);
  }
}

function buildV(p: GrooveParams, g: number): GrooveSection {
  const { thickness: t, grooveAngleDeg, rootFace: rf, reinforcement: h } = p;
  const halfG = g / 2;
  const tanA = Math.tan((grooveAngleDeg * Math.PI) / 180);
  const halfW = halfG + (t - rf) * tanA;
  // 逆时针环：左下根 → 右下根 → 右壁顶 → 余高弧(右端→左端，反向) → 左壁顶闭合
  // capArc 给出左→右，这里取反得到右→左
  const arcLtoR = capArc(-halfW, halfW, t, h);
  const arcRtoL = arcLtoR.slice().reverse();
  const fill: Vec2[] = [
    { x: -halfG, y: 0 },
    { x: halfG, y: 0 },
    { x: halfW, y: t },
    ...arcRtoL.slice(1), // 右端点与右壁顶重合，跳过
  ];
  const plates: Vec2[] = [
    { x: -halfG, y: 0 }, { x: -halfG - 40, y: 0 }, { x: -halfG - 40, y: t + 30 },
    { x: -halfW, y: t }, { x: -halfG, y: rf },
    { x: halfG, y: rf }, { x: halfW, y: t },
    { x: halfW + 40, y: t + 30 }, { x: halfG + 40, y: 0 }, { x: halfG, y: 0 },
  ];
  const sidewalls: Sidewall[] = [
    { id: 'sw-L', side: 'left', a: { x: -halfG, y: rf }, b: { x: -halfW, y: t }, angleDeg: 90 - grooveAngleDeg },
    { id: 'sw-R', side: 'right', a: { x: halfW, y: t }, b: { x: halfG, y: rf }, angleDeg: -(90 - grooveAngleDeg) },
    { id: 'sw-B', side: 'bottom', a: { x: -halfG, y: 0 }, b: { x: halfG, y: 0 }, angleDeg: 0 },
  ];
  return finalize(fill, plates, sidewalls, t, 0, 2 * halfW, g);
}

function buildX(p: GrooveParams, g: number): GrooveSection {
  const { thickness: t, grooveAngleDeg, rootFace: rf, reinforcement: h } = p;
  const halfG = g / 2;
  const tanA = Math.tan((grooveAngleDeg * Math.PI) / 180);
  const yMidLo = (t - rf) / 2, yMidHi = (t + rf) / 2;
  const halfW = halfG + (t - rf) / 2 * tanA;
  const arcRtoL = capArc(-halfW, halfW, t, h).slice().reverse();
  const fill: Vec2[] = [
    { x: -halfG, y: yMidLo }, { x: -halfG, y: yMidHi },
    { x: -halfW, y: t }, ...arcRtoL.slice(1),
    { x: halfG, y: yMidHi },
    { x: halfG, y: yMidLo }, { x: halfW, y: 0 },
    { x: -halfW, y: 0 },
  ];
  const plates: Vec2[] = [
    { x: -halfG, y: yMidLo }, { x: -halfW - 40, y: 0 }, { x: -halfW - 40, y: -30 },
    { x: halfW + 40, y: -30 }, { x: halfW + 40, y: 0 }, { x: halfW, y: 0 },
    { x: halfG, y: yMidLo }, { x: halfG, y: yMidHi }, { x: halfW, y: t },
    { x: halfW + 40, y: t + 30 }, { x: -halfW - 40, y: t + 30 },
    { x: -halfW, y: t }, { x: -halfG, y: yMidHi },
  ];
  const sidewalls: Sidewall[] = [
    { id: 'sw-LU', side: 'left', a: { x: -halfG, y: yMidHi }, b: { x: -halfW, y: t }, angleDeg: 90 - grooveAngleDeg },
    { id: 'sw-RU', side: 'right', a: { x: halfW, y: t }, b: { x: halfG, y: yMidHi }, angleDeg: -(90 - grooveAngleDeg) },
    { id: 'sw-LL', side: 'left', a: { x: -halfW, y: 0 }, b: { x: -halfG, y: yMidLo }, angleDeg: 90 + grooveAngleDeg },
    { id: 'sw-RL', side: 'right', a: { x: halfG, y: yMidLo }, b: { x: halfW, y: 0 }, angleDeg: -(90 + grooveAngleDeg) },
  ];
  return finalize(fill, plates, sidewalls, t, 0, 2 * halfW, g);
}

function buildU(p: GrooveParams, g: number): GrooveSection {
  const { thickness: t, rootFace: rf, uRadius: R, reinforcement: h } = p;
  const halfG = g / 2;
  const nArc = 12;
  const fill: Vec2[] = [{ x: -halfG, y: 0 }, { x: halfG, y: 0 }, { x: halfG, y: rf }];
  for (let i = 1; i <= nArc; i++) {
    const phi = (i / nArc) * (Math.PI / 2);
    fill.push({ x: halfG + R * Math.sin(phi), y: rf + R * (1 - Math.cos(phi)) });
  }
  const halfW = halfG + R;
  const yTop = rf + R;
  fill.push({ x: halfW, y: t });
  fill.push(...capArc(-halfW, halfW, t, h).slice().reverse().slice(1));
  for (let i = nArc; i >= 1; i--) {
    const phi = (i / nArc) * (Math.PI / 2);
    fill.push({ x: -halfG - R * Math.sin(phi), y: rf + R * (1 - Math.cos(phi)) });
  }
  fill.push({ x: -halfG, y: rf });
  const plates: Vec2[] = [
    { x: -halfG, y: 0 }, { x: -halfG - 40, y: 0 }, { x: -halfG - 40, y: t + 30 },
    { x: -halfW, y: t }, { x: -halfW, y: yTop }, { x: -halfG, y: rf },
    { x: halfG, y: rf }, { x: halfW, y: yTop }, { x: halfW, y: t },
    { x: halfW + 40, y: t + 30 }, { x: halfG + 40, y: 0 }, { x: halfG, y: 0 },
  ];
  const sidewalls: Sidewall[] = [
    { id: 'sw-L', side: 'left', a: { x: -halfG, y: rf }, b: { x: -halfW, y: t }, angleDeg: 90 },
    { id: 'sw-R', side: 'right', a: { x: halfW, y: t }, b: { x: halfG, y: rf }, angleDeg: -90 },
    { id: 'sw-B', side: 'bottom', a: { x: -halfG, y: 0 }, b: { x: halfG, y: 0 }, angleDeg: 0 },
  ];
  return finalize(fill, plates, sidewalls, t, 0, 2 * halfW, g);
}

function buildFillet(p: GrooveParams, g: number): GrooveSection {
  // 角焊缝：立板在 x≤0，平板在 y≤0，焊区在第一象限，焊脚 L
  const L = p.legSize;
  const h = p.reinforcement;
  const halfG = g / 2;
  // 三角形区域 + 沿斜边的凸余高：斜边 x+y=L，余高沿法线向外凸 h
  const n = 16;
  const fill: Vec2[] = [{ x: -halfG, y: -halfG }, { x: L + h / Math.SQRT2, y: -halfG }];
  // 凸弧：沿斜边参数 t 从 0→1，中点法线鼓出最大
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const bx = L * (1 - t), by = L * t;           // 斜边上的点
    const bulge = h * 4 * t * (1 - t);            // 中点鼓出最大
    fill.push({ x: bx + bulge / Math.SQRT2, y: by + bulge / Math.SQRT2 });
  }
  fill.push({ x: -halfG, y: L + h / Math.SQRT2 });
  const plates: Vec2[] = [
    { x: -halfG, y: -halfG }, { x: -halfG - 40, y: -halfG },
    { x: -halfG - 40, y: L + 60 }, { x: -halfG, y: L + 60 },
    { x: -halfG, y: -halfG - 40 }, { x: L + 60, y: -halfG - 40 },
    { x: L + 60, y: -halfG }, { x: -halfG, y: -halfG },
  ];
  const sidewalls: Sidewall[] = [
    { id: 'sw-V', side: 'fillet-v', a: { x: -halfG, y: -halfG }, b: { x: -halfG, y: L }, angleDeg: 90 },
    { id: 'sw-H', side: 'fillet-h', a: { x: -halfG, y: -halfG }, b: { x: L, y: -halfG }, angleDeg: 0 },
  ];
  return finalize(fill, plates, sidewalls, L, -halfG, L, g);
}

function finalize(
  fill: Vec2[], plates: Vec2[], sidewalls: Sidewall[],
  topY: number, bottomY: number, capSpan: number, rootGap: number,
): GrooveSection {
  return {
    fill, plates, sidewalls, topY, bottomY, capSpan, rootGap,
    requiredArea: polygonArea(fill),
    widthAtTop: capSpan,
  };
}

/** 指定高度处焊区可布道宽度区间 */
export function slotAt(section: GrooveSection, y: number): Array<[number, number]> {
  return horizontalSlice(section.fill, clamp(y, section.bottomY + 1e-6, section.topY + 1e-6));
}
