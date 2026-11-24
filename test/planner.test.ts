import { describe, expect, it } from 'vitest';
import { buildGrooveSection } from '../src/core/groove';
import { DEFAULT_GROOVE } from '../src/core/workpieces';
import { polygonArea } from '../src/core/geometry';
import { planSegment } from '../src/core/planner';
import { defaultWpsSets, depositionArea } from '../src/core/wps';
import type { WpsParams, WpsPassRole } from '../src/core/types';

const wpsMap = (): Record<WpsPassRole, WpsParams> => {
  const list = defaultWpsSets();
  return { root: list[0], fill: list[1], cap: list[2] };
};

describe('坡口截面几何', () => {
  it('V 坡口面积与手算公式一致（误差<1%）', () => {
    const g = DEFAULT_GROOVE({ kind: 'V', thickness: 30, grooveAngleDeg: 30, rootFace: 2, rootGap: 3, reinforcement: 2.5 });
    const sec = buildGrooveSection(g);
    const halfW = 1.5 + 28 * Math.tan(Math.PI / 6);
    // 钝边区：g·p 矩形 + 两侧三角；坡口区：(g+2halfW)/2 · (t-p) 梯形
    const rootArea = g.rootGap * g.rootFace + (halfW - g.rootGap / 2) * g.rootFace;
    const groovePoly = rootArea
      + ((g.rootGap + 2 * halfW) / 2) * (g.thickness - g.rootFace);
    const capArea = (2 / 3) * (2 * halfW) * g.reinforcement;
    const expected = groovePoly + capArea;
    expect(Math.abs(polygonArea(sec.fill) - expected) / expected).toBeLessThan(0.01);
  });

  it.each(['V', 'X', 'U', 'fillet'] as const)('%s 坡口可构建且面积为正', (kind) => {
    const sec = buildGrooveSection(DEFAULT_GROOVE({ kind }));
    expect(sec.requiredArea).toBeGreaterThan(0);
    expect(sec.fill.length).toBeGreaterThan(3);
  });
});

describe('多层多道排道 —— 面积闭环 3% 验收', () => {
  it.each(['V', 'X', 'U', 'fillet'] as const)('%s 坡口排道总面积误差 ≤3%', (kind) => {
    const groove = DEFAULT_GROOVE({ kind });
    const r = planSegment({ groove, gap: groove.rootGap, wps: wpsMap() });
    expect(r.beads.length).toBeGreaterThan(1);
    expect(Math.abs(r.errorPct)).toBeLessThanOrEqual(3.0);
    expect(r.depositedArea).toBeGreaterThan(0);
  });

  it('厚板 50mm X 坡口排道层数 ≥4 且含根焊/填充/盖面', () => {
    const groove = DEFAULT_GROOVE({ kind: 'X', thickness: 50, grooveAngleDeg: 28 });
    const r = planSegment({ groove, gap: 3, wps: wpsMap() });
    expect(r.layers.length).toBeGreaterThanOrEqual(4);
    expect(r.beads.some((b) => b.role === 'root')).toBe(true);
    expect(r.beads.some((b) => b.role === 'cap')).toBe(true);
    expect(r.beads.some((b) => b.role === 'fill')).toBe(true);
    // 道次编号连续
    r.beads.forEach((b, i) => expect(b.index).toBe(i + 1));
  });

  it('间隙加大时自动增加焊道数', () => {
    const groove = DEFAULT_GROOVE({ kind: 'V', thickness: 30 });
    const small = planSegment({ groove, gap: 2, wps: wpsMap() });
    const big = planSegment({ groove, gap: 8, wps: wpsMap() });
    expect(big.beads.length).toBeGreaterThanOrEqual(small.beads.length);
    expect(Math.abs(big.errorPct)).toBeLessThanOrEqual(3.0);
  });

  it('熔敷面积与送丝速度/焊速公式一致', () => {
    const w = wpsMap().fill;
    const wfsMmS = w.wfs * 1000 / 60;
    const wireA = Math.PI * w.wireDiameter ** 2 / 4;
    const expected = (wireA * wfsMmS * w.depositionEfficiency) / w.travelSpeed;
    expect(Math.abs(depositionArea(w) - expected)).toBeLessThan(1e-9);
  });
});
