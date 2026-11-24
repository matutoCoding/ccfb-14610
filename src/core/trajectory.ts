import type { PlannedBead, RobotProgramLine, Vec3 } from './types';
import { getTranslation, type Mat4 } from './mat3d';
import { rad2deg } from './geometry';

export interface SeamFrame {
  s: number;              // 沿焊缝归一化 0~1
  point: Vec3;            // 世界系焊缝点
  tangent: Vec3;
  normal: Vec3;
  positionerJ1: number;
  positionerJ2: number;
}

export interface TrajectoryKey {
  id: string;
  kind: 'approach' | 'weld' | 'retract' | 'transition';
  beadIndex?: number;
  frame: Mat4;            // 机器人 TCP 目标
  posJ1: number;
  posJ2: number;
  joints: number[];       // 逆解结果
  speed: number;          // mm/s（焊接段=焊速，空走=移动速度）
  weave?: { width: number; freq: number };
  arcOn: boolean;
  warnings: string[];
}

export interface BuiltTrajectory {
  keys: TrajectoryKey[];
  weldLength: number;
  airLength: number;
  arcTime: number;
  airTime: number;
}

const APPROACH_SPEED = 120;
const RETRACT_HEIGHT = 25;

/**
 * 把每道焊缝帧序列 + 逆解器回调组装成完整机器人轨迹。
 * ikFn 由 UI/仿真层注入（核心模块不依赖 three.js）。
 */
export function buildTrajectory(args: {
  beads: PlannedBead[];
  framesPerBead: SeamFrame[][];
  targetFrameAt: (f: SeamFrame, b: PlannedBead) => Mat4;
  ikFn: (target: Mat4, preferred: number[] | undefined) => { joints: number[]; warnings: string[] };
  transitionFn?: (from: Vec3, to: Vec3) => Vec3[];
}): BuiltTrajectory {
  const { beads, framesPerBead, targetFrameAt, ikFn } = args;
  const keys: TrajectoryKey[] = [];
  let preferred: number[] | undefined;
  let weldLength = 0, airLength = 0, arcTime = 0, airTime = 0;
  let prevEnd: Vec3 | null = null;

  beads.forEach((b, bi) => {
    const frames = framesPerBead[bi] ?? [];
    if (!frames.length) return;

    // 过渡到本道起点上方
    const first = frames[0];
    const startTarget = targetFrameAt(first, b);
    const startP = getTranslation(startTarget);
    if (prevEnd) {
      const viaPts = args.transitionFn ? args.transitionFn(prevEnd, startP) : [midLift(prevEnd, startP)];
      for (const vp of viaPts) {
        const lifted = liftFrame(startTarget, vp);
        const sol = ikFn(lifted, preferred);
        preferred = sol.joints;
        keys.push({
          id: `k-${keys.length}`, kind: 'transition', frame: lifted,
          posJ1: first.positionerJ1, posJ2: first.positionerJ2,
          joints: sol.joints, speed: APPROACH_SPEED, arcOn: false, warnings: sol.warnings,
        });
        airLength += dist(prevEnd, vp);
      }
    }

    // 起弧接近
    const approach = liftFrameAt(startTarget, first, RETRACT_HEIGHT);
    const solApp = ikFn(approach, preferred);
    preferred = solApp.joints;
    keys.push({
      id: `k-${keys.length}`, kind: 'approach', beadIndex: b.index, frame: approach,
      posJ1: first.positionerJ1, posJ2: first.positionerJ2,
      joints: solApp.joints, speed: APPROACH_SPEED, arcOn: false, warnings: solApp.warnings,
    });

    // 焊接段
    frames.forEach((f, fi) => {
      const target = targetFrameAt(f, b);
      const sol = ikFn(target, preferred);
      preferred = sol.joints;
      if (fi > 0) {
        const prev = getTranslation(keys[keys.length - 1].frame);
        weldLength += dist(prev, getTranslation(target));
      }
      keys.push({
        id: `k-${keys.length}`, kind: 'weld', beadIndex: b.index, frame: target,
        posJ1: f.positionerJ1, posJ2: f.positionerJ2,
        joints: sol.joints, speed: b.travelSpeed, arcOn: true,
        weave: b.weaveWidth > 0 ? { width: b.weaveWidth, freq: b.weaveFreq } : undefined,
        warnings: sol.warnings,
      });
    });
    arcTime += frames.length > 1
      ? weldLength / Math.max(b.travelSpeed, 0.01) // 累计后统一算也可，这里保留每道近似
      : 0;

    // 收弧抬枪
    const last = frames[frames.length - 1];
    const endTarget = targetFrameAt(last, b);
    const retract = liftFrameAt(endTarget, last, RETRACT_HEIGHT);
    const solRet = ikFn(retract, preferred);
    preferred = solRet.joints;
    keys.push({
      id: `k-${keys.length}`, kind: 'retract', beadIndex: b.index, frame: retract,
      posJ1: last.positionerJ1, posJ2: last.positionerJ2,
      joints: solRet.joints, speed: APPROACH_SPEED, arcOn: false, warnings: solRet.warnings,
    });
    prevEnd = getTranslation(retract);
  });

  // 工时按段长度/速度重算（更准）
  for (let i = 1; i < keys.length; i++) {
    const d = dist(getTranslation(keys[i - 1].frame), getTranslation(keys[i].frame));
    if (keys[i].kind === 'weld') arcTime += d / Math.max(keys[i].speed, 0.01);
    else airTime += d / APPROACH_SPEED;
  }
  airLength = keys.filter((k) => !k.arcOn).reduce((s, k, i, arr) => {
    if (i === 0) return 0;
    return s + (arr[i].kind === 'weld' ? 0 : dist(getTranslation(arr[i - 1].frame), getTranslation(k.frame)));
  }, 0);

  return { keys, weldLength, airLength, arcTime, airTime };
}

const dist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const midLift = (a: Vec3, b: Vec3): Vec3 => ({
  x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: Math.max(a.z, b.z) + 80,
});

function liftFrame(frame: Mat4, toPoint: Vec3): Mat4 {
  const m = frame.slice();
  m[12] = toPoint.x; m[13] = toPoint.y; m[14] = toPoint.z;
  return m;
}
function liftFrameAt(frame: Mat4, f: SeamFrame, height: number): Mat4 {
  const m = frame.slice();
  m[12] += f.normal.x * height;
  m[13] += f.normal.y * height;
  m[14] += f.normal.z * height;
  return m;
}

/** 机器人程序文本导出（通用六轴+双轴变位机格式，可按现场控制器改模板） */
export function exportRobotProgram(traj: BuiltTrajectory, programName: string): string {
  const lines: RobotProgramLine[] = [];
  let n = 1;
  const emit = (text: string, kind: RobotProgramLine['kind'], beadIndex?: number): void => {
    lines.push({ lineNo: n++, text, kind, beadIndex });
  };
  emit(`// PROGRAM ${programName}  厚板多层多道自动生成`, 'comment');
  emit(`// 关键帧 ${traj.keys.length}  焊接时长 ${traj.arcTime.toFixed(0)}s  空走 ${traj.airTime.toFixed(0)}s`, 'comment');
  emit('SET TOOL[1] ON; SET USERFRAME[1] ON; SPEED 120 mm/s', 'comment');

  traj.keys.forEach((k) => {
    const j = k.joints.map((x) => rad2deg(x).toFixed(3));
    const p = getTranslation(k.frame);
    if (k.kind === 'approach') emit(`! ---- 第${k.beadIndex}道 起弧接近 ----`, 'comment', k.beadIndex);
    if (k.kind === 'retract') emit(`! ---- 第${k.beadIndex}道 收弧 ----`, 'comment', k.beadIndex);
    if (k.weave) emit(`WEAVE ON AMP=${(k.weave.width / 2).toFixed(2)} FREQ=${k.weave.freq.toFixed(2)}`, 'weave', k.beadIndex);
    emit(
      `MOVEL P[${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}] ` +
      `J[${j.join(',')}] E1[${rad2deg(k.posJ1).toFixed(2)}] E2[${rad2deg(k.posJ2).toFixed(2)}] V=${k.speed.toFixed(1)}`,
      'move', k.beadIndex,
    );
    if (k.arcOn && traj.keys[traj.keys.indexOf(k) - 1]?.arcOn !== true) emit('ARCON', 'arc-on', k.beadIndex);
    if (!k.arcOn && traj.keys[traj.keys.indexOf(k) - 1]?.arcOn === true) emit('ARCOFF', 'arc-off', k.beadIndex);
  });
  emit('END', 'comment');
  return lines.map((l) => `${String(l.lineNo).padStart(4, ' ')}  ${l.text}`).join('\n');
}
