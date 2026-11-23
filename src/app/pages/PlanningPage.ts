// ============================================================
// 页面2:坡口排道 —— 自动多层多道 / 面积闭合校核 / 变间隙分段 / 方案对比
// ============================================================

import type { PassPlan, WpsParams } from '../../core/types';
import { DEFAULT_PLANNER_OPTIONS, planSeam, summarizePlan, type PlannerOptions, type PlanResult } from '../../core/planner';
import { buildGroove } from '../../core/groove';
import { getState, currentWorkpiece, currentSeam, currentWps, savePlan, removePlan, update } from '../store';
import { uid } from '../../core/db';
import { el, clear, field, numInput, badge, drawGrooveSection, drawChart, beadColor } from '../ui';

export class PlanningPage {
  private host: HTMLElement;
  private results: PlanResult[] = [];
  private segIdx = 0;
  private opts: PlannerOptions = { ...DEFAULT_PLANNER_OPTIONS };
  private plan: PassPlan | null = null;
  private canvas?: HTMLCanvasElement;
  private comparePlans: PassPlan[] = [];

  constructor(host: HTMLElement) {
    this.host = host;
    this.render();
  }

  private render(): void {
    const s = getState();
    const wp = currentWorkpiece();
    const seam = currentSeam();
    const wps = currentWps();
    clear(this.host);
    this.host.append(el('h2', { class: 'page-title' }, ['坡口多层多道排道 ', el('small', { text: '按送丝/焊速守恒算熔敷面积,自底向上定量布道,末道反解闭合到 ±3%' })]));

    if (!wp || !seam || !wps) {
      this.host.append(el('div', { class: 'panel', text: '请先在工件库生成工件,并确保有工艺(WPS)数据' }));
      return;
    }

    const layout = el('div', { class: 'layout' });
    const left = el('div', { class: 'panel scroll-y' });
    const right = el('div', { class: 'panel scroll-y' });
    layout.append(left, right);
    this.host.append(layout);

    // ---- 左:选择 + 参数 + 运行 ----
    left.append(el('h3', { text: '排道输入' }));
    left.append(
      field('工件', el('select', { onchange: (e) => { update({ currentWorkpieceId: (e.target as HTMLSelectElement).value }); this.render(); } },
        s.workpieces.map((w) => el('option', { value: w.id, text: w.name, ...(w.id === wp.id ? { selected: true } : {}) })))),
      field('焊缝', el('select', { onchange: (e) => { update({ currentSeamId: (e.target as HTMLSelectElement).value }); this.render(); } },
        wp.seams.map((sm) => el('option', { value: sm.id, text: `${sm.name} (${sm.joint})`, ...(sm.id === seam.id ? { selected: true } : {}) })))),
      field('工艺 WPS', el('select', { onchange: (e) => { update({ currentWpsId: (e.target as HTMLSelectElement).value }); this.render(); } },
        s.wpsList.map((w) => el('option', { value: w.id, text: w.name, ...(w.id === wps.id ? { selected: true } : {}) })))),
    );
    const g = seam.groove;
    left.append(
      el('div', { class: 'muted', style: 'font-size:11px;line-height:1.8' }, [
        el('div', { html: `坡口 <b>${g.type}</b> · 板厚 ${g.plateThickness}mm · 角 ${g.bevelAngle}° · 钝边 ${g.rootFace}mm · 间隙 ${g.rootGap}mm · 余高 ${g.reinforcement}mm` }),
        el('div', { html: `焊丝 φ${wps.wireDiameter} · 送丝 ${wps.wireFeedSpeed}m/min · 焊速 ${wps.travelSpeed}mm/s · η=${wps.depositionEfficiency}` }),
      ]),
      el('h3', { text: '排道策略' }),
      field('搭接率', numInput(this.opts.overlapRate, 0.05, (v) => (this.opts.overlapRate = v))),
      field('根焊系数', numInput(this.opts.rootRadiusFactor, 0.02, (v) => (this.opts.rootRadiusFactor = v))),
      field('盖面降速', numInput(this.opts.capTravelFactor, 0.05, (v) => (this.opts.capTravelFactor = v))),
      field('层厚系数', numInput(this.opts.layerThicknessFactor, 0.02, (v) => (this.opts.layerThicknessFactor = v))),
      field('分段数', numInput(8, 1, () => undefined)),
      el('div', { class: 'btnrow' }, [
        el('button', { class: 'primary', text: '执行自动排道', onclick: () => this.run(wps, wps as WpsParams, seam.length) }),
      ]),
    );

    // 已存方案
    left.append(el('h3', { text: `已存方案(${s.plans.filter((p) => p.seamId === seam.id).length})` }));
    for (const p of s.plans.filter((p) => p.seamId === seam.id)) {
      left.append(el('div', { class: 'listitem' + (this.plan?.id === p.id ? ' active' : ''), onclick: () => this.loadPlan(p) }, [
        el('div', { class: 't', text: p.name }),
        el('div', { class: 'd', html: `${p.totalPasses}道 · 误差 ${p.maxAreaErrorPct.toFixed(2)}% · ${(p.totalWeldTime / 60).toFixed(1)}min` }),
        el('div', { class: 'btnrow' }, [
          el('button', { class: 'danger', text: '删除', onclick: (e) => { e.stopPropagation(); void removePlan(p.id); if (this.plan?.id === p.id) { this.plan = null; this.results = []; } this.render(); } }),
        ]),
      ]));
    }

    this.renderResults(right, seam.length);
  }

  private run(wps: WpsParams, _wps2: WpsParams, seamLength: number): void {
    const seam = currentSeam()!;
    const wp = currentWorkpiece()!;
    const segCount = 8;
    this.results = planSeam(seam.groove, wps, seam.gapProfile, this.opts, segCount);
    const segs = this.results.map((r) => r.segment);
    const sum = summarizePlan(segs, seamLength, wps);
    this.plan = {
      id: uid('plan'),
      name: `方案-${new Date().toLocaleString('zh-CN', { hour12: false })}`,
      seamId: seam.id,
      workpieceId: wp.id,
      wpsId: wps.id,
      createdAt: Date.now(),
      segments: segs,
      ...sum,
      strategy: { targetLayerThickness: this.opts.layerThicknessFactor, capOverride: true },
    };
    this.segIdx = 0;
    this.render();
  }

  private loadPlan(p: PassPlan): void {
    this.plan = p;
    const seam = currentSeam()!;
    const wps = getState().wpsList.find((w) => w.id === p.wpsId) ?? currentWps()!;
    this.results = p.segments.map((seg) => {
      const geom = buildGroove({ ...seam.groove, rootGap: seg.gap });
      return { segment: seg, geom, closure: { iterations: 0, finalScale: 1, note: '已加载' } };
    });
    void wps;
    update({ currentPlanId: p.id });
    this.segIdx = 0;
    this.render();
  }

  private renderResults(right: HTMLElement, seamLength: number): void {
    if (!this.plan || this.results.length === 0) {
      right.append(el('p', { class: 'muted', text: '设置参数后点击「执行自动排道」' }));
      return;
    }
    const p = this.plan;
    const errBadge = p.maxAreaErrorPct <= 3 ? badge(`闭合误差 ${p.maxAreaErrorPct.toFixed(2)}% ✓`, 'ok') : badge(`闭合误差 ${p.maxAreaErrorPct.toFixed(2)}% 超标`, 'err');
    right.append(
      el('div', { class: 'metrics' }, [
        metric(p.totalPasses + '', '焊道总数(最多段)'),
        metric(this.results[0].segment.layerCount + '', '层数'),
        metric((p.totalDepositionVolume / 1000).toFixed(1), '熔敷量 cm³'),
        metric((p.totalWeldTime / 60).toFixed(1), '燃弧工时 min'),
        metric(p.totalWireLength.toFixed(1), '焊丝 m'),
      ]),
      el('div', { class: 'row' }, [errBadge, badge(`平均热输入 ${p.totalHeatInput.toFixed(2)} kJ/mm`, 'info'), el('span', { class: 'spacer' }),
        el('button', { class: 'primary', text: '保存方案到 IndexedDB', onclick: () => void savePlan(p) }),
        el('button', { text: '加入方案对比', onclick: () => this.addCompare(p) }),
      ]),
      el('div', { class: 'gap' }),
    );

    // 分段切换
    const segBar = el('div', { class: 'tabbar' });
    this.results.forEach((r, i) => {
      segBar.append(el('button', {
        class: i === this.segIdx ? 'active' : '',
        text: `段${i + 1}(${r.segment.gap.toFixed(1)}mm/${r.segment.passCount}道)`,
        onclick: () => { this.segIdx = i; this.render(); },
      }));
    });
    right.append(segBar);

    // 截面图
    this.canvas = el('canvas', { width: 720, height: 460 }) as HTMLCanvasElement;
    const host = el('div', { class: 'canvas-host host-2d' }, [this.canvas]);
    right.append(host);
    const r = this.results[this.segIdx];
    queueMicrotask(() => {
      drawGrooveSection(this.canvas!, r.geom, r.segment.beads, { showAim: true });
    });

    // 该段面积核对
    right.append(el('div', { class: 'gap' }), el('div', { class: 'row' }, [
      badge(`目标面积 ${r.segment.targetArea.toFixed(1)} mm²`, 'info'),
      badge(`实排面积 ${r.segment.plannedArea.toFixed(1)} mm²`, 'info'),
      r.segment.areaErrorPct <= 3 ? badge(`误差 ${r.segment.areaErrorPct.toFixed(2)}%`, 'ok') : badge(`误差 ${r.segment.areaErrorPct.toFixed(2)}%`, 'err'),
      el('span', { class: 'muted', text: r.closure.note }),
    ]));

    // 间隙曲线图
    const gapCanvas = el('canvas', { width: 720, height: 180 }) as HTMLCanvasElement;
    right.append(el('h3', { text: '沿焊缝间隙与分段道数' }), el('div', { class: 'canvas-host' }, [gapCanvas]));
    const seam = currentSeam()!;
    queueMicrotask(() => {
      const gapPts = (seam.gapProfile.length ? seam.gapProfile : [{ t: 0, gap: seam.groove.rootGap }, { t: 1, gap: seam.groove.rootGap }])
        .map((q) => ({ x: q.t * seamLength, y: q.gap }));
      const passPts = this.results.map((rr) => ({ x: ((rr.segment.t0 + rr.segment.t1) / 2) * seamLength, y: rr.segment.passCount }));
      drawChart(gapCanvas, [
        { name: '间隙 mm', color: '#ffb74d', points: gapPts },
        { name: '段道数', color: '#4d9fff', points: passPts },
      ], 'mm/道');
    });

    // 焊道表
    right.append(el('h3', { text: `本段焊道明细(${r.segment.beads.length}道)` }));
    const table = el('div', { class: 'tablewrap' }, [
      el('table', {}, [
        el('thead', {}, [el('tr', {}, ['层', '道', '角色', '中心(x,y)', '半径', '熔深', '工作角°', '偏移', '焊速', '摆宽'].map((h) => el('th', { text: h })))]),
        el('tbody', {}, r.segment.beads.map((b) => el('tr', {}, [
          el('td', { text: String(b.layer + 1) }),
          el('td', { class: 'tag-pass', style: `color:${beadColor(b)}`, text: String(b.pass + 1) }),
          el('td', { text: b.role }),
          el('td', { text: `(${b.center.x.toFixed(1)},${b.center.y.toFixed(1)})` }),
          el('td', { text: b.radius.toFixed(1) }),
          el('td', { text: b.penetration.toFixed(1) }),
          el('td', { text: b.aimAngle.toFixed(0) }),
          el('td', { text: `(${b.aimOffset.x.toFixed(1)},${b.aimOffset.y.toFixed(1)})` }),
          el('td', { text: b.wps.travelSpeed.toFixed(1) }),
          el('td', { text: b.wps.weaveWidth.toFixed(1) }),
        ]))),
      ]),
    ]);
    right.append(table);
    right.append(this.comparePanel());
  }

  private addCompare(p: PassPlan): void {
    if (!this.comparePlans.find((x) => x.id === p.id)) this.comparePlans.push(p);
    this.render();
  }

  private comparePanel(): HTMLElement {
    const box = el('div', {});
    if (this.comparePlans.length < 2) {
      box.append(el('h3', { text: '方案对比(至少加入 2 套)' }));
      return box;
    }
    box.append(el('h3', { text: '多方案对比' }));
    box.append(el('table', {}, [
      el('thead', {}, [el('tr', {}, ['方案', '道数', '熔敷量cm³', '工时min', '焊丝m', '最大误差%', ''].map((h) => el('th', { text: h })))]),
      el('tbody', {}, this.comparePlans.map((p) => el('tr', {}, [
        el('td', { text: p.name }),
        el('td', { text: String(p.totalPasses) }),
        el('td', { text: (p.totalDepositionVolume / 1000).toFixed(1) }),
        el('td', { text: (p.totalWeldTime / 60).toFixed(1) }),
        el('td', { text: p.totalWireLength.toFixed(1) }),
        el('td', {}, [p.maxAreaErrorPct <= 3 ? badge(p.maxAreaErrorPct.toFixed(2), 'ok') : badge(p.maxAreaErrorPct.toFixed(2), 'err')]),
        el('td', {}, [el('button', { class: 'danger', text: '移除', onclick: () => { this.comparePlans = this.comparePlans.filter((x) => x.id !== p.id); this.render(); } })]),
      ]))),
    ]));
    return box;
  }
}

function metric(v: string, k: string): HTMLElement {
  return el('div', { class: 'metric' }, [el('div', { class: 'v', text: v }), el('div', { class: 'k', text: k })]);
}
