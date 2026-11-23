// ============================================================
// 默认数据:机器人/变位机配置、典型 WPS、典型工件程序生成
// ============================================================

import type {
  PositionerConfig,
  RobotConfig,
  Seam,
  Vec2,
  WpsParams,
  Workpiece,
  WorkpieceKind,
} from './types';
import { uid } from './db';

export function defaultRobot(): RobotConfig {
  return {
    id: 'robot_default',
    name: 'R6-2000 六轴焊接机器人',
    d1: 480,
    a2: 760,
    a3: 700,
    d4: 120,
    d6: 180,
    limits: [
      { min: -170, max: 170 },
      { min: -90, max: 150 },
      { min: -170, max: 80 },
      { min: -180, max: 180 },
      { min: -135, max: 135 },
      { min: -360, max: 360 },
    ],
    singularityWristThreshold: 8,
    singularityElbowThreshold: 6,
  };
}

export function defaultPositioner(): PositionerConfig {
  return {
    id: 'pos_default',
    name: 'DP-2 双轴头尾架变位机',
    baseToPositioner: [900, 0, 0],
    axis1Limit: { min: -360, max: 360 },
    axis2Limit: { min: -90, max: 90 },
    tableRadius: 450,
  };
}

export function defaultWpsList(): WpsParams[] {
  return [
    {
      id: 'wps_gmaw_12',
      name: 'GMAW 1.2 实心丝 厚板基准',
      process: 'GMAW',
      wireDiameter: 1.2,
      wireFeedSpeed: 8.5,
      travelSpeed: 7,
      voltage: 29,
      current: 285,
      depositionEfficiency: 0.93,
      weaveWidth: 6,
      weaveFrequency: 1.6,
      workAngle: 0,
      travelAngle: 10,
      stickout: 15,
      arcEfficiency: 0.8,
      interpassLimit: 230,
      ambientTemp: 20,
      preheatTemp: 100,
      coolingK: 95,
      wireDensity: 7.85,
    },
    {
      id: 'wps_fcaw_16',
      name: 'FCAW 1.6 药芯丝 大熔敷',
      process: 'FCAW',
      wireDiameter: 1.6,
      wireFeedSpeed: 7.2,
      travelSpeed: 5.5,
      voltage: 31,
      current: 320,
      depositionEfficiency: 0.9,
      weaveWidth: 9,
      weaveFrequency: 1.2,
      workAngle: 5,
      travelAngle: 8,
      stickout: 18,
      arcEfficiency: 0.75,
      interpassLimit: 250,
      ambientTemp: 20,
      preheatTemp: 120,
      coolingK: 110,
      wireDensity: 7.85,
    },
    {
      id: 'wps_gmaw_root',
      name: 'GMAW 1.0 打底专用',
      process: 'GMAW',
      wireDiameter: 1.0,
      wireFeedSpeed: 6.5,
      travelSpeed: 9,
      voltage: 24,
      current: 200,
      depositionEfficiency: 0.95,
      weaveWidth: 0,
      weaveFrequency: 0,
      workAngle: 0,
      travelAngle: 12,
      stickout: 12,
      arcEfficiency: 0.82,
      interpassLimit: 230,
      ambientTemp: 20,
      preheatTemp: 100,
      coolingK: 95,
      wireDensity: 7.85,
    },
  ];
}

// ---------------- 工件生成 ----------------

function boxOutline(w: number, h: number): Vec2[] {
  return [
    { x: -w / 2, y: -h / 2 },
    { x: w / 2, y: -h / 2 },
    { x: w / 2, y: h / 2 },
    { x: -w / 2, y: h / 2 },
  ];
}

function makeSeam(partial: Partial<Seam> & Pick<Seam, 'id' | 'name' | 'joint' | 'groove' | 'length' | 'start' | 'end'>): Seam {
  return { gapProfile: [], ...partial };
}

/** 动臂箱体:矩形箱形截面,4 条纵向角焊缝(T 型) */
function boomBox(): Workpiece {
  const W = 320;
  const H = 260;
  const T = 24;
  const L = 2200;
  const outline = boxOutline(W, H);
  const plates = [
    { name: '上翼板', polygon: boxOutline(W, T).map((p) => ({ ...p, y: p.y + H / 2 - T / 2 })), thickness: T },
    { name: '下翼板', polygon: boxOutline(W, T).map((p) => ({ ...p, y: p.y - H / 2 + T / 2 })), thickness: T },
    { name: '左腹板', polygon: boxOutline(T, H).map((p) => ({ ...p, x: p.x - W / 2 + T / 2 })), thickness: T },
    { name: '右腹板', polygon: boxOutline(T, H).map((p) => ({ ...p, x: p.x + W / 2 - T / 2 })), thickness: T },
  ];
  const seamBase = {
    joint: 'tee' as const,
    groove: {
      type: 'fillet' as const,
      plateThickness: T,
      bevelAngle: 45,
      rootFace: 2,
      rootGap: 2,
      reinforcement: 2.5,
      legSize: 14,
      bothSide: false,
    },
    length: L,
    gapProfile: [],
  };
  const seams: Seam[] = [
    makeSeam({ ...seamBase, id: uid('seam'), name: '左上内角缝', start: [-W / 2 + T, H / 2 - T, 0], end: [-W / 2 + T, H / 2 - T, L] }),
    makeSeam({ ...seamBase, id: uid('seam'), name: '右上内角缝', start: [W / 2 - T, H / 2 - T, 0], end: [W / 2 - T, H / 2 - T, L] }),
    makeSeam({ ...seamBase, id: uid('seam'), name: '左下内角缝', start: [-W / 2 + T, -H / 2 + T, 0], end: [-W / 2 + T, -H / 2 + T, L] }),
    makeSeam({ ...seamBase, id: uid('seam'), name: '右下内角缝', start: [W / 2 - T, -H / 2 + T, 0], end: [W / 2 - T, -H / 2 + T, L] }),
  ];
  return {
    id: uid('wp'),
    name: '挖掘机动臂箱体(320×260×2200)',
    kind: 'boomBox',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    outline,
    plates,
    extrudeLength: L,
    seams,
    note: 'Q355B 箱形动臂,4 条纵向 T 型角焊缝',
  };
}

/** 斗杆筋板:厚板 T 型筋,单边 V 坡口深熔 */
function stickRib(): Workpiece {
  const W = 420;
  const H = 300;
  const T = 32;
  const L = 1500;
  const outline = boxOutline(W, H);
  const plates = [
    { name: '主板', polygon: boxOutline(W, T), thickness: T },
    { name: '筋板', polygon: boxOutline(T, H).map((p) => ({ ...p, x: p.x - 40 })), thickness: T },
  ];
  const seams: Seam[] = [
    makeSeam({
      id: uid('seam'),
      name: '筋板单侧深熔缝',
      joint: 'tee',
      groove: {
        type: 'singleBevel',
        plateThickness: T,
        bevelAngle: 40,
        rootFace: 3,
        rootGap: 2.5,
        reinforcement: 3,
        legSize: 0,
        bothSide: false,
      },
      length: L,
      start: [-40, T / 2, 0],
      end: [-40, T / 2, L],
      gapProfile: [],
    }),
    makeSeam({
      id: uid('seam'),
      name: '筋板封底角缝',
      joint: 'tee',
      groove: {
        type: 'fillet',
        plateThickness: T,
        bevelAngle: 45,
        rootFace: 2,
        rootGap: 0,
        reinforcement: 2,
        legSize: 10,
        bothSide: false,
      },
      length: L,
      start: [-40, -T / 2, 0],
      end: [-40, -T / 2, L],
      gapProfile: [],
    }),
  ];
  return {
    id: uid('wp'),
    name: '斗杆焊接筋板组件(T32)',
    kind: 'stickRib',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    outline,
    plates,
    extrudeLength: L,
    seams,
    note: 'Q690D 高强钢筋板,单边 Bevel 深熔+封底',
  };
}

/** 变截面对接厚板:双 V,沿长度带变间隙序列(模拟激光寻位) */
function variableButt(): Workpiece {
  const T = 40;
  const W = 360;
  const L = 1800;
  const outline = boxOutline(W, T);
  const plates = [
    { name: '左对接板', polygon: boxOutline(W / 2 - 2, T).map((p) => ({ ...p, x: p.x - W / 4 })), thickness: T },
    { name: '右对接板', polygon: boxOutline(W / 2 - 2, T).map((p) => ({ ...p, x: p.x + W / 4 })), thickness: T },
  ];
  const gapProfile = [
    { t: 0, gap: 2.0 },
    { t: 0.2, gap: 2.6 },
    { t: 0.45, gap: 4.2 },
    { t: 0.6, gap: 5.0 },
    { t: 0.8, gap: 3.4 },
    { t: 1, gap: 2.2 },
  ];
  const seams: Seam[] = [
    makeSeam({
      id: uid('seam'),
      name: '变截面双 V 对接主缝',
      joint: 'butt',
      groove: {
        type: 'doubleV',
        plateThickness: T,
        bevelAngle: 30,
        rootFace: 4,
        rootGap: 2.5,
        reinforcement: 2.5,
        legSize: 0,
        bothSide: true,
      },
      length: L,
      start: [0, 0, 0],
      end: [0, 0, L],
      gapProfile,
    }),
  ];
  return {
    id: uid('wp'),
    name: '变截面厚板对接(T40 双V)',
    kind: 'variableButt',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    outline,
    plates,
    extrudeLength: L,
    seams,
    note: '带激光寻位变间隙序列,中段最大间隙 5mm',
  };
}

export function createWorkpiece(kind: WorkpieceKind): Workpiece {
  switch (kind) {
    case 'boomBox':
      return boomBox();
    case 'stickRib':
      return stickRib();
    case 'variableButt':
    default:
      return variableButt();
  }
}

export const WORKPIECE_KIND_LABELS: Record<WorkpieceKind, string> = {
  boomBox: '动臂箱体',
  stickRib: '斗杆筋板',
  variableButt: '变截面对接厚板',
};
