import type { DefectMark, PlannedBead } from './types';
import type { GrooveSection, Sidewall } from './groove';
import { circleIntersections, pointSegmentDistance, rad2deg } from './geometry';

// 判定阈值（工程经验，集中在一处便于标定）
export const DEFECT_THRESHOLDS = {
  sidewallGapMm: 0.8,       // 焊道边缘到侧壁熔合线距离（扣熔深后）大于该值 → 未熔合
  slagValleyAngleDeg: 90,   // 同层相邻道朝上的谷角小于该值 → 夹渣
  interlayerGapMm: 0.6,     // 层间搭界最小熔合裕量
};

/**
 * 焊道用等面积圆近似做几何判定（保守、可解释）。
 * 侧壁：圆心到侧壁距离 - rEq - penetration > 阈值 → 侧壁未熔合
 */
export function detectDefects(beads: PlannedBead[], section: GrooveSection): DefectMark[] {
  const marks: DefectMark[] = [];

  for (const b of beads) {
    // ---- 侧壁未熔合 ----
    let worst: { sw: Sidewall; gap: number } | null = null;
    for (const sw of section.sidewalls) {
      const { d } = pointSegmentDistance(b.center, sw.a, sw.b);
      const fusionGap = d - b.radiusEq - b.penetration;
      if (fusionGap > DEFECT_THRESHOLDS.sidewallGapMm && (!worst || fusionGap > worst.gap)) {
        worst = { sw, gap: fusionGap };
      }
    }
    if (worst) {
      marks.push({
        beadIndex: b.index, kind: 'sidewall-lack-fusion',
        severity: worst.gap > DEFECT_THRESHOLDS.sidewallGapMm * 2 ? 'bad' : 'warn',
        position: { ...b.center },
        message: `第${b.index}道距${worst.sw.id}侧壁熔合缺口 ${worst.gap.toFixed(2)}mm，熔深${b.penetration.toFixed(1)}mm 不足`,
        metric: worst.gap, threshold: DEFECT_THRESHOLDS.sidewallGapMm,
      });
    }
  }

  // ---- 同层夹渣（谷角过小）----
  const byLayer = new Map<number, PlannedBead[]>();
  for (const b of beads) {
    const arr = byLayer.get(b.layer) ?? [];
    arr.push(b); byLayer.set(b.layer, arr);
  }
  for (const [, row] of byLayer) {
    row.sort((a, b) => a.center.x - b.center.x);
    for (let i = 0; i + 1 < row.length; i++) {
      const a = row[i], c = row[i + 1];
      const hits = circleIntersections(a.center, a.radiusEq, c.center, c.radiusEq);
      const upper = hits.filter((p) => p.y >= Math.min(a.center.y, c.center.y)).sort((u, v) => v.y - u.y)[0];
      if (!upper) continue;
      // 两圆心到上交点的向量夹角（朝上的开口角）
      const v1 = { x: a.center.x - upper.x, y: a.center.y - upper.y };
      const v2 = { x: c.center.x - upper.x, y: c.center.y - upper.y };
      const dot = v1.x * v2.x + v1.y * v2.y;
      const cosAng = dot / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y));
      const ang = rad2deg(Math.acos(Math.max(-1, Math.min(1, cosAng))));
      if (ang < DEFECT_THRESHOLDS.slagValleyAngleDeg) {
        marks.push({
          beadIndex: c.index, kind: 'slag-trap',
          severity: ang < 75 ? 'bad' : 'warn',
          position: upper,
          message: `第${a.index}/${c.index}道间谷角 ${ang.toFixed(1)}° < ${DEFECT_THRESHOLDS.slagValleyAngleDeg}°，易夹渣`,
          metric: ang, threshold: DEFECT_THRESHOLDS.slagValleyAngleDeg,
        });
      }
    }
  }

  // ---- 层间未熔合：上层道与下层最近道的垂直搭接小于阈值 ----
  const layers = [...byLayer.keys()].sort((x, y) => x - y);
  for (let li = 1; li < layers.length; li++) {
    const upper = byLayer.get(layers[li])!;
    const lower = byLayer.get(layers[li - 1])!;
    for (const b of upper) {
      let best = Infinity;
      for (const a of lower) {
        const dy = b.center.y - a.center.y;
        const overlap = (a.beadHeight / 2 + b.beadHeight / 2) - dy + a.penetration * 0.5;
        best = Math.min(best, -overlap);
      }
      const gap = best; // 正值=脱开
      if (gap > DEFECT_THRESHOLDS.interlayerGapMm) {
        marks.push({
          beadIndex: b.index, kind: 'interlayer-lack-fusion',
          severity: 'warn', position: { ...b.center },
          message: `第${b.index}道与下层脱开 ${gap.toFixed(2)}mm，层间可能未熔合`,
          metric: gap, threshold: DEFECT_THRESHOLDS.interlayerGapMm,
        });
      }
    }
  }

  return marks.sort((a, b) => a.beadIndex - b.beadIndex);
}
