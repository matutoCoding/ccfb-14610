// ============================================================
// 页面3:焊枪姿态 —— 工作角/行走角控制、逆解回代、碰撞标红、最短过渡路径
// ============================================================

import * as THREE from 'three';
import { currentPlan, currentSeam, currentWorkpiece, getState } from '../store';
import { el, clear, field, numInput, badge } from '../ui';
import { Scene3D } from '../viewer';
import { inverse, forward, makeTCP, coordinatePositioner } from '../../core/robot';
import { checkTorchCollision, DEFAULT_TORCH, planTransition, type Box, type PathNode } from '../../core/collision';
import { applyDir, applyMatrix, distance, matrixToEulerXYZ, multiply, rad2deg, translation, type Mat4, type Vec3 } from '../../core/math3d';
import type { BeadPlacement } from '../../core/types';

interface PoseContext {
  tcp: Mat4;
  ik: ReturnType<typeof inverse>;
  posErr: number;
  hits: ReturnType<typeof checkTorchCollision>;
  transition: ReturnType<typeof planTransition>;
  joints: [number, number, number, number, number, number];
  positionerAngles: [number, number];
  euler: number[];
}

export class TorchPage {
  private host: HTMLElement;
  private viewer?: Scene3D;
  private viewHost?: HTMLElement;
  private workAngle = 0;
  private travelAngle = 10;
  private passIdx = 0;
  private segIdx = 0;

  constructor(host: HTMLElement) {
    this.host = host;
    this.render();
  }
  dispose(): void {
    this.viewer?.dispose();
  }

  private render(): void {
    const plan = currentPlan();
    const wp = currentWorkpiece();
    const seam = currentSeam();
    clear(this.host);
    this.host.append(el('h2', { class: 'page-title' }, ['焊枪姿态与碰撞 ', el('small', { text: '工作角/行走角实时驱动逆解,碰撞标红并自动给出最短无碰过渡' })]));
    if (!plan || !wp || !seam) {
      this.host.append(el('div', { class: 'panel', text: '请先在「坡口排道」页生成并选中一个排道方案' }));
      return;
    }
    const layout = el('div', { class: 'layout-3' });
    const left = el('div', { class: 'panel scroll-y' });
    const center = el('div', { class: 'panel' });
    const right = el('div', { class: 'panel scroll-y' });
    layout.append(left, center, right);
    this.host.append(layout);

    const seg = plan.segments[Math.min(this.segIdx, plan.segments.length - 1)];
    const bead = seg.beads[Math.min(this.passIdx, seg.beads.length - 1)];

    left.append(
      el('h3', { text: '姿态控制' }),
      field('分段', numInput(this.segIdx + 1, 1, (v) => { this.segIdx = Math.max(0, Math.min(plan.segments.length - 1, v - 1)); this.render(); }), '段'),
      field('焊道', numInput(this.passIdx + 1, 1, (v) => { this.passIdx = Math.max(0, Math.min(seg.beads.length - 1, v - 1)); this.render(); }), '道'),
      field('工作角', numInput(this.workAngle, 1, (v) => { this.workAngle = v; this.render(); }), '°'),
      field('行走角', numInput(this.travelAngle, 1, (v) => { this.travelAngle = v; this.render(); }), '°'),
      el('div', { class: 'muted', style: 'font-size:11px;line-height:1.7' }, [
        el('div', { text: '工作角:截面内焊丝相对坡口法线的偏向(正=指向右侧壁)' }),
        el('div', { text: '行走角:沿焊缝方向推/拉枪角度(正=推枪)' }),
      ]),
      el('h3', { text: `当前道 L${bead.layer + 1}P${bead.pass + 1} (${bead.role})` }),
      el('div', { class: 'muted', style: 'font-size:11px;line-height:1.7' }, [
        el('div', { html: `中心 (${bead.center.x.toFixed(1)}, ${bead.center.y.toFixed(1)})` }),
        el('div', { html: `半径 ${bead.radius.toFixed(1)}mm · 自动指向角 ${bead.aimAngle.toFixed(0)}°` }),
      ]),
    );

    this.viewHost = el('div', { class: 'canvas-host host-3d' }) as HTMLElement;
    center.append(el('h3', { text: '三维姿态/碰撞视图' }), this.viewHost);

    const ctx = this.compute(bead);
    this.renderRight(right, ctx);
    queueMicrotask(() => {
      this.viewer?.dispose();
      this.viewer = new Scene3D(this.viewHost!);
      this.viewer.showWorkpiece(wp);
      this.viewer.showPositioner(getState().positioner, ctx.positionerAngles);
      this.viewer.showRobot(getState().robot, ctx.joints);
      this.viewer.showTorch(ctx.tcp);
      this.drawTransition(ctx.transition);
    });
  }

  private compute(bead: BeadPlacement): PoseContext {
    const state = getState();
    const wp = currentWorkpiece()!;
    const seam = currentSeam()!;
    const robot = state.robot;
    const pos = state.positioner;

    const seamVec: Vec3 = [seam.end[0] - seam.start[0], seam.end[1] - seam.start[1], seam.end[2] - seam.start[2]];
    const seamLen = Math.hypot(...seamVec);
    const seamDir: Vec3 = [seamVec[0] / seamLen, seamVec[1] / seamLen, seamVec[2] / seamLen];
    const coord = coordinatePositioner(pos, seamDir, [0, 1, 0], seamLen > 1200 ? 'flat' : 'boat');
    // 工件对中:焊缝中点移到变位机台面中心,避免长臂工件两端超出机器人工作半径
    const mount = translation(-(seam.start[0] + seamVec[0] / 2), -(seam.start[1] + seamVec[1] / 2), -seamLen / 2);
    const posMatrix = multiply(coord.matrix, mount);

    const localPoint: Vec3 = [seam.start[0] + bead.center.x, seam.start[1] + bead.center.y, seam.start[2] + seamLen * 0.5];
    const worldPoint = applyMatrix(posMatrix, localPoint);
    // 工作角在截面 XY 平面内偏,行走角绕截面 X 轴倾;approach 与行走方向正交
    const wa = (this.workAngle + bead.aimAngle) * Math.PI / 180;
    const ta = this.travelAngle * Math.PI / 180;
    const approachLocal: Vec3 = [
      Math.sin(wa) * Math.cos(ta),
      -Math.cos(wa) * Math.cos(ta),
      Math.sin(ta),
    ];
    // 行走方向随工作角在 XY 平面旋转,保证与 approach 正交
    const travelLocal: Vec3 = [Math.cos(wa), Math.sin(wa), 0];
    const approach = applyDir(posMatrix, approachLocal);
    const travelWorld = applyDir(posMatrix, travelLocal);
    const tcp = makeTCP(worldPoint, approach, travelWorld);

    const ik = inverse(robot, tcp);
    const fk = ik.ok ? forward(robot, ik.joints) : tcp;
    const posErr = distance(applyMatrix(fk, [0, 0, 0]), worldPoint);

    const boxes: Box[] = wp.plates.map((plate) => {
      const xs = plate.polygon.map((q) => q.x);
      const ys = plate.polygon.map((q) => q.y);
      return {
        name: plate.name,
        center: applyMatrix(posMatrix, [
          (Math.min(...xs) + Math.max(...xs)) / 2,
          (Math.min(...ys) + Math.max(...ys)) / 2,
          wp.extrudeLength / 2,
        ]),
        half: [(Math.max(...xs) - Math.min(...xs)) / 2 + 2, (Math.max(...ys) - Math.min(...ys)) / 2 + 2, wp.extrudeLength / 2 + 2],
        rotation: posMatrix,
      };
    });
    const hits = checkTorchCollision(tcp, DEFAULT_TORCH, boxes);

    const plan = currentPlan()!;
    const seg = plan.segments[Math.min(this.segIdx, plan.segments.length - 1)];
    const nextBead = seg.beads[Math.min(this.passIdx + 1, seg.beads.length - 1)] ?? bead;
    const from: PathNode = { pos: worldPoint, workAngle: this.workAngle, travelAngle: this.travelAngle };
    const nextLocal: Vec3 = [seam.start[0] + nextBead.center.x, seam.start[1] + nextBead.center.y, seam.start[2] + seamLen * 0.5];
    const to: PathNode = { pos: applyMatrix(posMatrix, nextLocal), workAngle: this.workAngle, travelAngle: this.travelAngle };
    const transition = planTransition(from, to, DEFAULT_TORCH, boxes, (n) => makeTCP(n.pos, approach, travelWorld));

    return {
      tcp, ik, posErr, hits, transition, joints: ik.joints,
      positionerAngles: coord.angles, euler: matrixToEulerXYZ(tcp).map(rad2deg),
    };
  }

  private drawTransition(t: { nodes: PathNode[] }): void {
    if (!this.viewer || t.nodes.length < 2) return;
    const pts = t.nodes.map((n) => new THREE.Vector3(n.pos[0], n.pos[1], n.pos[2]));
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffca28 }));
    this.viewer.robotGroup.add(line);
  }

  private renderRight(right: HTMLElement, ctx: PoseContext): void {
    right.append(el('h3', { text: '逆解结果(6R 解析解)' }));
    right.append(
      el('div', { class: 'btnrow' }, [
        ctx.ik.ok ? badge('逆解成功', 'ok') : badge('逆解失败', 'err'),
        badge(`回代偏差 ${ctx.posErr.toFixed(4)} mm`, ctx.posErr <= 0.1 ? 'ok' : 'err'),
      ]),
    );
    right.append(el('table', {}, [
      el('tbody', {}, ctx.joints.map((v, i) => el('tr', {}, [el('td', { text: `J${i + 1}` }), el('td', { text: v.toFixed(2) + '°' })]))),
    ]));
    right.append(el('div', { class: 'muted gap', style: 'font-size:11px', html: `TCP 欧拉角 (${ctx.euler.map((x) => x.toFixed(1)).join(', ')})°` }));

    right.append(el('h3', { text: '变位机协调(船形)' }));
    right.append(el('div', { class: 'muted', html: `轴1 回转 ${ctx.positionerAngles[0].toFixed(1)}° · 轴2 翻转 ${ctx.positionerAngles[1].toFixed(1)}°` }));

    right.append(el('h3', { text: '碰撞检测' }));
    const cw = el('div', { class: 'warnlist' });
    if (ctx.hits.length === 0) cw.append(el('div', { class: 'w ok', text: '焊枪与工件/夹具无碰撞,安全间隙正常' }));
    else ctx.hits.forEach((h) => cw.append(el('div', { class: 'w err', html: `碰撞 ${h.object}:深入 ${h.depth.toFixed(1)}mm @(${h.point.map((x) => x.toFixed(0)).join(',')})` })));
    right.append(cw);

    right.append(el('h3', { text: '最短过渡路径' }));
    right.append(
      el('div', { class: 'btnrow' }, [ctx.transition.collisionFree ? badge('无碰路径已生成', 'ok') : badge('仍有碰撞需人工', 'err')]),
      el('div', { class: 'muted gap', style: 'font-size:11px', html: `路径长 ${ctx.transition.length.toFixed(0)}mm · ${ctx.transition.nodes.length} 个途经点 · 搜索 ${ctx.transition.expanded} 次` }),
      el('div', { class: 'warnlist' }, ctx.transition.nodes.map((n, i) =>
        el('div', { class: 'w', html: `P${i}: (${n.pos.map((x) => x.toFixed(0)).join(', ')}) 抬枪/过渡` }))),
    );

    right.append(el('h3', { text: '奇异/限位警告' }));
    const wl = el('div', { class: 'warnlist' });
    if (ctx.ik.warnings.length === 0) wl.append(el('div', { class: 'w ok', text: '无奇异点与限位风险' }));
    else ctx.ik.warnings.forEach((w) => wl.append(el('div', { class: w.includes('奇异') ? 'w err' : 'w', text: w })));
    right.append(wl);
  }
}
