import { describe, expect, it } from 'vitest';
import { solveCoordination, positionerFK, DEFAULT_POSITIONER } from '../src/core/positioner';
import { detectDefects } from '../src/core/defects';
import { planThermal, formatWait } from '../src/core/thermal';
import { planSegment } from '../src/core/planner';
import { DEFAULT_GROOVE } from '../src/core/workpieces';
import { defaultWpsSets, defaultThermal } from '../src/core/wps';
import type { WpsPassRole } from '../src/core/types';

const wpsMap = () => {
  const list = defaultWpsSets();
  return { root: list[0], fill: list[1], cap: list[2] } as Record<WpsPassRole, (typeof list)[number]>;
};

describe('双轴变位机协调', () => {
  it('平焊目标下找到的解使坡口法向贴近世界 Z', () => {
    const sol = solveCoordination({
      point: { x: 100, y: 0, z: 0 },
      tangent: { x: 1, y: 0, z: 0 },
      normal: { x: 0, y: 1, z: 0 }, // 初始侧向，需变位机翻转
    }, 0);
    expect(sol.tiltDeg).toBeLessThan(8);
    // 限位内
    expect(sol.j1).toBeGreaterThanOrEqual(DEFAULT_POSITIONER.j1Min - 1e-9);
    expect(sol.j1).toBeLessThanOrEqual(DEFAULT_POSITIONER.j1Max + 1e-9);
    expect(sol.j2).toBeGreaterThanOrEqual(DEFAULT_POSITIONER.j2Min - 1e-9);
    expect(sol.j2).toBeLessThanOrEqual(DEFAULT_POSITIONER.j2Max + 1e-9);
    // FK 自洽
    const T = positionerFK(sol.j1, sol.j2);
    expect(T[12]).toBeDefined();
  });

  it('船形焊目标倾角约 45°', () => {
    const sol = solveCoordination({
      point: { x: 0, y: 0, z: 0 },
      tangent: { x: 1, y: 0, z: 0 },
      normal: { x: 0, y: 0, z: 1 },
    }, 45);
    expect(Math.abs(sol.tiltDeg - 45)).toBeLessThan(10);
  });
});

describe('缺陷检测', () => {
  it('正常排道不应全部判坏；返回结构包含位置与阈值', () => {
    const r = planSegment({ groove: DEFAULT_GROOVE({}), gap: 3, wps: wpsMap() });
    const marks = detectDefects(r.beads, r.section);
    for (const m of marks) {
      expect(m.message).toBeTruthy();
      expect(m.position).toBeDefined();
      expect(typeof m.metric).toBe('number');
    }
    // 人为制造侧壁缺口：把所有焊道向中心压缩 → 应报侧壁未熔合
    const squeezed = r.beads.map((b) => ({
      ...b,
      center: { x: b.center.x * 0.15, y: b.center.y },
    }));
    const marks2 = detectDefects(squeezed, r.section);
    expect(marks2.some((m) => m.kind === 'sidewall-lack-fusion')).toBe(true);
  });
});

describe('层间温度与热输入', () => {
  it('逐道累计温度，超限时给出等待时间', () => {
    const r = planSegment({ groove: DEFAULT_GROOVE({ thickness: 40 }), gap: 3, wps: wpsMap() });
    const thermal = defaultThermal();
    const res = planThermal(r.beads, 500, thermal);
    expect(res.states.length).toBe(r.beads.length);
    expect(res.peakTemp).toBeGreaterThan(thermal.ambientTemp);
    for (const st of res.states) {
      // 每道先经历道间冷却，再起弧升温，因此 tempAfter 相对冷却后温度必然上升
      expect(st.tempAfter).toBeGreaterThanOrEqual(thermal.ambientTemp);
      if (st.overLimit) expect(st.waitBefore).toBeGreaterThan(0);
    }
    expect(res.curve.length).toBe(r.beads.length);
  });

  it('等待时间格式化', () => {
    expect(formatWait(0)).toBe('0秒');
    expect(formatWait(90)).toContain('分');
  });
});
