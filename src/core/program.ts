// ============================================================
// 机器人程序生成:排道方案 → 逐道沿缝目标点 → 变位机协调 → 逆解
//  + 碰撞复检 + 过渡路径;以及程序文本/工艺卡导出
// ============================================================

import type {
  PassPlan,
  PositionerConfig,
  RobotConfig,
  RobotProgram,
  RobotTarget,
  WpsParams,
  Workpiece,
} from './types';
import type { Vec3 } from './math3d';
import { uid } from './db';
import {
  applyDir,
  applyMatrix,
  deg2rad,
  matrixToEulerXYZ,
  multiply,
  rad2deg,
  translation,
  type Mat4,
} from './math3d';
import { coordinatePositioner, inverse, makeTCP } from './robot';
import { checkTorchCollision, planTransition, DEFAULT_TORCH, type Box, type PathNode } from './collision';

export interface ProgramGenOptions {
  /** 每条焊道沿长度采样点数 */
  pointsPerPass: number;
  /** 安全抬枪高度 mm */
  liftHeight: number;
  /** 船形焊/平焊 */
  positionerMode: 'flat' | 'boat';
  /** 工件在变位机台面上的安装:焊缝中点对准台面中心的偏移 */
  mountingOffset: Vec3;
}

export const DEFAULT_GEN: ProgramGenOptions = {
  pointsPerPass: 12,
  liftHeight: 60,
  positionerMode: 'boat',
  mountingOffset: [0, 0, 0],
};

/**
 * 由排道方案生成机器人程序。
 * 坐标链:工件截面(x,y)+ 焊缝 z → 工件系;工件系经安装变换到变位机;
 * 变位机矩阵 → 机器人基坐标系;对每个目标做逆解并回代校验。
 */
export function generateProgram(
  plan: PassPlan,
  workpiece: Workpiece,
  robot: RobotConfig,
  positioner: PositionerConfig,
  wps: WpsParams,
  opts: ProgramGenOptions = DEFAULT_GEN,
): { program: RobotProgram; ikErrors: string[] } {
  const seam = workpiece.seams.find((s) => s.id === plan.seamId);
  const ikErrors: string[] = [];
  const targets: RobotTarget[] = [];
  if (!seam) return { program: emptyProgram(plan, robot, positioner), ikErrors: ['未找到关联焊缝'] };

  const seg0 = plan.segments[0];
  // 工件系:焊缝起点为原点,z 沿焊缝
  const seamStart: Vec3 = [...seam.start];
  const seamVec: Vec3 = [seam.end[0] - seam.start[0], seam.end[1] - seam.start[1], seam.end[2] - seam.start[2]];
  const seamLen = Math.hypot(...seamVec);
  const seamDir: Vec3 = [seamVec[0] / seamLen, seamVec[1] / seamLen, seamVec[2] / seamLen];
  // 截面法向(坡口朝上):工件系 +y
  const seamNormal: Vec3 = [0, 1, 0];

  // 安装矩阵:工件装到变位机台面,焊缝中点对中台面中心(长臂件不超工作半径)
  const center: Vec3 = [
    (seam.start[0] + seam.end[0]) / 2,
    (seam.start[1] + seam.end[1]) / 2,
    (seam.start[2] + seam.end[2]) / 2,
  ];
  const mount = translation(-center[0] + opts.mountingOffset[0], -center[1] + opts.mountingOffset[1], -center[2] + opts.mountingOffset[2]);

  // 变位机协调:长直缝用平焊(避免端点甩出臂展),短角缝用船形
  const autoMode: 'flat' | 'boat' = seamLen > 1200 ? 'flat' : opts.positionerMode;
  const coord = coordinatePositioner(positioner, seamDir, seamNormal, autoMode, robot.a2 + robot.a3 + robot.d4);
  const posMatrix = multiply(coord.matrix, mount);

  // 环境碰撞盒:工件板件简化为大盒
  const boxes: Box[] = workpieceBoxes(workpiece, posMatrix);

  let preferred: RobotTarget['joints'] | undefined;
  let transitionLength = 0;
  let lastNode: PathNode | null = null;
  let targetIdx = 0;

  const refSegment = plan.segments.reduce((a, b) => (b.beads.length > a.beads.length ? b : a), seg0);

  for (const bead of refSegment.beads) {
    // 该道在工件系的路径:截面 bead.center + 沿 z 扫描
    for (let k = 0; k < opts.pointsPerPass; k++) {
      const t = k / (opts.pointsPerPass - 1);
      const z = t * seamLen;
      // 截面局部点 → 工件系:焊缝起点 + xLocal*截面x轴 + yLocal*截面y轴
      const localPoint: Vec3 = [
        seamStart[0] + bead.center.x,
        seamStart[1] + bead.center.y,
        seamStart[2] + z,
      ];
      const worldPoint = applyMatrix(posMatrix, localPoint);
      // 焊枪姿态:工作角+行走角(approach 与行走方向严格正交)
      const { approach, travelWorld } = torchAxes(bead.wps.workAngle + bead.aimAngle, bead.wps.travelAngle, posMatrix);
      const tcp = makeTCP(worldPoint, approach, travelWorld);

      const ik = inverse(robot, tcp, preferred);
      const warnings = [...ik.warnings];
      if (!ik.ok && ik.positionError > 0.1) {
        ikErrors.push(`L${bead.layer}P${bead.pass} t=${t.toFixed(2)} 逆解失败:${ik.reason ?? '回代偏差 ' + ik.positionError.toFixed(2) + 'mm'}`);
      }
      if (ik.ok) preferred = ik.joints;

      // 碰撞复检
      const hits = checkTorchCollision(tcp, DEFAULT_TORCH, boxes);
      if (hits.length > 0) {
        warnings.push(`碰撞:${hits[0].object} 深入 ${hits[0].depth.toFixed(1)}mm`);
      }

      const node: PathNode = { pos: worldPoint, workAngle: bead.wps.workAngle, travelAngle: bead.wps.travelAngle };

      // 道间过渡(每条道第一个点)
      if (k === 0 && lastNode) {
        const tp = planTransition(
          lastNode,
          node,
          DEFAULT_TORCH,
          boxes,
          (n) => makeTCP(n.pos, approach, travelWorld),
          opts.liftHeight,
        );
        transitionLength += tp.length;
        if (!tp.collisionFree) warnings.push('过渡路径仍存在碰撞,需人工介入');
        // 记录过渡抬枪点
        for (const tn of tp.nodes.slice(1, -1)) {
          const tTcp = makeTCP(tn.pos, [0, -1, 0], travelWorld);
          const tIk = inverse(robot, tTcp, preferred);
          if (tIk.ok) preferred = tIk.joints;
          targets.push(makeTarget(`T${targetIdx++}`, tn.pos, tTcp, tIk, coord.angles, false, undefined, bead, t, warnings));
        }
      }
      lastNode = node;

      targets.push(
        makeTarget(
          `${bead.role === 'root' ? 'R' : bead.role === 'cap' ? 'C' : 'F'}${bead.pass}-${k}`,
          worldPoint,
          tcp,
          ik,
          coord.angles,
          true,
          wps,
          bead,
          t,
          warnings,
        ),
      );
    }
  }

  // 节拍估算:燃弧时间 + 过渡(按 500mm/s 空程)+ 道间 20s
  const arcTime = refSegment.beads.reduce((s, b) => s + seamLen / b.wps.travelSpeed, 0);
  const airTime = transitionLength / 500;
  const interPass = (refSegment.beads.length - 1) * 20;
  const program: RobotProgram = {
    id: uid('prog'),
    name: `${workpiece.name}-${seam.name}-程序`,
    planId: plan.id,
    workpieceId: workpiece.id,
    robotId: robot.id,
    positionerId: positioner.id,
    createdAt: Date.now(),
    targets,
    transitionLength,
    cycleTime: arcTime + airTime + interPass,
  };
  return { program, ikErrors };
}

function makeTarget(
  name: string,
  pos: Vec3,
  tcp: Mat4,
  ik: ReturnType<typeof inverse>,
  posAng: [number, number],
  arcOn: boolean,
  wps: WpsParams | undefined,
  bead: { layer: number; pass: number },
  t: number,
  warnings: string[],
): RobotTarget {
  const euler = matrixToEulerXYZ(tcp).map(rad2deg) as [number, number, number];
  return {
    id: uid('tgt'),
    name,
    position: pos,
    eulerDeg: euler,
    joints: ik.joints,
    positioner: posAng,
    moveType: arcOn ? 'MOVL' : 'MOVJ',
    speed: arcOn ? (wps?.travelSpeed ?? 7) : 300,
    arcOn,
    wps,
    beadPass: bead.pass,
    warnings: [...new Set(warnings)],
    seamT: t,
    layer: bead.layer,
    pass: bead.pass,
  };
}

/** 焊枪接近方向与正交行走方向(工件系→世界) */
function torchAxes(workAngleDeg: number, travelAngleDeg: number, posMatrix: Mat4): { approach: Vec3; travelWorld: Vec3 } {
  const wa = deg2rad(workAngleDeg);
  const ta = deg2rad(travelAngleDeg);
  const approachLocal: Vec3 = [Math.sin(wa) * Math.cos(ta), -Math.cos(wa) * Math.cos(ta), Math.sin(ta)];
  const travelLocal: Vec3 = [Math.cos(wa), Math.sin(wa), 0];
  return {
    approach: applyDir(posMatrix, approachLocal),
    travelWorld: applyDir(posMatrix, travelLocal),
  };
}

function workpieceBoxes(wp: Workpiece, posMatrix: Mat4): Box[] {
  const boxes: Box[] = [];
  for (const plate of wp.plates) {
    const xs = plate.polygon.map((p) => p.x);
    const ys = plate.polygon.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const localCenter: Vec3 = [(minX + maxX) / 2, (minY + maxY) / 2, wp.extrudeLength / 2];
    boxes.push({
      name: plate.name,
      center: applyMatrix(posMatrix, localCenter),
      half: [(maxX - minX) / 2 + 2, (maxY - minY) / 2 + 2, wp.extrudeLength / 2 + 2],
      rotation: posMatrix,
    });
  }
  return boxes;
}

function emptyProgram(plan: PassPlan, robot: RobotConfig, pos: PositionerConfig): RobotProgram {
  return {
    id: uid('prog'),
    name: '空程序',
    planId: plan.id,
    workpieceId: plan.workpieceId,
    robotId: robot.id,
    positionerId: pos.id,
    createdAt: Date.now(),
    targets: [],
    transitionLength: 0,
    cycleTime: 0,
  };
}

// ---------------- 导出 ----------------

/** 机器人程序文本(类 KUKA/通用六轴格式) */
export function exportProgramText(prog: RobotProgram): string {
  const lines: string[] = [];
  lines.push(`&ACCESS RVP`);
  lines.push(`&REL 1`);
  lines.push(`DEF ${sanitize(prog.name)}( )`);
  lines.push(`; 自动生成 厚板多层多道离线程序  目标点数 ${prog.targets.length}`);
  lines.push(`; 节拍估算 ${prog.cycleTime.toFixed(0)} s  过渡总长 ${prog.transitionLength.toFixed(0)} mm`);
  lines.push(`$BASE = BASE_DATA[1]`);
  lines.push(`$TOOL = TOOL_DATA[1]`);
  let arcGroup = 0;
  for (const t of prog.targets) {
    const j = t.joints.map((x) => x.toFixed(3)).join(', ');
    const p = t.position.map((x) => x.toFixed(2)).join(', ');
    const e = t.eulerDeg.map((x) => x.toFixed(2)).join(', ');
    if (t.arcOn && (prog.targets[prog.targets.indexOf(t) - 1]?.arcOn !== true)) {
      arcGroup++;
      lines.push(`; ---- 焊段 ${arcGroup} L${t.layer}P${t.pass} ----`);
      lines.push(`ARCON WIRE=${t.wps?.wireFeedSpeed ?? 0} V=${t.wps?.voltage ?? 0} A=${t.wps?.current ?? 0}`);
    }
    lines.push(
      `${t.moveType} {X ${p}  E ${e}  S 'B0'}` +
        `  ;J[${j}] POS[${t.positioner[0].toFixed(1)},${t.positioner[1].toFixed(1)}] ${t.name}`,
    );
    if (!t.arcOn && prog.targets[prog.targets.indexOf(t) + 1]?.arcOn !== true && arcGroup > 0 && prog.targets[prog.targets.indexOf(t) - 1]?.arcOn === true) {
      lines.push(`ARCOFF`);
    }
    for (const w of t.warnings) lines.push(`  ;WARN ${w}`);
  }
  lines.push(`ARCOFF`);
  lines.push(`END`);
  return lines.join('\n');
}

/** 工艺卡(纯文本,含每道参数;截面图由 UI 端 Canvas 另导 PNG 合并) */
export function exportWpsCardText(
  plan: PassPlan,
  workpiece: Workpiece,
  wps: WpsParams,
  thermal: { overLimitPasses: number; totalWait: number; maxTemp: number },
): string {
  const seam = workpiece.seams.find((s) => s.id === plan.seamId);
  const seg = plan.segments[0];
  const L: string[] = [];
  L.push('========== 焊接工艺卡(WPS) ==========');
  L.push(`工件:${workpiece.name}    焊缝:${seam?.name ?? '-'}`);
  L.push(`板厚 ${seam?.groove.plateThickness}mm  坡口 ${seam?.groove.type}  角度 ${seam?.groove.bevelAngle}°  钝边 ${seam?.groove.rootFace}mm  间隙 ${seam?.groove.rootGap}mm`);
  L.push(`工艺:${wps.process}  焊丝 φ${wps.wireDiameter}  热效率 ${wps.arcEfficiency}  层间上限 ${wps.interpassLimit}℃`);
  L.push(`焊道总数 ${plan.totalPasses}  层数 ${seg.layerCount}  熔敷体积 ${(plan.totalDepositionVolume / 1000).toFixed(1)} cm³`);
  L.push(`焊丝用量 ${plan.totalWireLength.toFixed(1)} m  燃弧工时 ${(plan.totalWeldTime / 60).toFixed(1)} min  面积闭合误差 ${plan.maxAreaErrorPct.toFixed(2)}%`);
  L.push(`热过程:峰值 ${thermal.maxTemp.toFixed(0)}℃ 超限道次 ${thermal.overLimitPasses} 累计等待 ${thermal.totalWait}s`);
  L.push('');
  L.push('层  道  角色  电流A  电压V  焊速mm/s  摆宽mm  摆频Hz  工作角°  行走角°  起弧点(mm)  收弧点(mm)');
  for (const b of seg.beads) {
    L.push(
      `${b.layer + 1}`.padStart(2) +
        `${b.pass + 1}`.padStart(4) +
        `${b.role}`.padStart(7) +
        `${b.wps.current}`.padStart(7) +
        `${b.wps.voltage}`.padStart(7) +
        `${b.wps.travelSpeed.toFixed(1)}`.padStart(10) +
        `${b.wps.weaveWidth.toFixed(1)}`.padStart(8) +
        `${b.wps.weaveFrequency.toFixed(1)}`.padStart(8) +
        `${b.aimAngle.toFixed(0)}`.padStart(9) +
        `${b.wps.travelAngle}`.padStart(9) +
        `  (${b.center.x.toFixed(1)},${b.center.y.toFixed(1)},0)  (${b.center.x.toFixed(1)},${b.center.y.toFixed(1)},${seam?.length ?? 0})`,
    );
  }
  L.push('');
  L.push('变间隙分段:');
  for (const s of plan.segments) {
    L.push(`  段${s.index + 1} t[${s.t0.toFixed(2)},${s.t1.toFixed(2)}] 间隙${s.gap.toFixed(1)}mm 道数${s.passCount} 面积误差${s.areaErrorPct.toFixed(2)}%`);
  }
  return L.join('\n');
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_一-龥]/g, '_').slice(0, 40);
}
export function downloadText(filename: string, text: string, mime = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Canvas → PNG 下载(工艺卡截面排道图) */
export function downloadCanvas(filename: string, canvas: HTMLCanvasElement): void {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }, 'image/png');
}
