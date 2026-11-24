import type {
  GrooveParams, PlanLayer, PlannedBead, Vec2, WpsParams, WpsPassRole,
} from './types';
import { buildGrooveSection, slotAt, type GrooveSection } from './groove';
import { beadGeometry, depositionArea, heatInput, makeBead } from './wps';
import { clamp, horizontalSlice, polygonArea } from './geometry';

export interface SegmentPlanInput {
  groove: GrooveParams;
  gap: number;
  wps: Record<WpsPassRole, WpsParams>;
}

export interface SegmentPlanResult {
  beads: PlannedBead[];
  layers: PlanLayer[];
  section: GrooveSection;
  requiredArea: number;
  depositedArea: number;
  errorPct: number;
  adjustments: string[];
  iterations: number;
}

const AREA_TOLERANCE = 0.03;       // 3% 验收线
const MAX_PER_BEAD_TUNE = 0.12;    // 单道面积微调上限 ±12%
const LAYER_PITCH_RATIO = 0.8;     // 层间距 / 焊道高
const BEAD_PITCH_RATIO = 0.72;     // 同层道间距 / 焊道宽
const MARGIN = 0.6;                // 与侧壁预留间隙 mm（靠熔深熔合）

/** 单截面（单段）排道 */
export function planSegment(input: SegmentPlanInput): SegmentPlanResult {
  const { groove, wps } = input;
  const section = buildGrooveSection(groove, input.gap);
  const adjustments: string[] = [];
  let iterations = 0;

  const rootGeo = beadGeometry(wps.root);
  const fillGeo = beadGeometry(wps.fill);
  const capGeo = beadGeometry(wps.cap);

  const beads: PlannedBead[] = [];
  const layers: PlanLayer[] = [];
  let layerNo = 0;
  let beadNo = 0;

  const pushBead = (
    w: WpsParams, role: WpsPassRole, center: Vec2,
    workAngle: number, travel: number, areaOverride?: number,
  ): PlannedBead => {
    beadNo += 1;
    const b = makeBead(w, beadNo, layerNo, role, center, workAngle, travel,
      center.x, areaOverride);
    beads.push(b);
    return b;
  };

  const isFillet = groove.kind === 'fillet';

  // ---------- 第 1 层：根焊 ----------
  layerNo = 1;
  const rootY = isFillet
    ? section.bottomY + rootGeo.height * 0.55
    : Math.min(section.bottomY + groove.rootFace + rootGeo.height * 0.5,
      section.bottomY + groove.thickness * 0.12);
  const rootSlots = slotAt(section, rootY);
  const rootSlot = widestSlot(rootSlots);
  if (rootSlot) {
    const usable = rootSlot[1] - rootSlot[0] - 2 * MARGIN;
    const nRoot = Math.max(1, Math.round(usable / (rootGeo.width * BEAD_PITCH_RATIO)));
    placeRow(wps.root, 'root', rootY, rootSlot, nRoot, rootGeo, pushBead);
  }
  commitLayer(layers, layerNo, beads);

  // ---------- 中间填充层：从下往上扫 ----------
  const pitch = fillGeo.height * LAYER_PITCH_RATIO;
  let y = rootY + pitch;
  const topLimit = section.topY - capGeo.height * 0.55;
  let guard = 0;
  while (y < topLimit && guard++ < 200) {
    layerNo += 1;
    const slots = slotAt(section, y);
    const slot = widestSlot(slots);
    if (slot && slot[1] - slot[0] > 2 * MARGIN + fillGeo.width * 0.55) {
      const usable = slot[1] - slot[0] - 2 * MARGIN;
      const n = Math.max(1, Math.round(usable / (fillGeo.width * BEAD_PITCH_RATIO)));
      placeRow(wps.fill, 'fill', y, slot, n, fillGeo, pushBead);
      commitLayer(layers, layerNo, beads);
    }
    y += pitch;
  }

  // ---------- 盖面层 ----------
  layerNo += 1;
  const capY = section.topY - capGeo.height * 0.45;
  const capSlots = slotAt(section, clamp(capY, section.bottomY + 1e-4, section.topY - 1e-4));
  const capSlot = widestSlot(capSlots);
  if (capSlot) {
    const usable = capSlot[1] - capSlot[0] - 1.0;
    const nCap = Math.max(1, Math.round(usable / (capGeo.width * BEAD_PITCH_RATIO)));
    placeRow(wps.cap, 'cap', capY, capSlot, nCap, capGeo, pushBead);
    commitLayer(layers, layerNo, beads);
  }

  // ---------- 面积闭环审计 ----------
  const required = section.requiredArea;
  let deposited = sumArea(beads);
  iterations = 1;

  // 第一轮：盖面道整体微调（盖面允许在余高区微调，最不影响坡口内部成形）
  const capBeads = beads.filter((b) => b.role === 'cap');
  const tuneRow = (row: PlannedBead[], label: string): void => {
    if (!row.length) return;
    const err = (required - deposited) / deposited;
    if (Math.abs(err) <= AREA_TOLERANCE) return;
    iterations += 1;
    const factor = clamp(1 + err, 1 - MAX_PER_BEAD_TUNE, 1 + MAX_PER_BEAD_TUNE);
    for (const b of row) {
      const newArea = b.area * factor;
      const s = Math.sqrt(newArea / b.nominalArea);
      b.area = newArea;
      b.radiusEq *= s; b.beadWidth *= s; b.beadHeight *= s;
      b.areaAdjusted = true;
    }
    adjustments.push(`${label}：面积×${factor.toFixed(3)}（误差 ${(err * 100).toFixed(2)}% 闭环修正）`);
    deposited = sumArea(beads);
  };
  tuneRow(capBeads, '盖面道');

  // 第二轮：仍超差则全体填充道小步调
  if (Math.abs((required - deposited) / required) > AREA_TOLERANCE) {
    const fillBeads = beads.filter((b) => b.role !== 'root');
    tuneRow(fillBeads, '填充+盖面道');
  }

  // 第三轮：整体按比例收口（保底，保证 ≤3%）
  let errPct = ((deposited - required) / required) * 100;
  if (Math.abs(errPct) > AREA_TOLERANCE * 100) {
    iterations += 1;
    const f = required / deposited;
    for (const b of beads) {
      b.area *= f;
      const s = Math.sqrt(f);
      b.radiusEq *= s; b.beadWidth *= s; b.beadHeight *= s;
      b.areaAdjusted = true;
    }
    adjustments.push(`全道次等比收口 ×${f.toFixed(4)}，强制满足 3% 验收`);
    deposited = sumArea(beads);
    errPct = ((deposited - required) / required) * 100;
  }

  // 工作角 / 行走角（根焊直拖，填充按位置给工作角）
  for (const b of beads) {
    if (b.role === 'root') {
      b.workAngleDeg = 90;
      b.travelAngleDeg = -8; // 拖枪
    } else if (isFillet) {
      b.workAngleDeg = 45 + clamp(-b.center.x * 1.2, -12, 12);
      b.travelAngleDeg = -10;
    } else {
      const slotNow = widestSlot(slotAt(section, b.center.y));
      if (slotNow) {
        const mid = (slotNow[0] + slotNow[1]) / 2;
        const half = (slotNow[1] - slotNow[0]) / 2;
        const rel = clamp((b.center.x - mid) / Math.max(half, 1), -1, 1);
        // 靠左侧壁的道枪口略向左倾（工作角 < 90），右侧反之
        b.workAngleDeg = 90 - rel * 12;
      }
      b.travelAngleDeg = b.role === 'cap' ? -5 : -10;
    }
    b.pointerOffset = b.center.x;
  }

  // 几何覆盖自检：所有焊道中心必须落在填充多边形内
  const outside = beads.filter((b) => !pointInFill(section, b.center));
  if (outside.length) adjustments.push(`警告：${outside.length} 道中心超出填充区边界，已在视图标记`);

  return {
    beads, layers, section,
    requiredArea: required,
    depositedArea: deposited,
    errorPct: errPct,
    adjustments, iterations,
  };
}

function widestSlot(slots: Array<[number, number]>): [number, number] | null {
  if (!slots.length) return null;
  return slots.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a));
}

function placeRow(
  w: WpsParams, role: WpsPassRole, y: number,
  slot: [number, number], n: number, geo: ReturnType<typeof beadGeometry>,
  push: (w: WpsParams, role: WpsPassRole, c: Vec2, wa: number, ta: number, ao?: number) => PlannedBead,
): void {
  const xL = slot[0] + MARGIN + geo.width / 2;
  const xR = slot[1] - MARGIN - geo.width / 2;
  if (n <= 1 || xR <= xL) {
    push(w, role, { x: (slot[0] + slot[1]) / 2, y }, 90, 0);
    return;
  }
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const x = xL + (xR - xL) * t;
    push(w, role, { x, y }, 90, 0);
  }
}

function commitLayer(layers: PlanLayer[], layerNo: number, allBeads: PlannedBead[]): void {
  const existing = layers.find((l) => l.layer === layerNo);
  const row = allBeads.filter((b) => b.layer === layerNo);
  if (existing) existing.beads = row;
  else layers.push({ layer: layerNo, y: row[0]?.center.y ?? 0, beads: row });
}

const sumArea = (beads: PlannedBead[]): number => beads.reduce((s, b) => s + b.area, 0);

function pointInFill(section: GrooveSection, p: Vec2): boolean {
  const slices = horizontalSlice(section.fill, p.y);
  return slices.some(([l, r]) => p.x >= l - 1e-6 && p.x <= r + 1e-6);
}

/** 沿焊缝变间隙：按分段逐段重排，间隙大的段自动加道 */
export interface GapPlanInput extends SegmentPlanInput {
  seamLength: number;
  segments: number;
  gapAt: (sNorm: number) => number;
}

export interface GapPlanSegment {
  index: number;
  s0: number; s1: number;
  gap: number;
  result: SegmentPlanResult;
}

export function planVariableGap(inp: GapPlanInput): GapPlanSegment[] {
  const out: GapPlanSegment[] = [];
  for (let i = 0; i < inp.segments; i++) {
    const s0 = i / inp.segments;
    const s1 = (i + 1) / inp.segments;
    const gap = inp.gapAt((s0 + s1) / 2);
    const result = planSegment({ groove: inp.groove, gap, wps: inp.wps });
    out.push({ index: i, s0, s1, gap, result });
  }
  return out;
}

export function interpolateGap(series: { s: number; gap: number }[], sNorm: number): number {
  if (!series.length) return 0;
  if (sNorm <= series[0].s) return series[0].gap;
  for (let i = 0; i + 1 < series.length; i++) {
    const a = series[i], b = series[i + 1];
    if (sNorm >= a.s && sNorm <= b.s) {
      const t = (sNorm - a.s) / Math.max(b.s - a.s, 1e-9);
      return a.gap + (b.gap - a.gap) * t;
    }
  }
  return series[series.length - 1].gap;
}

export { depositionArea, heatInput, polygonArea };
