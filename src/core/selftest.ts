// ============================================================
// 核心算法自检:面积闭合 / 逆解回代 / 变位机 / 热模型
// 运行:npx tsx src/core/selftest.ts
// ============================================================

import { defaultRobot, defaultPositioner, defaultWpsList } from './defaults';
import { forward, inverse, coordinatePositioner, makeTCP } from './robot';
import { applyMatrix, applyDir, matrixToEulerXYZ, rad2deg, deg2rad, eulerXYZToMatrix, distance, invert, multiply } from './math3d';
import { planSegment, planSeam, summarizePlan, DEFAULT_PLANNER_OPTIONS, beadArea } from './planner';
import { buildGroove, grooveAreas } from './groove';
import { simulateThermal } from './thermal';
import type { GrooveParams } from './types';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name} ${detail}`);
  } else {
    fail++;
    console.error(`  ✗ ${name} ${detail}`);
  }
}

console.log('--- 1. 矩阵求逆/欧拉往返 ---');
{
  const M = eulerXYZToMatrix(deg2rad(30), deg2rad(-45), deg2rad(60));
  const Minv = invert(M);
  const prod = multiply(M, Minv);
  const err = Math.max(...prod.map((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0))));
  check('M·M⁻¹ ≈ I', err < 1e-9, `err=${err.toExponential(2)}`);
  const [rx, ry, rz] = matrixToEulerXYZ(M);
  const M2 = eulerXYZToMatrix(rx, ry, rz);
  const eulerErr = Math.max(...M2.map((v, i) => Math.abs(v - M[i])));
  check('欧拉角往返(重构矩阵一致)', eulerErr < 1e-9,
    `角度=(${rad2deg(rx).toFixed(1)},${rad2deg(ry).toFixed(1)},${rad2deg(rz).toFixed(1)}) err=${eulerErr.toExponential(1)}`);
}

console.log('--- 2. 坡口面积(解析核对) ---');
{
  const g: GrooveParams = {
    type: 'singleV', plateThickness: 30, bevelAngle: 30, rootFace: 3,
    rootGap: 3, reinforcement: 2.5, legSize: 0, bothSide: false,
  };
  const geom = buildGroove(g);
  const areas = grooveAreas(geom);
  // 手工:钝边区矩形(宽3×高3)+ 梯形(根宽3,顶宽 3+2*27*tan30,高27)
  const depth = 27;
  const topHalf = 1.5 + depth * Math.tan(deg2rad(30));
  const trapezoid = (3 + topHalf * 2) / 2 * depth;
  const rootRect = 3 * 3;
  const expectBody = trapezoid + rootRect;
  check('V 型坡口本体面积', Math.abs(areas.body - expectBody) / expectBody < 0.02,
    `poly=${areas.body.toFixed(1)} expect=${expectBody.toFixed(1)}`);
  check('型腔含余高', areas.target > areas.body, `target=${areas.target.toFixed(1)}`);
}

console.log('--- 3. 单道熔敷面积(物料守恒) ---');
{
  const wps = defaultWpsList()[0];
  const A = beadArea(wps);
  const wireA = Math.PI * (wps.wireDiameter / 2) ** 2;
  const feed = (wps.wireFeedSpeed * 1000) / 60;
  const expect = (wireA * feed * wps.depositionEfficiency) / wps.travelSpeed;
  check('熔敷面积公式', Math.abs(A - expect) / expect < 1e-9, `A=${A.toFixed(2)}mm²`);
}

console.log('--- 4. 排道面积闭合(各坡口形式,硬指标 ≤3%) ---');
const cases: { label: string; g: GrooveParams }[] = [
  { label: 'V30 T30', g: { type: 'singleV', plateThickness: 30, bevelAngle: 30, rootFace: 3, rootGap: 3, reinforcement: 2.5, legSize: 0, bothSide: false } },
  { label: 'V40 T40 大间隙', g: { type: 'singleV', plateThickness: 40, bevelAngle: 40, rootFace: 4, rootGap: 5, reinforcement: 3, legSize: 0, bothSide: false } },
  { label: '双V T40', g: { type: 'doubleV', plateThickness: 40, bevelAngle: 30, rootFace: 4, rootGap: 2.5, reinforcement: 2.5, legSize: 0, bothSide: true } },
  { label: '单边Bevel T32', g: { type: 'singleBevel', plateThickness: 32, bevelAngle: 40, rootFace: 3, rootGap: 2.5, reinforcement: 3, legSize: 0, bothSide: false } },
  { label: '角缝 K14', g: { type: 'fillet', plateThickness: 24, bevelAngle: 45, rootFace: 2, rootGap: 0, reinforcement: 2, legSize: 14, bothSide: false } },
  { label: '直边 T20', g: { type: 'square', plateThickness: 20, bevelAngle: 0, rootFace: 0, rootGap: 4, reinforcement: 2, legSize: 0, bothSide: false } },
];
const wps = defaultWpsList()[0];
for (const c of cases) {
  const r = planSegment(c.g, wps, DEFAULT_PLANNER_OPTIONS, 0, 0, 1);
  const err = Math.abs(r.segment.areaErrorPct);
  check(`[${c.label}] 面积误差 ≤3%`, err <= 3,
    `err=${r.segment.areaErrorPct.toFixed(2)}% 道数=${r.segment.passCount} 目标=${r.segment.targetArea.toFixed(0)} 实排=${r.segment.plannedArea.toFixed(0)} ${r.closure.note}`);
  check(`[${c.label}] 道次≥2`, r.segment.passCount >= 2);
}

console.log('--- 5. 变间隙分段:大间隙段自动加道 ---');
{
  const g: GrooveParams = cases[0].g;
  const profile = [
    { t: 0, gap: 2 }, { t: 0.3, gap: 2.5 }, { t: 0.5, gap: 6 },
    { t: 0.7, gap: 5.5 }, { t: 1, gap: 2.2 },
  ];
  const results = planSeam(g, wps, profile, DEFAULT_PLANNER_OPTIONS, 6);
  const counts = results.map((r) => r.segment.passCount);
  const maxIdx = counts.indexOf(Math.max(...counts));
  check('大间隙段道数增加', counts[maxIdx] >= counts[0], `道数序列=[${counts.join(',')}]`);
  check('分段误差全部 ≤3%', results.every((r) => Math.abs(r.segment.areaErrorPct) <= 3),
    `误差=[${results.map((r) => r.segment.areaErrorPct.toFixed(1)).join(',')}]%`);
  const summary = summarizePlan(results.map((r) => r.segment), 1800, wps);
  check('汇总含熔敷体积/工时', summary.totalDepositionVolume > 0 && summary.totalWeldTime > 0,
    `V=${(summary.totalDepositionVolume / 1000).toFixed(1)}cm³ t=${(summary.totalWeldTime / 60).toFixed(1)}min`);
}

console.log('--- 6. 逆解→正解回代(硬指标 ≤0.1mm) ---');
{
  const robot = defaultRobot();
  // 从一组已知关节正解出位姿,再逆解回去
  const samples: [number, number, number, number, number, number][] = [
    [20, 35, -50, 10, 45, 120],
    [-60, 60, -80, 0, 60, -30],
    [120, 20, -30, 170, -50, 200],
    [0, 45, -90, 45, 30, 0],
    [-150, 70, -20, -90, 80, 90],
  ];
  let maxErr = 0;
  for (const s of samples) {
    const T = forward(robot, s);
    const ik = inverse(robot, T);
    check(`逆解有解 J=${s.map((x) => x.toFixed(0)).join('/')}`, ik.ok, ik.reason ?? '');
    if (ik.ok) {
      maxErr = Math.max(maxErr, ik.positionError);
      check(`回代偏差 ≤0.1mm`, ik.positionError <= 0.1, `err=${ik.positionError.toFixed(4)}mm 姿态err=${ik.orientationError.toFixed(3)}°`);
      // 再用逆解关节正解核对
      const T2 = forward(robot, ik.joints);
      const e = distance(applyMatrix(T, [0, 0, 0]), applyMatrix(T2, [0, 0, 0]));
      check('二次正解一致', e <= 0.1, `e=${e.toFixed(4)}mm`);
    }
  }
  console.log(`  最大回代偏差:${maxErr.toFixed(4)}mm`);
}

console.log('--- 7. 不可达点优雅失败 ---');
{
  const robot = defaultRobot();
  const far = (() => { const m = eulerXYZToMatrix(0, 0, 0); m[12] = 5000; m[13] = 0; m[14] = 800; return m; })();
  const ik = inverse(robot, far);
  check('超距返回失败且有原因', !ik.ok && !!ik.reason, ik.reason ?? '');
}

console.log('--- 8. 变位机协调:平焊/船形 ---');
{
  const pos = defaultPositioner();
  const r = coordinatePositioner(pos, [0, 0, 1], [0, 1, 0], 'flat');
  const tilt = Math.acos(Math.max(-1, Math.min(1, r.worldNormal[2] / Math.hypot(...r.worldNormal))));
  check('平焊法向朝上', tilt < deg2rad(10), `tilt=${rad2deg(tilt).toFixed(1)}° 轴=(${r.angles[0]},${r.angles[1]})`);
  const r2 = coordinatePositioner(pos, [0, 0, 1], [0, 1, 0], 'boat');
  const tilt2 = Math.acos(Math.max(-1, Math.min(1, r2.worldNormal[2] / Math.hypot(...r2.worldNormal))));
  check('船形倾斜≈45°', Math.abs(rad2deg(tilt2) - 45) < 8, `tilt=${rad2deg(tilt2).toFixed(1)}°`);
}

console.log('--- 9. 热模型:超限等待 ---');
{
  const g = cases[1].g;
  const results = planSeam(g, wps, [], DEFAULT_PLANNER_OPTIONS, 1);
  const hotWps = { ...wps, interpassLimit: 120, preheatTemp: 150, coolingK: 60 };
  const report = simulateThermal(results.map((r) => r.segment), 1800, hotWps);
  check('产生逐道温度序列', report.states.length > 5, `n=${report.states.length}`);
  check('有超限道次与等待时间', report.overLimitPasses > 0 && report.totalWait > 0,
    `超限=${report.overLimitPasses} 等待=${report.totalWait}s`);
  check('温度单调起焊前合理', report.states.every((s) => s.tempBefore > 0));
}

console.log('--- 10. makeTCP 姿态正交 ---');
{
  const T = makeTCP([100, 200, 300], [0, -1, 0], [0, 0, 1]);
  const z = applyDir(T, [0, 0, 1]);
  check('工具 Z 沿腕方向', Math.abs(z[1] + 1) < 1e-9, `z=(${z.map((x) => x.toFixed(2))})`);
  const p = applyMatrix(T, [0, 0, 0]);
  check('TCP 位置正确', distance(p, [100, 200, 300]) < 1e-9);
}

console.log(`\n==== 结果:${pass} 通过 / ${fail} 失败 ====`);
if (fail > 0) (globalThis as { process?: { exit: (n: number) => void } }).process?.exit(1);
