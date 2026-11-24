import * as THREE from 'three';
import type { Mat4 } from '../core/mat3d';
import { getTranslation } from '../core/mat3d';
import { ROBOT_DH, solveIK, TOOL_LENGTH } from '../core/robot';
import { positionerFK, solveCoordination, torchTargetFrame } from '../core/positioner';
import { avoidTorch, checkTorchCollision, frameToCapsule, type Capsule } from '../core/collision';
import { seamPathFrames } from '../core/workpieces';
import { rad2deg } from '../core/geometry';
import { buildRobotModel, buildWorkpieceMeshes, createScene3D, type Scene3D } from './scene3d';
import { store } from './store';
import { clear, fmt, h } from './dom';

export function renderTorchPage(root: HTMLElement): void {
  clear(root);
  const wp = store.currentWorkpiece();
  const seam = store.currentSeam();
  if (!wp || !seam) {
    root.append(h('div', { class: 'panel empty' }, '请先在「工件库」选择工件和焊缝'));
    return;
  }

  const host = h('div', { class: 'canvas-host', style: { height: '560px' } }) as HTMLDivElement;
  const info = h('div', {});
  const workAngle = h('input', { type: 'range', min: '60', max: '120', value: '90' }) as HTMLInputElement;
  const travelAngle = h('input', { type: 'range', min: '-30', max: '15', value: '-10' }) as HTMLInputElement;
  const sPos = h('input', { type: 'range', min: '0', max: '100', value: '10' }) as HTMLInputElement;
  let scene: Scene3D | null = null;
  let robot: ReturnType<typeof buildRobotModel> | null = null;
  const markerGroup = new THREE.Group();

  const update = (): void => {
    if (!scene || !robot) return;
    markerGroup.clear();
    const frames = seamPathFrames(seam, 24);
    const fi = Math.min(frames.length - 1, Math.round((Number(sPos.value) / 100) * (frames.length - 1)));
    const f = frames[fi];
    const coord = solveCoordination(
      { point: f.point, tangent: f.tangent, normal: f.normal },
      seam.groove.kind === 'fillet' ? 45 : 0,
    );
    void positionerFK(coord.j1, coord.j2);
    const target: Mat4 = torchTargetFrame(
      coord.worldPoint, coord.worldTangent, coord.worldNormal,
      Number(workAngle.value), Number(travelAngle.value), 18);
    const ik = solveIK(target);
    robot.update(ik.joints, TOOL_LENGTH);

    const torch: Capsule = frameToCapsule(getTranslation(target), target, 12, TOOL_LENGTH);
    const hits = checkTorchCollision(torch, wp.solids, []);
    const collision = hits.length > 0;
    let avoidInfo = '';
    if (collision) {
      const approach = { x: target[8], y: target[9], z: target[10] };
      const av = avoidTorch(getTranslation(target), getTranslation(target), approach, wp.solids, 12, TOOL_LENGTH);
      avoidInfo = `碰撞！自动抬枪避让 ${av.iterations} 次，安全裕量 ${fmt(av.clearance, 1)}mm，过渡路径 ${av.path.length} 个节点`;
      for (const p of av.path) {
        const sph = new THREE.Mesh(
          new THREE.SphereGeometry(14, 10, 10),
          new THREE.MeshBasicMaterial({ color: 0xf0a93b }));
        sph.position.set(p.x, p.y, p.z);
        markerGroup.add(sph);
      }
      void av;
    }
    renderInfo(info, ik, coord.tiltDeg, collision, avoidInfo, hits.map((x) => x.clearance));
  };

  root.append(
    h('div', { class: 'panel' },
      h('h2', {}, '焊枪姿态与碰撞检测 ', h('span', { class: 'tag' }, '六轴逆解 + 双轴变位机协调 + OBB 碰撞/自动避碰')),
      h('div', { class: 'grid-side' },
        h('div', {},
          slider('工作角（90°=垂直坡口）', workAngle, '°'),
          slider('行走角（负=拖枪）', travelAngle, '°'),
          slider('沿焊缝位置', sPos, '%'),
          h('button', { class: 'ghost', style: { marginTop: '8px' }, onclick: update }, '重新计算'),
        ),
        h('div', { class: 'canvas-host', style: { height: '560px' } }, host),
      ),
      info,
    ),
  );

  requestAnimationFrame(() => {
    scene = createScene3D(host);
    scene.group.add(buildWorkpieceMeshes(wp.solids));
    robot = buildRobotModel(ROBOT_DH);
    scene.group.add(robot.root);
    scene.group.add(markerGroup);
    update();
  });
  [workAngle, travelAngle, sPos].forEach((el) => el.addEventListener('input', update));
}

function renderInfo(
  host: HTMLElement,
  ik: ReturnType<typeof solveIK>,
  tiltDeg: number, collision: boolean, avoidInfo: string, clearances: number[],
): void {
  clear(host);
  const jDeg = ik.joints.map((j) => fmt(rad2deg(j), 1));
  const warnBlock = h('div', { style: { marginTop: '10px' } },
    ...ik.warnings.map((w) =>
      h('span', {
        class: `badge ${w.includes('奇异') || w.includes('越限') ? 'bad' : 'warn'}`,
        style: { marginRight: '6px' },
      }, w)));
  const avoidBlock = avoidInfo
    ? h('div', { class: 'badge warn', style: { marginTop: '10px' } }, avoidInfo)
    : null;
  const block = h('div', {},
    h('div', { class: 'grid-3', style: { marginTop: '12px' } },
      kpi(ik.fkRoundTrip.positionErrorMm <= 0.1 ? 'ok' : 'bad',
        fmt(ik.fkRoundTrip.positionErrorMm, 4), 'FK(IK) 位置回差 mm（验收 ≤0.1）'),
      kpi(ik.withinLimits ? 'ok' : 'bad', fmt(ik.limitMarginDeg, 1), '最小关节限位裕量 °'),
      kpi(ik.singularity.nearSingular ? 'warn' : 'ok',
        fmt(ik.singularity.condition, 0), '雅可比条件数（>500 近奇异）'),
      kpi('info', fmt(tiltDeg, 1), '变位机平焊倾角 °'),
      kpi(collision ? 'bad' : 'ok', collision ? '碰撞' : '安全',
        clearances.length ? `最小净距 ${fmt(Math.min(...clearances), 1)}mm` : '净距 ≥2mm'),
      kpi('info', jDeg.join(' / '), '六关节角 °（J1~J6）'),
    ),
    ik.warnings.length ? warnBlock : null,
    avoidBlock,
  );
  host.append(block);
}

function kpi(cls: string, v: string, l: string): HTMLElement {
  return h('div', { class: `kpi ${cls}` },
    h('div', { class: 'v', style: { fontSize: '15px' } }, v), h('div', { class: 'l' }, l));
}

function slider(label: string, input: HTMLInputElement, unit: string): HTMLElement {
  const val = h('span', { class: 'mono' }, input.value + unit);
  input.addEventListener('input', () => { val.textContent = input.value + unit; });
  return h('label', { class: 'field' }, h('span', {}, label, ' ', val), input);
}
