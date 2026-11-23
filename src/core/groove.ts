// ============================================================
// 坡口截面建模:按接头/坡口形式生成填充型腔多边形(含余高)
// 截面局部坐标:x 横向(板宽方向),y 厚度方向,根部在 y=0,向上填充
// 型腔 = 需熔敷金属区域(钝边以下不计,根部间隙计入)
// ============================================================

import type { GrooveParams, Vec2 } from './types';
import { norm2, polygonAreaAbs, sub2 } from './geom2d';

export interface GrooveGeometry {
  /** 完整填充型腔多边形(坡口+根部间隙+余高),逆时针 */
  cavity: Vec2[];
  /** 不含余高的坡口本体多边形 */
  grooveBody: Vec2[];
  /** 余高区域多边形 */
  reinforcementPoly: Vec2[];
  /** 型腔顶部开口宽度(用于盖面排布) */
  topWidth: number;
  /** 坡口总深度(根面到板面) */
  depth: number;
  /** 左右侧壁在顶部的点 */
  topLeft: Vec2;
  topRight: Vec2;
  /** 左右壁方向(从根指向顶,单位向量) */
  leftWallDir: Vec2;
  rightWallDir: Vec2;
  /** 根部两个角点 */
  rootLeft: Vec2;
  rootRight: Vec2;
  /** 壁面线段集合(碰撞/熔合判定用) */
  walls: { a: Vec2; b: Vec2; side: 'left' | 'right' | 'bottom' | 'top' }[];
  /** 板件轮廓(用于 3D,两块板) */
  plates: { name: string; polygon: Vec2[] }[];
}

/**
 * 构建坡口几何。
 * 约定:
 *  - singleV: bevelAngle 为单边角度(与垂直面夹角),两侧对称
 *  - doubleV: 上下两个 V,上部角度 bevelAngle,下部取 0.8 倍,rootFace 为中间钝边
 *  - singleBevel(T 型单边): 仅一侧开坡,bevelAngle 为该边与垂直面夹角
 *  - square: 直边,型腔即间隙矩形+余高
 *  - fillet: 角焊缝,型腔为三角形焊脚区+微凸余高
 */
export function buildGroove(g: GrooveParams): GrooveGeometry {
  switch (g.type) {
    case 'singleV':
      return buildV(g, false);
    case 'doubleV':
      return buildV(g, true);
    case 'singleBevel':
      return buildBevel(g);
    case 'fillet':
      return buildFillet(g);
    case 'square':
    default:
      return buildSquare(g);
  }
}

function buildSquare(g: GrooveParams): GrooveGeometry {
  const T = g.plateThickness;
  const gap = g.rootGap;
  const h = g.reinforcement;
  const rootLeft = { x: -gap / 2, y: 0 };
  const rootRight = { x: gap / 2, y: 0 };
  const topLeft = { x: -gap / 2, y: T };
  const topRight = { x: gap / 2, y: T };
  const crown = { x: 0, y: T + h };
  const cavity = [rootLeft, rootRight, topRight, crown, topLeft];
  const grooveBody = [rootLeft, rootRight, topRight, topLeft];
  const reinforcementPoly = [topLeft, topRight, crown];
  const walls = [
    { a: rootLeft, b: topLeft, side: 'left' as const },
    { a: rootRight, b: topRight, side: 'right' as const },
    { a: rootLeft, b: rootRight, side: 'bottom' as const },
  ];
  return pack(g, cavity, grooveBody, reinforcementPoly, gap, T, topLeft, topRight, rootLeft, rootRight, walls, 'square');
}

function buildV(g: GrooveParams, both: boolean): GrooveGeometry {
  const T = g.plateThickness;
  const gap = g.rootGap;
  const p = g.rootFace;
  const h = g.reinforcement;
  const alpha = (g.bevelAngle * Math.PI) / 180; // 单边角
  const depth = T - p;
  const topHalf = gap / 2 + depth * Math.tan(alpha);
  const rootLeft = { x: -gap / 2, y: 0 };
  const rootRight = { x: gap / 2, y: 0 };
  const topLeft = { x: -topHalf, y: T };
  const topRight = { x: topHalf, y: T };
  const crown = { x: 0, y: T + h };

  let cavity: Vec2[];
  let grooveBody: Vec2[];
  const walls: GrooveGeometry['walls'] = [];

  if (!both) {
    // 钝边区竖直(0~rootFace),其上为斜面(rootFace~T)
    const faceLeft = { x: -gap / 2, y: p };
    const faceRight = { x: gap / 2, y: p };
    grooveBody = [rootLeft, rootRight, faceRight, topRight, topLeft, faceLeft];
    cavity = [rootLeft, rootRight, faceRight, topRight, crown, topLeft, faceLeft];
    walls.push(
      { a: rootLeft, b: faceLeft, side: 'left' },
      { a: faceLeft, b: topLeft, side: 'left' },
      { a: rootRight, b: faceRight, side: 'right' },
      { a: faceRight, b: topRight, side: 'right' },
      { a: rootLeft, b: rootRight, side: 'bottom' },
    );
  } else {
    // 双 V:下侧深度 0.35T,角度 0.8α;中间钝边 p
    const dLow = Math.min(T * 0.35, (T - p) / 2);
    const dHigh = T - p - dLow;
    const aLow = alpha * 0.8;
    const midY = dLow;
    const midHalf = gap / 2 + dLow * Math.tan(aLow);
    const neckHalf = gap / 2;
    const lowL = { x: -midHalf, y: 0 };
    const lowR = { x: midHalf, y: 0 };
    const midL = { x: -neckHalf, y: midY };
    const midR = { x: neckHalf, y: midY };
    const hiL = { x: -(gap / 2 + dHigh * Math.tan(alpha)), y: T };
    const hiR = { x: gap / 2 + dHigh * Math.tan(alpha), y: T };
    grooveBody = [lowL, lowR, midR, hiR, hiL, midL];
    cavity = [lowL, lowR, midR, hiR, crown, hiL, midL];
    const walls: GrooveGeometry['walls'] = [];
    walls.push(
      { a: lowL, b: midL, side: 'left' as const },
      { a: midL, b: hiL, side: 'left' as const },
      { a: lowR, b: midR, side: 'right' as const },
      { a: midR, b: hiR, side: 'right' as const },
      { a: lowL, b: lowR, side: 'bottom' as const },
    );
    return {
      ...pack(g, cavity, grooveBody, [hiL, hiR, crown], hiR.x - hiL.x, T, hiL, hiR, lowL, lowR, walls, 'doubleV'),
    };
  }

  return pack(g, cavity, grooveBody, [topLeft, topRight, crown], topHalf * 2, T, topLeft, topRight, rootLeft, rootRight, walls, both ? 'doubleV' : 'singleV');
}

function buildBevel(g: GrooveParams): GrooveGeometry {
  // T 型/单边:左壁竖直,右壁开坡
  const T = g.plateThickness;
  const gap = g.rootGap;
  const p = g.rootFace;
  const h = g.reinforcement;
  const alpha = (g.bevelAngle * Math.PI) / 180;
  const depth = T - p;
  const rootLeft = { x: -gap / 2, y: 0 };
  const rootRight = { x: gap / 2, y: 0 };
  const faceLeft = { x: -gap / 2, y: p };
  const topLeft = { x: -gap / 2, y: T };
  const topRight = { x: gap / 2 + depth * Math.tan(alpha), y: T };
  const crown = { x: (topLeft.x + topRight.x) / 2, y: T + h };
  const grooveBody: Vec2[] = [rootLeft, rootRight, topRight, topLeft, faceLeft];
  const cavity = [rootLeft, rootRight, topRight, crown, topLeft, faceLeft];
  const walls = [
    { a: rootLeft, b: faceLeft, side: 'left' as const },
    { a: faceLeft, b: topLeft, side: 'left' as const },
    { a: rootRight, b: topRight, side: 'right' as const },
    { a: rootLeft, b: rootRight, side: 'bottom' as const },
  ];
  return pack(g, cavity, grooveBody, [topLeft, topRight, crown], topRight.x - topLeft.x, T, topLeft, topRight, rootLeft, rootRight, walls, 'singleBevel');
}

function buildFillet(g: GrooveParams): GrooveGeometry {
  // 角焊缝:竖直壁沿 +x 面、水平壁沿 +y 面,根部原点,焊脚 K
  const K = g.legSize;
  const h = g.reinforcement;
  const rootLeft = { x: 0, y: 0 };
  const rootRight = { x: K, y: 0 };
  const topLeft = { x: 0, y: K };
  // 微凸弧面:中点外凸 h
  const mid = { x: K * 0.5 + h * 0.45, y: K * 0.5 + h * 0.45 };
  const cavity = [rootLeft, rootRight, mid, topLeft];
  const grooveBody = [rootLeft, rootRight, { x: K * 0.5, y: K * 0.5 }, topLeft];
  const reinforcementPoly = [rootRight, mid, { x: K * 0.5, y: K * 0.5 }];
  const walls: GrooveGeometry['walls'] = [
    { a: rootLeft, b: topLeft, side: 'left' },
    { a: rootLeft, b: rootRight, side: 'bottom' },
  ];
  const geom: GrooveGeometry = {
    cavity,
    grooveBody,
    reinforcementPoly,
    topWidth: K,
    depth: K,
    topLeft,
    topRight: rootRight,
    leftWallDir: { x: 0, y: 1 },
    rightWallDir: { x: 1, y: 0 },
    rootLeft,
    rootRight,
    walls,
    plates: [
      { name: '竖板', polygon: [{ x: -g.plateThickness, y: -2 }, { x: 0, y: -2 }, { x: 0, y: K * 2.2 }, { x: -g.plateThickness, y: K * 2.2 }] },
      { name: '横板', polygon: [{ x: -2, y: -g.plateThickness }, { x: K * 2.2, y: -g.plateThickness }, { x: K * 2.2, y: 0 }, { x: -2, y: 0 }] },
    ],
  };
  return geom;
}

function pack(
  g: GrooveParams,
  cavity: Vec2[],
  grooveBody: Vec2[],
  reinforcementPoly: Vec2[],
  topWidth: number,
  depth: number,
  topLeft: Vec2,
  topRight: Vec2,
  rootLeft: Vec2,
  rootRight: Vec2,
  walls: GrooveGeometry['walls'],
  _kind: string,
): GrooveGeometry {
  const T = g.plateThickness;
  const lw = norm2(sub2(topLeft, rootLeft));
  const rw = norm2(sub2(topRight, rootRight));
  const plates = [
    {
      name: '左板',
      polygon: [
        { x: topLeft.x - T * 0.9, y: -2 },
        { x: rootLeft.x, y: -2 },
        { x: rootLeft.x, y: 0 },
        topLeft,
        { x: topLeft.x - T * 0.9, y: g.plateThickness + 2 },
      ],
    },
    {
      name: '右板',
      polygon: [
        { x: rootRight.x, y: -2 },
        { x: topRight.x + T * 0.9, y: -2 },
        { x: topRight.x + T * 0.9, y: g.plateThickness + 2 },
        topRight,
        { x: rootRight.x, y: 0 },
      ],
    },
  ];
  return {
    cavity,
    grooveBody,
    reinforcementPoly,
    topWidth,
    depth,
    topLeft,
    topRight,
    leftWallDir: lw,
    rightWallDir: rw,
    rootLeft,
    rootRight,
    walls,
    plates,
  };
}
/** 型腔面积(目标熔敷面积)与余高面积 */
export function grooveAreas(geom: GrooveGeometry): { target: number; body: number; reinforcement: number } {
  return {
    target: polygonAreaAbs(geom.cavity),
    body: polygonAreaAbs(geom.grooveBody),
    reinforcement: polygonAreaAbs(geom.reinforcementPoly),
  };
}
