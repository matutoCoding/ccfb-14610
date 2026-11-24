import type { GrooveParams, PartSolid, PartTemplateId, Vec3, WeldSeam, Workpiece } from './types';
import { uid } from './wps';

export const DEFAULT_GROOVE = (over: Partial<GrooveParams> = {}): GrooveParams => ({
  kind: 'V',
  thickness: 30,
  grooveAngleDeg: 30,
  rootFace: 2,
  rootGap: 3,
  reinforcement: 2.5,
  uRadius: 8,
  legSize: 12,
  ...over,
});

interface TemplateDef {
  id: PartTemplateId;
  name: string;
  desc: string;
  build: () => Omit<Workpiece, 'id' | 'createdAt'>;
}

const solid = (id: string, center: Vec3, size: Vec3, rpyDeg: Vec3 = { x: 0, y: 0, z: 0 }): PartSolid =>
  ({ id, kind: 'box', center, size, rpyDeg });

/** 动臂箱体：上下盖板 + 两腹板 + 内隔板，T 型/角接长焊缝 */
function boomBox(): Omit<Workpiece, 'id' | 'createdAt'> {
  const L = 2400, W = 320, H = 260, t = 24;
  const solids: PartSolid[] = [
    solid('top-plate', { x: 0, y: 0, z: H / 2 - t / 2 }, { x: L, y: W, z: t }),
    solid('bottom-plate', { x: 0, y: 0, z: -H / 2 + t / 2 }, { x: L, y: W, z: t }),
    solid('web-left', { x: 0, y: -W / 2 + t / 2, z: 0 }, { x: L, y: t, z: H - 2 * t }),
    solid('web-right', { x: 0, y: W / 2 - t / 2, z: 0 }, { x: L, y: t, z: H - 2 * t }),
    solid('rib-1', { x: -600, y: 0, z: 0 }, { x: 18, y: W - 2 * t, z: H - 2 * t }),
    solid('rib-2', { x: 200, y: 0, z: 0 }, { x: 18, y: W - 2 * t, z: H - 2 * t }),
    solid('rib-3', { x: 900, y: 0, z: 0 }, { x: 18, y: W - 2 * t, z: H - 2 * t }),
  ];
  const seams: WeldSeam[] = [
    seam('上盖板-右腹板 角焊缝', 'tee', DEFAULT_GROOVE({ kind: 'fillet', thickness: t, legSize: 14, rootGap: 2, reinforcement: 2 }),
      L - 200, { x: 0, y: W / 2 - t, z: H / 2 - t }),
    seam('上盖板-左腹板 角焊缝', 'tee', DEFAULT_GROOVE({ kind: 'fillet', thickness: t, legSize: 14, rootGap: 2, reinforcement: 2 }),
      L - 200, { x: 0, y: -W / 2 + t, z: H / 2 - t }),
    seam('下盖板-右腹板 角焊缝', 'tee', DEFAULT_GROOVE({ kind: 'fillet', thickness: t, legSize: 12, rootGap: 2, reinforcement: 2 }),
      L - 200, { x: 0, y: W / 2 - t, z: -H / 2 + t }),
    seam('隔板#2 三边坡口焊', 'tee', DEFAULT_GROOVE({ kind: 'V', thickness: 18, grooveAngleDeg: 35, rootFace: 2, rootGap: 3, reinforcement: 2 }),
      W - 2 * t - 40, { x: 200, y: 0, z: 0 }),
  ];
  return {
    name: '挖掘机动臂箱体段', template: 'boom-box',
    plateThickness: t, overallSize: { x: L, y: W, z: H },
    notes: 'Q355B 箱体结构，主焊缝为腹板/盖板角焊缝，隔板双面坡口',
    solids, seams,
  };
}

/** 斗杆筋板：立板 + 多块筋板，深坡口/窄空间，重点考察碰撞 */
function armRib(): Omit<Workpiece, 'id' | 'createdAt'> {
  const L = 1600, H = 420, t = 40, ribT = 20;
  const solids: PartSolid[] = [
    solid('main-plate', { x: 0, y: 0, z: 0 }, { x: L, y: t, z: H }),
    solid('rib-a', { x: -450, y: 120, z: -40 }, { x: ribT, y: 240, z: 300 }),
    solid('rib-b', { x: 50, y: 120, z: -60 }, { x: ribT, y: 240, z: 260 }),
    solid('rib-c', { x: 550, y: 120, z: -20 }, { x: ribT, y: 240, z: 340 }),
    solid('top-cap', { x: 0, y: 60, z: H / 2 - 15 }, { x: L - 100, y: 150, z: 30 }),
  ];
  const seams: WeldSeam[] = [
    seam('筋板A 根部深坡口', 'tee',
      DEFAULT_GROOVE({ kind: 'V', thickness: ribT, grooveAngleDeg: 25, rootFace: 1.5, rootGap: 2.5, reinforcement: 2 }),
      300, { x: -450, y: 0, z: -40 }),
    seam('筋板C 根部深坡口', 'tee',
      DEFAULT_GROOVE({ kind: 'V', thickness: ribT, grooveAngleDeg: 25, rootFace: 1.5, rootGap: 4, reinforcement: 2 }),
      340, { x: 550, y: 0, z: -20 }),
    seam('顶板对接 V 坡口', 'butt',
      DEFAULT_GROOVE({ kind: 'V', thickness: 30, grooveAngleDeg: 30, rootFace: 2, rootGap: 3, reinforcement: 2.5 }),
      L - 200, { x: 0, y: 60, z: H / 2 }),
  ];
  return {
    name: '挖掘机斗杆筋板组件', template: 'arm-rib',
    plateThickness: t, overallSize: { x: L, y: 280, z: H },
    notes: '窄空间深坡口，焊枪与筋板碰撞风险高，需自动避碰过渡',
    solids, seams,
  };
}

/** 变截面厚板对接：沿焊缝方向板厚变化，考察变间隙逐段重排 */
function variableButt(): Omit<Workpiece, 'id' | 'createdAt'> {
  const L = 1800, W = 500;
  const solids: PartSolid[] = [
    solid('plate-A', { x: 0, y: -W / 4 - 2, z: 0 }, { x: L, y: W / 2 - 4, z: 50 }),
    solid('plate-B', { x: 0, y: W / 4 + 2, z: 0 }, { x: L, y: W / 2 - 4, z: 50 }),
  ];
  const s = seam('变间隙厚板对接', 'butt',
    DEFAULT_GROOVE({ kind: 'X', thickness: 50, grooveAngleDeg: 28, rootFace: 2, rootGap: 3, reinforcement: 2.5 }),
    L, { x: 0, y: 0, z: 0 });
  s.pathKind = 'curved';
  s.curvatureRadius = 6000;
  s.segments = 8;
  // 模拟激光寻位：中部装配间隙大、两端小
  s.gapSeries = Array.from({ length: 9 }, (_, i) => {
    const u = i / 8;
    return { s: u, gap: 2 + 5 * Math.sin(Math.PI * u) }; // 2~7mm
  });
  return {
    name: '变截面厚板对接试板', template: 'variable-butt',
    plateThickness: 50, overallSize: { x: L, y: W, z: 50 },
    notes: 'X 形双边坡口，激光寻位变间隙，间隙大的中段自动加道',
    solids, seams: [s],
  };
}

function seam(name: string, joint: WeldSeam['jointKind'], groove: GrooveParams,
  length: number, origin: Vec3): WeldSeam {
  return {
    id: uid('seam'), name, jointKind: joint, groove,
    length, pathKind: 'straight', curvatureRadius: 0,
    gapSeries: [], segments: 6,
  };
}

export const TEMPLATES: Record<PartTemplateId, TemplateDef> = {
  'boom-box': { id: 'boom-box', name: '动臂箱体', desc: '盖板+腹板+隔板箱体结构，角焊缝为主', build: boomBox },
  'arm-rib': { id: 'arm-rib', name: '斗杆筋板', desc: '窄空间深坡口筋板，碰撞避障场景', build: armRib },
  'variable-butt': { id: 'variable-butt', name: '变截面对接', desc: 'X 坡口厚板对接，激光变间隙逐段排道', build: variableButt },
};

export function createWorkpiece(template: PartTemplateId): Workpiece {
  const def = TEMPLATES[template];
  return { ...def.build(), id: uid('wp'), createdAt: Date.now() };
}

/** 焊缝局部坐标 → 工件世界坐标的路径帧（直线/圆弧） */
export function seamPathFrames(seam: WeldSeam, samples = 24): Array<{
  s: number; point: Vec3; tangent: Vec3; normal: Vec3;
}> {
  const out: Array<{ s: number; point: Vec3; tangent: Vec3; normal: Vec3 }> = [];
  if (seam.pathKind === 'straight' || seam.curvatureRadius <= 0) {
    for (let i = 0; i <= samples; i++) {
      const u = i / samples;
      out.push({
        s: u,
        point: { x: -seam.length / 2 + seam.length * u, y: 0, z: 0 },
        tangent: { x: 1, y: 0, z: 0 },
        normal: { x: 0, y: 0, z: 1 },
      });
    }
  } else {
    const R = seam.curvatureRadius;
    const totalAng = seam.length / R;
    for (let i = 0; i <= samples; i++) {
      const u = i / samples;
      const ang = -totalAng / 2 + totalAng * u;
      out.push({
        s: u,
        point: { x: R * Math.sin(ang), y: 0, z: R * (1 - Math.cos(ang)) },
        tangent: { x: Math.cos(ang), y: 0, z: Math.sin(ang) },
        normal: { x: -Math.sin(ang), y: 0, z: Math.cos(ang) },
      });
    }
  }
  return out;
}
