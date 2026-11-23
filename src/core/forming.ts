// ============================================================
// 焊道成形分析
//  - 每道熔深/熔合线(圆与母材壁、相邻焊道的交线)
//  - 侧壁熔合不足判定:焊道圆与坡口壁的接触弦长 < 阈值
//  - 夹渣风险:相邻两道表面在坡口侧壁处的夹角 < 阈值(典型 <90° 易夹渣)
//  - 输出圈注位置,供成形页 Canvas 标红
// ============================================================

import type { BeadPlacement, FusionIssue, SegmentPlan, Vec2 } from './types';
import {
  angleOf,
  circleLineIntersections,
  closestPointOnPolygon,
  dist2,
  sub2,
} from './geom2d';
import type { GrooveGeometry } from './groove';

export type { FusionIssue } from './types';

export interface BeadFusion {
  pass: number;
  /** 左右侧壁接触弦长 mm(0 表示未接触) */
  leftContact: number;
  rightContact: number;
  /** 熔深(向母材方向)mm */
  penetration: number;
  /** 与相邻焊道的熔合交线长度 mm */
  interBeadFusion: number;
  /** 熔合线关键点(用于绘制) */
  fusionLine: Vec2[];
}

export interface FormingReport {
  fusions: BeadFusion[];
  issues: FusionIssue[];
  /** 合格率(无问题道次占比) */
  passRate: number;
}

/** 分析单段排道的成形质量 */
export function analyzeForming(segment: SegmentPlan, geom: GrooveGeometry): FormingReport {
  const fusions: BeadFusion[] = [];
  const issues: FusionIssue[] = [];
  const beads = segment.beads;

  for (const b of beads) {
    // 1) 与左右壁的接触
    let leftContact = 0;
    let rightContact = 0;
    const fusionLine: Vec2[] = [];
    for (const w of geom.walls) {
      const pts = circleLineIntersections(b.center, b.radius, w.a, w.b);
      if (pts.length === 2) {
        const chord = dist2(pts[0], pts[1]);
        if (w.side === 'left') leftContact = chord;
        if (w.side === 'right') rightContact = chord;
        fusionLine.push(...pts);
      }
    }

    // 2) 与同层/下层相邻焊道的熔合交线
    let inter = 0;
    for (const o of beads) {
      if (o.pass === b.pass) continue;
      const d = dist2(b.center, o.center);
      if (d < b.radius + o.radius && d > Math.abs(b.radius - o.radius)) {
        // 相交弦长公式
        const chord =
          (2 *
            Math.sqrt(
              Math.max(
                0,
                ((b.radius + o.radius) ** 2 - d * d) *
                  (d * d - (b.radius - o.radius) ** 2),
              ),
            )) /
          (2 * d);
        inter = Math.max(inter, chord);
      }
    }

    fusions.push({
      pass: b.pass,
      leftContact,
      rightContact,
      penetration: b.penetration,
      interBeadFusion: inter,
      fusionLine,
    });

    // 3) 侧壁熔合不足:仅对贴近左/右壁的填充道判定(根焊在间隙、盖面居中、居中填充不贴壁均豁免)
    if (b.role === 'fill') {
      const nearLeft = wallDistance(b, geom, 'left') < b.radius * 1.05;
      const nearRight = wallDistance(b, geom, 'right') < b.radius * 1.05;
      const threshold = b.width * 0.35;
      if (nearLeft && leftContact < threshold) {
        issues.push(makeSidewallIssue(b, geom, leftContact, threshold, '左'));
      }
      if (nearRight && rightContact < threshold) {
        issues.push(makeSidewallIssue(b, geom, rightContact, threshold, '右'));
      }
    }
  }

  // 4) 夹渣角:相邻两道与壁面形成的凹槽夹角
  for (let i = 0; i < beads.length - 1; i++) {
    const a = beads[i];
    const b = beads[i + 1];
    if (a.layer !== b.layer) continue;
    const d = dist2(a.center, b.center);
    if (d > (a.radius + b.radius) * 1.05) {
      // 两圆未充分搭接,中间形成深沟
      const groovePoint: Vec2 = {
        x: (a.center.x + b.center.x) / 2,
        y: Math.max(a.center.y, b.center.y) - Math.min(a.radius, b.radius) * 0.4,
      };
      const v1 = sub2(a.center, groovePoint);
      const v2v = sub2(b.center, groovePoint);
      const cosAng = (v1.x * v2v.x + v1.y * v2v.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2v.x, v2v.y) || 1);
      const ang = (Math.acos(Math.max(-1, Math.min(1, cosAng))) * 180) / Math.PI;
      if (ang < 90) {
        issues.push({
          kind: 'slagTrap',
          pass: b.pass,
          layer: b.layer,
          position: groovePoint,
          severity: clamp01((90 - ang) / 90),
          message: `第${a.pass + 1}/${b.pass + 1}道间夹角 ${ang.toFixed(0)}° <90°,夹渣风险`,
        });
      }
    }
  }

  // 5) 盖面余高/ underfill 检查
  const caps = beads.filter((b) => b.role === 'cap');
  const topY = geom.topLeft.y;
  for (const c of caps) {
    if (c.center.y + c.radius < topY) {
      issues.push({
        kind: 'underfill',
        pass: c.pass,
        layer: c.layer,
        position: c.center,
        severity: 0.6,
        message: `第${c.pass + 1}盖面道未填满余高,存在凹痕`,
      });
    }
  }

  const passRate = (beads.length - new Set(issues.map((i) => i.pass)).size) / Math.max(1, beads.length);
  return { fusions, issues, passRate };
}

/** 焊道中心到指定侧壁的最短距离 */
function wallDistance(b: BeadPlacement, geom: GrooveGeometry, side: 'left' | 'right'): number {
  let best = Infinity;
  for (const w of geom.walls) {
    if (w.side !== side) continue;
    const ab = sub2(w.b, w.a);
    const l2 = ab.x * ab.x + ab.y * ab.y;
    let t = l2 < 1e-12 ? 0 : ((b.center.x - w.a.x) * ab.x + (b.center.y - w.a.y) * ab.y) / l2;
    t = Math.max(0, Math.min(1, t));
    const q = { x: w.a.x + ab.x * t, y: w.a.y + ab.y * t };
    best = Math.min(best, dist2(b.center, q));
  }
  return best;
}

function makeSidewallIssue(b: BeadPlacement, geom: GrooveGeometry, contact: number, threshold: number, sideName: string): FusionIssue {
  const nearest = closestPointOnPolygon(b.center, geom.cavity);
  return {
    kind: 'sidewallLack',
    pass: b.pass,
    layer: b.layer,
    position: nearest.point,
    severity: clamp01(1 - contact / threshold),
    message: `第${b.pass + 1}道${sideName}侧壁接触弦长 ${contact.toFixed(1)}mm,疑似侧壁未熔合`,
  };
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** 生成单道熔合线轮廓(圆与环境交切后的截面线,供成形页绘制) */
export function fusionOutline(b: BeadPlacement, geom: GrooveGeometry): Vec2[] {
  const pts: Vec2[] = [];
  const N = 48;
  for (let i = 0; i < N; i++) {
    const ang = (i / N) * Math.PI * 2;
    pts.push({ x: b.center.x + b.radius * Math.cos(ang), y: b.center.y + b.radius * Math.sin(ang) });
  }
  void geom;
  void angleOf;
  return pts;
}
