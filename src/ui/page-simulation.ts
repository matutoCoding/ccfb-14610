import * as THREE from 'three';
import type { Mat4 } from '../core/mat3d';
import { getTranslation } from '../core/mat3d';
import { ROBOT_DH, solveIK, TOOL_LENGTH } from '../core/robot';
import { positionerFK, solveCoordination, torchTargetFrame } from '../core/positioner';
import { seamPathFrames } from '../core/workpieces';
import { buildBeadSweep, buildRobotModel, buildWorkpieceMeshes, createScene3D, type Scene3D } from './scene3d';
import { store } from './store';
import { clear, fmt, h } from './dom';
import { rad2deg } from '../core/geometry';
import type { PlannedBead } from '../core/types';

export function renderSimulationPage(root: HTMLElement): void {
  clear(root);
  const wp = store.currentWorkpiece();
  const seam = store.currentSeam();
  const scheme = store.currentScheme();
  if (!wp || !seam || !scheme) {
    root.append(h('div', { class: 'panel empty' }, '请先完成排道并保存方案，再进入离线仿真'));
    return;
  }

  // 汇总所有段的焊道（取中部分段几何作为代表，沿整条焊缝扫掠）
  const midSeg = scheme.segments[Math.floor(scheme.segments.length / 2)];
  const beads = midSeg.beads;
  const host = h('div', { class: 'canvas-host', style: { height: '520px' } }) as HTMLDivElement;
  const timeLabel = h('span', { class: 'mono' }, '0%');
  const slider = h('input', { type: 'range', min: '0', max: '1000', value: '0' }) as HTMLInputElement;
  const playBtn = h('button', {}, '播放') as HTMLButtonElement;
  const stateLine = h('div', { class: 'muted mono', style: { fontSize: '11px' } });

  let scene: Scene3D | null = null;
  let robot: ReturnType<typeof buildRobotModel> | null = null;
  const beadGroup = new THREE.Group();
  let playing = false;
  let raf = 0;

  // 预计算每道焊缝的世界路径帧 + 目标位姿 + 逆解
  interface BeadTrack {
    bead: PlannedBead;
    keys: { target: Mat4; joints: number[]; point: { x: number; y: number; z: number } }[];
    sweep: THREE.Mesh;
  }
  const tracks: BeadTrack[] = [];
  const pathFrames = seamPathFrames(seam, 30);

  const buildTracks = (): void => {
    if (!scene) return;
    beadGroup.clear();
    tracks.length = 0;
    for (const bead of beads) {
      const keys = pathFrames.map((f) => {
        const coord = solveCoordination(
          { point: f.point, tangent: f.tangent, normal: f.normal },
          seam.groove.kind === 'fillet' ? 45 : 0);
        const target = torchTargetFrame(
          coord.worldPoint, coord.worldTangent, coord.worldNormal,
          bead.workAngleDeg, bead.travelAngleDeg, 18);
        const ik = solveIK(target);
        return { target, joints: ik.joints, point: getTranslation(target) };
      });
      // 扫掠路径（沿焊缝 x 方向平移焊道截面中心）
      const sweepPath = pathFrames.map((f) => ({
        x: f.point.x,
        y: f.point.y + (bead.center.x || 0) * 0.3,
        z: f.point.z + bead.center.y * 0.3,
      }));
      const sweep = buildBeadSweep(sweepPath, bead, { ripples: true, progress: 0 });
      sweep.visible = false;
      beadGroup.add(sweep);
      tracks.push({ bead, keys, sweep });
    }
  };

  const applyTime = (tNorm: number): void => {
    if (!robot || !tracks.length) return;
    const total = tracks.length;
    const progressed = tNorm * total;
    let currentIdx = Math.min(total - 1, Math.floor(progressed));
    const innerT = progressed - currentIdx;
    tracks.forEach((tr, i) => {
      if (i < currentIdx) {
        tr.sweep.visible = true;
        tr.sweep.geometry.dispose();
        const p = tr.bead;
        const fresh = buildBeadSweep(
          pathFrames.map((f) => ({ x: f.point.x, y: f.point.y + (p.center.x || 0) * 0.3, z: f.point.z + p.center.y * 0.3 })),
          p, { ripples: true, progress: 1 });
        tr.sweep.geometry = fresh.geometry;
      } else if (i === currentIdx) {
        tr.sweep.visible = true;
        const p = tr.bead;
        const fresh = buildBeadSweep(
          pathFrames.map((f) => ({ x: f.point.x, y: f.point.y + (p.center.x || 0) * 0.3, z: f.point.z + p.center.y * 0.3 })),
          p, { ripples: true, progress: Math.max(0.02, innerT) });
        tr.sweep.geometry.dispose();
        tr.sweep.geometry = fresh.geometry;
        // 机器人跟随当前道当前位置
        const ki = Math.min(tr.keys.length - 1, Math.round(innerT * (tr.keys.length - 1)));
        robot!.update(tr.keys[ki].joints, TOOL_LENGTH);
      } else {
        tr.sweep.visible = false;
      }
    });
    const cur = tracks[currentIdx];
    if (cur) {
      stateLine.textContent =
        `第 ${currentIdx + 1}/${total} 道（${cur.bead.role === 'root' ? '根焊' : cur.bead.role === 'cap' ? '盖面' : '填充'}）` +
        `  全局道次号 ${cur.bead.index}  关节 J1~J6：${cur.keys[0].joints.map((j) => rad2deg(j).toFixed(0) + '°').join(' ')}` +
        `  焊速 ${cur.bead.travelSpeed.toFixed(1)}mm/s  摆宽 ${cur.bead.weaveWidth}mm`;
    }
  };

  slider.addEventListener('input', () => {
    const t = Number(slider.value) / 1000;
    timeLabel.textContent = `${(t * 100).toFixed(0)}%`;
    applyTime(t);
  });

  const tick = (): void => {
    if (!playing) return;
    let v = Number(slider.value) + 4;
    if (v >= 1000) { v = 1000; playing = false; playBtn.textContent = '播放'; }
    slider.value = String(v);
    timeLabel.textContent = `${((v / 1000) * 100).toFixed(0)}%`;
    applyTime(v / 1000);
    raf = requestAnimationFrame(tick);
  };
  playBtn.addEventListener('click', () => {
    playing = !playing;
    playBtn.textContent = playing ? '暂停' : '播放';
    if (playing) { if (Number(slider.value) >= 1000) slider.value = '0'; tick(); }
    else cancelAnimationFrame(raf);
  });

  root.append(
    h('div', { class: 'panel' },
      h('h2', {}, '离线仿真 ', h('span', { class: 'tag' }, `机器人 + 变位机联动，${beads.length} 道焊道逐道生长，扫掠网格+鱼鳞纹`)),
      h('div', { class: 'canvas-host', style: { height: '520px' } }, host),
      h('div', { class: 'timeline', style: { marginTop: '12px' } },
        playBtn, slider, timeLabel),
      stateLine,
      h('div', { class: 'grid-3', style: { marginTop: '12px' } },
        kpi(`${scheme.segments.length}`, '变间隙分段数'),
        kpi(fmt(scheme.totalArcTime / 60, 1), '总焊接工时 min'),
        kpi(fmt(scheme.totalDepositionVolume / 1e6, 2), '熔敷体积 L')),
    ),
  );

  requestAnimationFrame(() => {
    scene = createScene3D(host);
    scene.group.add(buildWorkpieceMeshes(wp.solids));
    robot = buildRobotModel(ROBOT_DH);
    scene.group.add(robot.root);
    scene.group.add(beadGroup);
    buildTracks();
    applyTime(0);
  });
}

function kpi(v: string, l: string): HTMLElement {
  return h('div', { class: 'kpi' }, h('div', { class: 'v', style: { fontSize: '18px' } }, v), h('div', { class: 'l' }, l));
}
