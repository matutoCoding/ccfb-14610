import type { WpsParams, ThermalSettings, PlannedBead, WpsPassRole } from './types';

let seq = 0;
export const uid = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

/** 常用 GMAW/MAG 工艺预设（实心焊丝，厚板钢结构典型值） */
export function defaultWpsSets(): WpsParams[] {
  return [
    {
      id: 'wps-root-mag12', name: '根焊 MAG φ1.2', role: 'root',
      wireDiameter: 1.2, wireDensity: 7.85e-3,
      wfs: 7.5, travelSpeed: 6.5, depositionEfficiency: 0.93,
      current: 240, voltage: 27.5, thermalEfficiency: 0.8,
      weaveWidth: 0, weaveFreq: 0,
      penetrationFactor: 0.020, beadShapeFactor: 2.0,
    },
    {
      id: 'wps-fill-mag12', name: '填充 MAG φ1.2', role: 'fill',
      wireDiameter: 1.2, wireDensity: 7.85e-3,
      wfs: 9.5, travelSpeed: 5.2, depositionEfficiency: 0.93,
      current: 285, voltage: 30, thermalEfficiency: 0.8,
      weaveWidth: 6, weaveFreq: 1.6,
      penetrationFactor: 0.018, beadShapeFactor: 2.2,
    },
    {
      id: 'wps-cap-mag12', name: '盖面 MAG φ1.2', role: 'cap',
      wireDiameter: 1.2, wireDensity: 7.85e-3,
      wfs: 8.2, travelSpeed: 5.8, depositionEfficiency: 0.93,
      current: 260, voltage: 28.5, thermalEfficiency: 0.8,
      weaveWidth: 10, weaveFreq: 1.4,
      penetrationFactor: 0.016, beadShapeFactor: 2.6,
    },
  ];
}

export function defaultThermal(): ThermalSettings {
  return {
    ambientTemp: 20,
    interpassLimit: 250,
    risePerKjPerMm: 420,   // 工程标定系数：1 kJ/mm 对应的集总温升
    coolingTau: 240,       // 4 min 冷却时间常数
    repositionTime: 12,
  };
}

/**
 * 单道熔敷面积（mm²）
 * 送丝体积流 = πd²/4 · WFS(mm/s)，乘熔敷效率后除以焊速
 */
export function depositionArea(w: WpsParams): number {
  const wfsMmS = w.wfs * 1000 / 60;
  const wireArea = Math.PI * w.wireDiameter * w.wireDiameter / 4;
  return (wireArea * wfsMmS * w.depositionEfficiency) / w.travelSpeed;
}

/** 热输入 kJ/mm：Q = η·U·I / v（v mm/s → kJ/mm） */
export function heatInput(w: WpsParams): number {
  return (w.thermalEfficiency * w.voltage * w.current) / (w.travelSpeed * 1000);
}

/** 熔深 mm（工程经验式：与电流线性相关） */
export function penetrationDepth(w: WpsParams): number {
  return w.penetrationFactor * w.current;
}

export interface BeadGeometry {
  area: number;
  radiusEq: number;   // 等面积圆半径
  width: number;      // 焊道宽
  height: number;     // 焊道高（椭球冠近似）
  penetration: number;
}

/** 由工艺参数推出焊道几何（截面以椭圆近似，面积 = π/4·w·h） */
export function beadGeometry(w: WpsParams): BeadGeometry {
  const area = depositionArea(w);
  const rEq = Math.sqrt(area / Math.PI);
  const width = 2 * rEq * Math.sqrt(w.beadShapeFactor);
  const height = 2 * rEq / Math.sqrt(w.beadShapeFactor);
  return { area, radiusEq: rEq, width, height, penetration: penetrationDepth(w) };
}

export function makeBead(
  w: WpsParams, index: number, layer: number, role: WpsPassRole,
  center: { x: number; y: number }, workAngleDeg: number,
  travelAngleDeg: number, pointerOffset: number,
  areaOverride?: number,
): PlannedBead {
  const geo = beadGeometry(w);
  const area = areaOverride ?? geo.area;
  const scale = area / geo.area;
  return {
    index, layer, role, center: { ...center },
    area, nominalArea: geo.area,
    radiusEq: geo.radiusEq * Math.sqrt(scale),
    beadWidth: geo.width * Math.sqrt(scale),
    beadHeight: geo.height * Math.sqrt(scale),
    penetration: geo.penetration,
    workAngleDeg, travelAngleDeg, pointerOffset,
    wfs: w.wfs, travelSpeed: w.travelSpeed,
    current: w.current, voltage: w.voltage,
    weaveWidth: w.weaveWidth, weaveFreq: w.weaveFreq,
    heatInput: heatInput(w),
    areaAdjusted: areaOverride !== undefined && Math.abs(areaOverride - geo.area) > 1e-6,
  };
}
