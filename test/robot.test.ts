import { describe, expect, it } from 'vitest';
import { fk, ikAll, solveIK, DEFAULT_LIMITS } from '../src/core/robot';
import { getTranslation } from '../src/core/mat3d';
import { rad2deg } from '../src/core/geometry';

describe('六轴机器人正逆解', () => {
  it('随机关节角 FK→IK→FK 回差：位置 ≤0.1mm', () => {
    // 选一组远离奇异/限位的关节角
    const seeds = [
      [0.2, -0.3, 0.5, 0.1, 0.6, 0.2],
      [-0.7, 0.4, -0.6, 1.0, -0.8, -0.5],
      [1.1, -0.6, 0.3, -1.2, 0.9, 2.0],
      [0.0, 0.2, 0.9, 0.0, 1.1, 0.0],
    ];
    for (const q of seeds) {
      const T = fk(q);
      const sol = solveIK(T);
      expect(sol.reachable).toBe(true);
      expect(sol.fkRoundTrip.positionErrorMm).toBeLessThanOrEqual(0.1);
      expect(sol.fkRoundTrip.orientationErrorDeg).toBeLessThan(1.0);
      // 逆解再正解位置与原目标一致
      const T2 = fk(sol.joints);
      const p1 = getTranslation(T), p2 = getTranslation(T2);
      expect(Math.hypot(p1.x - p2.x, p1.y - p2.y, p1.z - p2.z)).toBeLessThanOrEqual(0.1);
    }
  });

  it('同一目标最多给出 8 组候选解且全部通过 FK 回差', () => {
    const T = fk([0.3, -0.4, 0.6, 0.2, 0.7, 0.1]);
    const all = ikAll(T);
    expect(all.length).toBeGreaterThan(0);
    expect(all.length).toBeLessThanOrEqual(8);
    const target = getTranslation(T);
    for (const c of all) {
      const p = getTranslation(fk(c.joints));
      expect(Math.hypot(p.x - target.x, p.y - target.y, p.z - target.z)).toBeLessThanOrEqual(0.1);
    }
  });

  it('超出工作空间时返回不可达而非抛异常', () => {
    const far = fk([0, 0, 0]);
    far[12] = 9999; far[13] = 9999; far[14] = 9999;
    const sol = solveIK(far);
    expect(sol.reachable).toBe(false);
    expect(sol.warnings.length).toBeGreaterThan(0);
  });

  it('腕部奇异点（θ5≈0）给出警告', () => {
    const T = fk([0.3, -0.4, 0.6, 0.2, 0.02, 0.1]);
    const sol = solveIK(T);
    const singularWarn = sol.warnings.some((w) => w.includes('奇异'));
    expect(singularWarn || sol.singularity.nearSingular).toBe(true);
  });

  it('关节限位生效', () => {
    const T = fk([0.3, -0.4, 0.6, 0.2, 0.7, 0.1]);
    const tight = {
      ...DEFAULT_LIMITS,
      jMax: DEFAULT_LIMITS.jMax.map((v) => Math.min(v, rad2deg(0.2))),
    };
    const sol = solveIK(T, { limits: tight });
    // 严格限位下应出现越限提示或无可行解
    expect(sol.withinLimits === false || sol.warnings.length > 0).toBe(true);
  });
});
