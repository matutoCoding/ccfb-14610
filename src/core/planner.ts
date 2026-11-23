// ============================================================
// 多层多道排道引擎(面积定量模型)
//  1) 单道熔敷面积由送丝体积流/焊速守恒得到
//  2) 自底向上分层:根焊→填充→盖面
//  3) 每层按该处型腔宽度与焊道有效宽度(含搭接率)定道数
//  4) 面积闭合:统一半径微调 + 末道按剩余面积反解,保证 ±3%
//  5) 输出每道中心、半径、焊丝指向偏移/倾角、角色
// 物料约定:名义熔敷面积 A 道(重熔搭接为冶金过程,不重复扣面积,
//          闭合以 ΣA道 = A型腔 为准,与工厂工艺卡口径一致)
// ============================================================

import type { BeadPlacement, GrooveParams, SegmentPlan, Vec2, WpsParams } from './types';
import { dist2, lerp2, norm2, pointInPolygon, signedDistanceToPolygon, sub2, v2 } from './geom2d';
import { buildGroove, grooveAreas, type GrooveGeometry } from './groove';

export interface PlannerOptions {
  /** 目标搭接率(相邻焊道重叠占直径比例),常用 0.4~0.6 */
  overlapRate: number;
  /** 根焊道相对理论半径的系数 */
  rootRadiusFactor: number;
  /** 盖面降焊速系数(越小焊道越宽) */
  capTravelFactor: number;
  /** 层厚相对焊道直径的系数(0.7~0.85) */
  layerThicknessFactor: number;
  /** 面积闭合目标误差,% */
  areaErrorTargetPct: number;
}

export const DEFAULT_PLANNER_OPTIONS: PlannerOptions = {
  overlapRate: 0.45,
  rootRadiusFactor: 0.95,
  capTravelFactor: 0.85,
  layerThicknessFactor: 0.78,
  areaErrorTargetPct: 3,
};

/** 单道熔敷金属截面积 mm²:送丝体积流(含熔敷效率)/ 焊速 */
export function beadArea(wps: WpsParams): number {
  const wireArea = Math.PI * (wps.wireDiameter / 2) ** 2;
  const feedMmS = (wps.wireFeedSpeed * 1000) / 60;
  return (wireArea * feedMmS * wps.depositionEfficiency) / wps.travelSpeed;
}
export function beadRadius(wps: WpsParams): number {
  return Math.sqrt(beadArea(wps) / Math.PI);
}

/** 焊道有效排布宽度(摆动增宽,限制 1.0~1.6 倍直径) */
export function effectiveWidth(wps: WpsParams, r: number): number {
  const weaveBonus = Math.min(0.6, wps.weaveWidth / (r * 4));
  return r * 2 * (1 + weaveBonus);
}

export interface PlanResult {
  segment: SegmentPlan;
  geom: GrooveGeometry;
  closure: { iterations: number; finalScale: number; note: string };
}

/** 对单个截面(给定间隙)排道 */
export function planSegment(
  groove: GrooveParams,
  wps: WpsParams,
  opts: PlannerOptions,
  segIndex: number,
  t0: number,
  t1: number,
): PlanResult {
  const geom = buildGroove(groove);
  const areas = grooveAreas(geom);
  const targetArea = areas.target;

  const baseArea = beadArea(wps);
  const baseR = Math.sqrt(baseArea / Math.PI);
  const capWps: WpsParams = { ...wps, travelSpeed: Math.max(0.5, wps.travelSpeed * opts.capTravelFactor) };
  const capR = beadRadius(capWps);

  const beads: BeadPlacement[] = [];
  let layer = 0;
  let pass = 0;

  // ---------- 1. 根焊(打底):1 道 ----------
  const rootR = baseR * opts.rootRadiusFactor;
  const rootCenter: Vec2 = {
    x: (geom.rootLeft.x + geom.rootRight.x) / 2,
    y: geom.rootLeft.y + rootR * 0.9,
  };
  beads.push(makeBead(layer, pass++, 0, rootCenter, rootR, wps, 'root'));
  layer++;

  // ---------- 2. 填充层 ----------
  const fillPitch = effectiveWidth(wps, baseR) * (1 - opts.overlapRate);
  const layerStep = baseR * 2 * opts.layerThicknessFactor;
  let yCursor = rootCenter.y + layerStep;
  const topY = geom.topLeft.y;
  const capBandY = topY - capR * 1.05;

  let guard = 0;
  while (yCursor < capBandY && guard++ < 200) {
    const span = spanAtY(geom, yCursor, baseR);
    if (span) {
      const count = Math.max(1, Math.round((span.xRight - span.xLeft) / fillPitch));
      const pitch = count === 1 ? 0 : (span.xRight - span.xLeft) / (count - 1);
      for (let i = 0; i < count; i++) {
        const x = count === 1 ? (span.xLeft + span.xRight) / 2 : span.xLeft + i * pitch;
        const center = settleInCavity(v2(x, yCursor), baseR, geom);
        beads.push(makeBead(layer, pass, i, center, baseR, wps, 'fill'));
        pass++;
      }
      layer++;
    }
    yCursor += layerStep;
  }

  // ---------- 3. 盖面层 ----------
  const capPitch = effectiveWidth(capWps, capR) * (1 - opts.overlapRate);
  const capY = topY + capR * 0.35;
  const capHalf = geom.topWidth / 2 - capR * 0.25;
  const capCount = Math.max(1, Math.round((capHalf * 2) / capPitch));
  const capPitchReal = capCount === 1 ? 0 : (capHalf * 2) / (capCount - 1);
  for (let i = 0; i < capCount; i++) {
    const x = capCount === 1 ? 0 : -capHalf + i * capPitchReal;
    beads.push(makeBead(layer, pass, i, v2(x, capY), capR, capWps, 'cap'));
    pass++;
  }

  // ---------- 4. 面积闭合 ----------
  const closure = closeArea(beads, targetArea, opts);

  // ---------- 5. 焊丝指向/熔深/冠高 ----------
  finalizeAim(beads, geom);

  const plannedArea = beads.reduce((s, b) => s + b.area, 0);
  const segment: SegmentPlan = {
    index: segIndex,
    t0,
    t1,
    gap: groove.rootGap,
    targetArea,
    plannedArea,
    areaErrorPct: ((plannedArea - targetArea) / targetArea) * 100,
    layerCount: layer + 1,
    passCount: beads.length,
    beads,
    cavity: geom.cavity,
    reinforcementArea: areas.reinforcement,
  };
  return { segment, geom, closure };
}

/** 高度 y 处型腔的内部横向区间(取包含 x=0 的一段,兼容双 V 凹多边形) */
function spanAtY(geom: GrooveGeometry, y: number, r: number): { xLeft: number; xRight: number } | null {
  const xs: number[] = [];
  const c = geom.cavity;
  for (let i = 0; i < c.length; i++) {
    const a = c[i];
    const b = c[(i + 1) % c.length];
    if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
      xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
  }
  if (xs.length < 2) return null;
  xs.sort((p, q) => p - q);
  // 配对成交区间,找包含 0 的那段
  for (let i = 0; i + 1 < xs.length; i += 2) {
    if (0 >= xs[i] && 0 <= xs[i + 1]) {
      return { xLeft: xs[i] + r * 0.15, xRight: xs[i + 1] - r * 0.15 };
    }
  }
  return { xLeft: xs[0] + r * 0.15, xRight: xs[xs.length - 1] - r * 0.15 };
}

/** 圆心若太靠近壁面,向内微移,保证大部分圆在型腔内 */
function settleInCavity(center: Vec2, r: number, geom: GrooveGeometry): Vec2 {
  let c = center;
  const sd = signedDistanceToPolygon(c, geom.cavity);
  if (sd > -r * 0.7) {
    const poly = geom.cavity;
    const centroid = poly.reduce((acc, p) => ({ x: acc.x + p.x / poly.length, y: acc.y + p.y / poly.length }), { x: 0, y: 0 });
    const dir = norm2(sub2(centroid, c));
    c = { x: c.x + dir.x * (r * 0.3), y: c.y + dir.y * (r * 0.3) };
  }
  return pointInPolygon(c, geom.cavity) ? c : center;
}

/**
 * 面积闭合(硬指标 ±3%)
 *  阶段1:全部非根焊道半径二分微调(±15%),面积按 r² 变化
 *  阶段2:反解最后一道半径吸收全部残差(允许 ±30%)
 */
function closeArea(beads: BeadPlacement[], target: number, opts: PlannerOptions): PlanResult['closure'] {
  const total = () => beads.reduce((s, b) => s + b.area, 0);
  let scale = 1;
  let lo = 0.85;
  let hi = 1.15;
  let iterations = 0;

  for (iterations = 0; iterations < 8; iterations++) {
    const mid = (lo + hi) / 2;
    const factor = mid / scale;
    for (const b of beads) {
      if (b.role === 'root') continue;
      b.radius *= factor;
      b.width = b.radius * 2;
      b.area = Math.PI * b.radius * b.radius;
    }
    scale = mid;
    const err = Math.abs(((total() - target) / target) * 100);
    if (err <= opts.areaErrorTargetPct) return { iterations, finalScale: scale, note: '整体半径微调收敛' };
    if (total() < target) lo = mid;
    else hi = mid;
  }

  // 阶段2:末道反解
  const last = beads[beads.length - 1];
  const others = beads.slice(0, -1).reduce((s, b) => s + b.area, 0);
  const need = target - others;
  if (last && need > 0) {
    const rSolve = Math.sqrt(need / Math.PI);
    last.radius = Math.max(last.radius * 0.7, Math.min(last.radius * 1.3, rSolve));
    last.width = last.radius * 2;
    last.area = Math.PI * last.radius * last.radius;
  }
  const err2 = Math.abs(((total() - target) / target) * 100);
  return {
    iterations,
    finalScale: scale,
    note: err2 <= opts.areaErrorTargetPct ? '末道反解收敛' : `残差 ${err2.toFixed(2)}%,请调整搭接率/焊速`,
  };
}

/** 每道焊丝指向:最近壁方向 → 工作角/指向偏移;熔深/冠高按角色 */
function finalizeAim(beads: BeadPlacement[], geom: GrooveGeometry): void {
  for (const b of beads) {
    let best: { point: Vec2; dist: number } | null = null;
    for (const w of geom.walls) {
      const d = segDist(b.center, w.a, w.b);
      if (!best || d.dist < best.dist) best = d;
    }
    if (best) {
      const dir = norm2(sub2(best.point, b.center));
      b.aimOffset = { x: dir.x * b.radius * 0.35, y: dir.y * b.radius * 0.35 };
      b.aimAngle = Math.round((Math.atan2(dir.x, dir.y) * 180) / Math.PI * 10) / 10;
    }
    b.penetration = b.radius * 0.32 + (b.role === 'root' ? b.radius * 0.25 : 0);
    b.crownHeight = b.role === 'cap' ? b.radius * 0.55 : b.radius * 0.18;
    b.width = b.radius * 2;
    b.area = Math.PI * b.radius * b.radius;
  }
}

function segDist(p: Vec2, a: Vec2, b: Vec2): { point: Vec2; dist: number } {
  const ab = sub2(b, a);
  const l2 = ab.x * ab.x + ab.y * ab.y;
  let t = l2 < 1e-12 ? 0 : ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / l2;
  t = Math.max(0, Math.min(1, t));
  const q = lerp2(a, b, t);
  return { point: q, dist: dist2(p, q) };
}

function makeBead(
  layer: number,
  pass: number,
  passInLayer: number,
  center: Vec2,
  radius: number,
  wps: WpsParams,
  role: BeadPlacement['role'],
): BeadPlacement {
  return {
    layer,
    pass,
    passInLayer,
    center,
    radius,
    crownHeight: radius * 0.2,
    penetration: radius * 0.32,
    width: radius * 2,
    area: Math.PI * radius * radius,
    aimAngle: 0,
    aimOffset: { x: 0, y: 0 },
    wps,
    role,
  };
}

// ============================================================
// 整条焊缝分段排道(变间隙)
// ============================================================

export function planSeam(
  groove: GrooveParams,
  wps: WpsParams,
  gapProfile: { t: number; gap: number }[],
  opts: PlannerOptions = DEFAULT_PLANNER_OPTIONS,
  segmentCount = 8,
): PlanResult[] {
  const results: PlanResult[] = [];
  const n = Math.max(1, segmentCount);
  for (let i = 0; i < n; i++) {
    const t0 = i / n;
    const t1 = (i + 1) / n;
    const gap = sampleGap(gapProfile, (t0 + t1) / 2, groove.rootGap);
    results.push(planSegment({ ...groove, rootGap: gap }, wps, opts, i, t0, t1));
  }
  return results;
}

export function sampleGap(profile: { t: number; gap: number }[], t: number, fallback: number): number {
  if (!profile || profile.length === 0) return fallback;
  const sorted = [...profile].sort((a, b) => a.t - b.t);
  if (t <= sorted[0].t) return sorted[0].gap;
  if (t >= sorted[sorted.length - 1].t) return sorted[sorted.length - 1].gap;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (t >= a.t && t <= b.t) return a.gap + (b.gap - a.gap) * ((t - a.t) / (b.t - a.t || 1));
  }
  return fallback;
}

/** 汇总:熔敷体积/燃弧工时/焊丝长度/平均热输入/最大面积误差 */
export function summarizePlan(segments: SegmentPlan[], seamLength: number, wps: WpsParams) {
  const totalPasses = segments.reduce((m, s) => Math.max(m, s.passCount), 0);
  let volume = 0;
  let weldTime = 0;
  for (const s of segments) {
    const segLen = (s.t1 - s.t0) * seamLength;
    for (const b of s.beads) {
      volume += b.area * segLen;
      weldTime += segLen / b.wps.travelSpeed;
    }
  }
  const wireArea = Math.PI * (wps.wireDiameter / 2) ** 2;
  const heatInput = (wps.arcEfficiency * wps.current * wps.voltage) / (wps.travelSpeed * 1000);
  return {
    totalPasses,
    totalDepositionVolume: volume,
    totalWeldTime: weldTime,
    totalWireLength: volume / wps.depositionEfficiency / wireArea / 1000,
    totalHeatInput: heatInput,
    maxAreaErrorPct: Math.max(...segments.map((s) => Math.abs(s.areaErrorPct))),
  };
}
