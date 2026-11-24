import type { PlannedBead, ThermalPassState, ThermalSettings } from './types';

export interface ThermalPlanResult {
  states: ThermalPassState[];
  curve: Array<{ beadIndex: number; s: number; temp: number; heatInput: number }>;
  totalWait: number;
  peakTemp: number;
}

const cool = (temp: number, ambient: number, tau: number, dt: number): number =>
  ambient + (temp - ambient) * Math.exp(-dt / tau);

/**
 * 集总参数层间温度估计（明确标注为工程估算，非有限元）：
 *  ΔT = c · Q（Q kJ/mm），道间按指数冷却
 */
export function planThermal(
  beads: PlannedBead[],
  segmentLengthMm: number,
  settings: ThermalSettings,
): ThermalPlanResult {
  const states: ThermalPassState[] = [];
  const curve: ThermalPlanResult['curve'] = [];
  let temp = settings.ambientTemp;
  let totalWait = 0;
  let peak = temp;
  let s = 0;

  beads.forEach((b, i) => {
    // 道间重定位冷却
    temp = cool(temp, settings.ambientTemp, settings.coolingTau, settings.repositionTime);
    const tempBefore = temp;

    // 超温 → 反解等待时间
    let wait = 0;
    if (tempBefore > settings.interpassLimit) {
      const ratio = (settings.interpassLimit - settings.ambientTemp) / (tempBefore - settings.ambientTemp);
      wait = Math.max(0, -settings.coolingTau * Math.log(Math.min(0.999, ratio)));
      temp = cool(tempBefore, settings.ambientTemp, settings.coolingTau, wait);
      totalWait += wait;
    }

    const arcTime = segmentLengthMm / b.travelSpeed;
    const rise = settings.risePerKjPerMm * b.heatInput;
    const tempAfter = temp + rise;
    peak = Math.max(peak, tempAfter);

    states.push({
      beadIndex: b.index, segmentIndex: 0,
      tempBefore, tempAfter, heatInput: b.heatInput,
      arcTime, waitBefore: wait, overLimit: wait > 0,
    });
    s += arcTime;
    curve.push({ beadIndex: b.index, s, temp: tempAfter, heatInput: b.heatInput });
    temp = tempAfter;
    void i;
  });

  return { states, curve, totalWait, peakTemp: peak };
}

/** 等待时间（秒）→ 现场可读的分:秒 */
export function formatWait(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}分${s.toString().padStart(2, '0')}秒` : `${s}秒`;
}
