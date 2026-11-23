// ============================================================
// 页面4:离线仿真 —— 时间轴拖动,机器人/变位机/焊枪联动,焊道逐道生长
// ============================================================

import * as THREE from 'three';
import { currentPlan, currentSeam, currentWorkpiece, getState, saveProgram } from '../store';
import { el, clear, badge } from '../ui';
import { Scene3D } from '../viewer';
import { generateProgram, DEFAULT_GEN } from '../../core/program';
import { forward } from '../../core/robot';
import { applyMatrix, eulerXYZToMatrix, deg2rad } from '../../core/math3d';
import type { RobotProgram } from '../../core/types';

export class SimulationPage {
  private host: HTMLElement;
  private viewer?: Scene3D;
  private viewHost?: HTMLElement;
  private program: RobotProgram | null = null;
  private slider?: HTMLInputElement;
  private timeLabel?: HTMLElement;
  private playing = false;
  private timer = 0;

  constructor(host: HTMLElement) {
    this.host = host;
    this.render();
  }
  dispose(): void {
    this.viewer?.dispose();
    clearInterval(this.timer);
  }

  private render(): void {
    const plan = currentPlan();
    const wp = currentWorkpiece();
    const seam = currentSeam();
    clear(this.host);
    this.host.append(el('h2', { class: 'page-title' }, ['离线仿真 ', el('small', { text: '机器人+双轴变位机协调运动,焊道随时间逐道长出,扫掠网格带鱼鳞纹' })]));
    if (!plan || !wp || !seam) {
      this.host.append(el('div', { class: 'panel', text: '请先在「坡口排道」页生成并选中方案' }));
      return;
    }
    const wps = getState().wpsList.find((x) => x.id === plan.wpsId) ?? getState().wpsList[0]!;

    const layout = el('div', { class: 'layout' });
    const left = el('div', { class: 'panel scroll-y' });
    const right = el('div', { class: 'panel' });
    layout.append(left, right);
    this.host.append(layout);

    left.append(
      el('h3', { text: '程序生成与仿真' }),
      el('div', { class: 'muted', style: 'font-size:11px;line-height:1.8' }, [
        el('div', { html: `方案:${plan.name}` }),
        el('div', { html: `目标点按每道 12 点采样,逐点逆解+碰撞复检` }),
      ]),
      el('div', { class: 'btnrow' }, [
        el('button', {
          class: 'primary', text: this.program ? '重新生成机器人程序' : '生成机器人程序',
          onclick: () => {
            const { program, ikErrors } = generateProgram(plan, wp, getState().robot, getState().positioner, wps, DEFAULT_GEN);
            this.program = program;
            void saveProgram(program);
            this.render();
            if (ikErrors.length) alert('逆解告警:\n' + ikErrors.slice(0, 8).join('\n'));
          },
        }),
      ]),
    );

    if (this.program) {
      const p = this.program;
      const warnCount = p.targets.filter((t) => t.warnings.length).length;
      left.append(
        el('h3', { text: '程序信息' }),
        el('div', { class: 'metrics' }, [
          metric(String(p.targets.length), '目标点'),
          metric((p.cycleTime / 60).toFixed(1), '节拍 min'),
          metric((p.transitionLength / 1000).toFixed(1), '过渡 m'),
        ]),
        el('div', { class: 'btnrow' }, [
          warnCount ? badge(`${warnCount} 点带警告`, 'warn') : badge('全部点位无警告', 'ok'),
        ]),
        el('h3', { text: '目标点列表(前 30)' }),
        el('div', { class: 'tablewrap' }, [
          el('table', {}, [
            el('thead', {}, [el('tr', {}, ['点', '类型', 'L/P', '关节 J1/J3/J5', '警告'].map((h) => el('th', { text: h })))]),
            el('tbody', {}, p.targets.slice(0, 30).map((t) => el('tr', {}, [
              el('td', { text: t.name }),
              el('td', { text: t.moveType + (t.arcOn ? '🔥' : '') }),
              el('td', { text: `${(t.layer ?? 0) + 1}/${(t.pass ?? 0) + 1}` }),
              el('td', { style: 'font-size:10.5px', text: `${t.joints[0].toFixed(0)}/${t.joints[2].toFixed(0)}/${t.joints[4].toFixed(0)}` }),
              el('td', {}, t.warnings[0] ? badge(t.warnings[0].slice(0, 12), 'warn') : badge('OK', 'ok')),
            ]))),
          ]),
        ]),
      );
    } else {
      left.append(el('p', { class: 'muted', text: '生成程序后即可拖动时间轴仿真' }));
    }

    this.viewHost = el('div', { class: 'canvas-host host-3d' }) as HTMLElement;
    right.append(el('h3', { text: '三维仿真场景' }), this.viewHost);
    queueMicrotask(() => {
      this.viewer?.dispose();
      this.viewer = new Scene3D(this.viewHost!);
      this.viewer.showWorkpiece(wp);
      // 已完成焊道(初始空)
      const refSeg = plan.segments.reduce((a, b) => (b.beads.length > a.beads.length ? b : a), plan.segments[0]);
      this.viewer.showBeads(refSeg.beads, seam.start, seam.end, -1);
      if (this.program) {
        this.viewer.showPositioner(getState().positioner, this.program.targets[0]?.positioner ?? [0, 0]);
        this.viewer.showRobot(getState().robot, this.program.targets[0]?.joints ?? [0, 0, 0, 0, 0, 0]);
      }
    });

    // 时间轴
    const maxIdx = Math.max(0, (this.program?.targets.length ?? 1) - 1);
    this.slider = el('input', { type: 'range', min: 0, max: maxIdx, value: 0, oninput: (e) => this.seek(parseInt((e.target as HTMLInputElement).value)) }) as HTMLInputElement;
    this.timeLabel = el('div', { class: 't', text: '点 0 / ' + maxIdx });
    const bar = el('div', { class: 'timeline' }, [
      el('button', { id: 'playbtn', text: '▶ 播放', onclick: () => this.togglePlay() }),
      this.slider,
      this.timeLabel,
    ]);
    right.append(bar);
  }

  private togglePlay(): void {
    if (!this.program) return;
    this.playing = !this.playing;
    const btn = document.getElementById('playbtn') as HTMLButtonElement;
    btn.textContent = this.playing ? '⏸ 暂停' : '▶ 播放';
    clearInterval(this.timer);
    if (this.playing) {
      this.timer = window.setInterval(() => {
        const cur = parseInt(this.slider!.value);
        const max = parseInt(this.slider!.max);
        if (cur >= max) {
          this.playing = false;
          btn.textContent = '▶ 播放';
          clearInterval(this.timer);
          return;
        }
        this.slider!.value = String(cur + 1);
        this.seek(cur + 1);
      }, 120);
    }
  }

  private seek(idx: number): void {
    if (!this.program || !this.viewer) return;
    const t = this.program.targets[idx];
    if (!t) return;
    this.timeLabel!.textContent = `点 ${idx} / ${this.program.targets.length - 1} · ${t.arcOn ? '燃弧 L' + (t.layer! + 1) + 'P' + (t.pass! + 1) : '空程过渡'}`;
    this.viewer.showPositioner(getState().positioner, t.positioner);
    this.viewer.showRobot(getState().robot, t.joints);
    const fk = forward(getState().robot, t.joints);
    this.viewer.showTorch(fk);
    // 焊道生长:已完成的焊道数(按 pass)
    const plan = currentPlan()!;
    const seam = currentSeam()!;
    const refSeg = plan.segments.reduce((a, b) => (b.beads.length > a.beads.length ? b : a), plan.segments[0]);
    const grownPass = t.arcOn ? (t.pass ?? 0) : -1;
    this.viewer.showBeads(refSeg.beads, seam.start, seam.end, grownPass);
    void eulerXYZToMatrix;
    void deg2rad;
    void applyMatrix;
    void THREE;
  }
}

function metric(v: string, k: string): HTMLElement {
  return el('div', { class: 'metric' }, [el('div', { class: 'v', text: v }), el('div', { class: 'k', text: k })]);
}
