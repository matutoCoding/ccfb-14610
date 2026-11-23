// ============================================================
// 热过程简化模型
//  - 单道热输入:Q = η·U·I / v  (kJ/mm)
//  - 层间温度:集总热容 + 指数冷却,道次间按焊接/空程时间累计
//  - 超限时给出所需等待时间(解析反解指数冷却)
//  - 输出逐道温度序列与整条焊缝热输入曲线
// ============================================================

import type { BeadPlacement, SegmentPlan, WpsParams } from './types';

export interface ThermalState {
  /** 道次序号 */
  pass: number;
  layer: number;
  /** 该道起焊前温度 ℃ */
  tempBefore: number;
  /** 该道焊后峰值温度(简化)℃ */
  tempPeak: number;
  /** 热输入 kJ/mm */
  heatInput: number;
  /** 是否超限 */
  overLimit: boolean;
  /** 建议等待 s */
  waitSeconds: number;
  /** 累计时刻 s */
  timeAt: number;
}

export interface ThermalReport {
  states: ThermalState[];
  maxTemp: number;
  overLimitPasses: number;
  totalWait: number;
}

/** 单道热输入 kJ/mm */
export function heatInput(wps: WpsParams): number {
  // U·I = W(J/s);v mm/s;η·UI/v J/mm → /1000 kJ/mm
  return (wps.arcEfficiency * wps.voltage * wps.current) / (wps.travelSpeed * 1000);
}

/**
 * 逐道累计温度。
 * 模型:
 *  升温 ΔT = k_heat · Q / (ρc·V影响),用经验系数把热输入折算为温升(标定参数)
 *  冷却 T(t) = T_amb + (T0 - T_amb)·exp(-t/τ),τ = coolingK·板厚/10
 */
export function simulateThermal(
  segments: SegmentPlan[],
  seamLength: number,
  wps: WpsParams,
): ThermalReport {
  const states: ThermalState[] = [];
  let T = wps.preheatTemp || wps.ambientTemp;
  let time = 0;
  const tau = Math.max(20, wps.coolingK * (wps.wireDiameter > 0 ? 1 : 1)); // 见下方按板厚修正
  void tau;
  // 取首段坡口板厚近似(由 beads 半径推影响体积)
  const plateT = estimatePlateThickness(segments);
  const tauS = Math.max(30, wps.coolingK * (plateT / 20));
  // 温升经验系数:每 kJ/mm 折算 ℃(厚板约 18~30,取 24/板厚修正)
  const heatGain = (q: number): number => (q * 1000) / (plateT * 1.6);

  // 以第一段的道次序列为基准(变间隙段道次数不同,取最大段)
  const ref = segments.reduce((a, b) => (b.beads.length > a.beads.length ? b : a), segments[0]);
  if (!ref) return { states, maxTemp: T, overLimitPasses: 0, totalWait: 0 };

  let totalWait = 0;
  ref.beads.forEach((b, idx) => {
    const bwps = b.wps;
    const segLen = seamLength / Math.max(1, segments.length);
    const weldT = segLen / bwps.travelSpeed;
    // 道间空程/排渣时间(简化 8s + 过渡 12s)
    const idleT = idx === 0 ? 0 : 20;
    // 焊前冷却
    T = wps.ambientTemp + (T - wps.ambientTemp) * Math.exp(-idleT / tauS);
    time += idleT;
    const tempBefore = T;

    // 超限等待
    let wait = 0;
    if (tempBefore > wps.interpassLimit) {
      wait = Math.ceil(-tauS * Math.log((wps.interpassLimit - 10 - wps.ambientTemp) / (tempBefore - wps.ambientTemp)));
      wait = Math.max(0, wait);
      T = wps.ambientTemp + (T - wps.ambientTemp) * Math.exp(-wait / tauS);
      time += wait;
      totalWait += wait;
    }

    const q = heatInput(bwps);
    const peak = T + heatGain(q) * (b.role === 'root' ? 1.2 : 1);
    states.push({
      pass: idx,
      layer: b.layer,
      tempBefore: T,
      tempPeak: peak,
      heatInput: q,
      overLimit: tempBefore > wps.interpassLimit,
      waitSeconds: wait,
      timeAt: time,
    });
    T = peak;
    time += weldT;
  });

  return {
    states,
    maxTemp: Math.max(...states.map((s) => s.tempPeak), T),
    overLimitPasses: states.filter((s) => s.overLimit).length,
    totalWait,
  };
}

function estimatePlateThickness(segments: SegmentPlan[]): number {
  if (!segments[0]) return 20;
  const ys = segments[0].cavity.map((p) => p.y);
  return Math.max(8, Math.max(...ys) - Math.min(...ys));
}

/** 整条焊缝热输入曲线(逐道,用于绘图) */
export function heatInputCurve(segments: SegmentPlan[]): { pass: number; q: number; layer: number }[] {
  const ref = segments.reduce((a, b) => (b.beads.length > a.beads.length ? b : a), segments[0]);
  if (!ref) return [];
  return ref.beads.map((b: BeadPlacement, i: number) => ({
    pass: i,
    q: heatInput(b.wps),
    layer: b.layer,
  }));
}
