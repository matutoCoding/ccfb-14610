import type {
  DefectMark, PlanScheme, PlanSegment, ThermalSettings, WeldSeam, WpsParams,
} from '../core/types';
import { interpolateGap, planSegment, planVariableGap } from '../core/planner';
import { detectDefects } from '../core/defects';
import { planThermal } from '../core/thermal';
import { uid } from '../core/wps';

export interface BuildSchemeInput {
  workpieceId: string;
  seam: WeldSeam;
  wps: { root: WpsParams; fill: WpsParams; cap: WpsParams };
  thermal: ThermalSettings;
  name: string;
}

/** 编排整条焊缝（含变间隙分段）的完整排道方案 */
export function buildScheme(inp: BuildSchemeInput): {
  scheme: PlanScheme;
  defects: DefectMark[];
} {
  const segCount = Math.max(1, inp.seam.segments);
  const gapAt = (s: number): number =>
    inp.seam.gapSeries.length
      ? interpolateGap(inp.seam.gapSeries, s)
      : inp.seam.groove.rootGap;

  const planned = planVariableGap({
    groove: inp.seam.groove,
    gap: inp.seam.groove.rootGap,
    wps: inp.wps,
    seamLength: inp.seam.length,
    segments: segCount,
    gapAt,
  });

  const segLength = inp.seam.length / segCount;
  const segments: PlanSegment[] = [];
  let beadIndexBase = 0;
  const allDefects: DefectMark[] = [];
  let totalVolume = 0;
  let totalArc = 0;
  let totalWait = 0;
  const allBeads = [];

  for (const seg of planned) {
    // 道次号全局连续
    const beads = seg.result.beads.map((b) => ({ ...b, index: b.index + beadIndexBase }));
    beadIndexBase += seg.result.beads.length;
    allBeads.push(...beads);
    const layers = seg.result.layers.map((l) => ({
      ...l,
      beads: l.beads.map((b) => ({ ...b, index: b.index + (beadIndexBase - seg.result.beads.length) })),
    }));
    const segVolume = seg.result.depositedArea * segLength;
    totalVolume += segVolume;
    const arc = beads.reduce((s, b) => s + segLength / b.travelSpeed, 0);
    totalArc += arc;

    segments.push({
      index: seg.index,
      s0: seg.s0, s1: seg.s1,
      gap: seg.gap,
      beads, layers,
      grooveArea: seg.result.requiredArea,
      depositedArea: seg.result.depositedArea,
      areaErrorPct: seg.result.errorPct,
    });

    const marks = detectDefects(beads, seg.result.section);
    for (const m of marks) allDefects.push({ ...m, segmentIndex: seg.index } as DefectMark);
  }

  // 热过程按代表性中部分段估算
  const midSeg = planned[Math.floor(planned.length / 2)].result;
  const thermalRes = planThermal(midSeg.beads, segLength, inp.thermal);
  totalWait = thermalRes.totalWait * segCount;

  const wireDensity = inp.wps.fill.wireDensity;
  const totalMass = totalVolume * wireDensity * (1 / 1000); // mm³·g/mm³ → g

  // 面积审计：取各分段最差误差
  const worstErr = Math.max(...segments.map((s) => Math.abs(s.areaErrorPct)));
  const totalRequired = segments.reduce((s, x) => s + x.grooveArea * segLength, 0);
  const totalDeposited = segments.reduce((s, x) => s + x.depositedArea * segLength, 0);
  const scheme: PlanScheme = {
    id: uid('scheme'),
    workpieceId: inp.workpieceId,
    seamId: inp.seam.id,
    name: inp.name,
    createdAt: Date.now(),
    wpsIds: { root: inp.wps.root.id, fill: inp.wps.fill.id, cap: inp.wps.cap.id },
    thermal: inp.thermal,
    segments,
    audit: {
      requiredArea: totalRequired / segLength,
      depositedArea: totalDeposited / segLength,
      errorPct: ((totalDeposited - totalRequired) / totalRequired) * 100,
      pass: worstErr <= 3,
      iterations: Math.max(...planned.map((p) => p.result.iterations)),
      adjustments: planned.flatMap((p) => p.result.adjustments),
    },
    totalDepositionVolume: totalVolume,
    totalWireMass: totalMass,
    totalArcTime: totalArc,
    totalWaitTime: totalWait,
    totalTime: totalArc + totalWait + inp.thermal.repositionTime * allBeads.length,
  };
  return { scheme, defects: allDefects };
}
