// ============================================================
// 页面5:焊道成形 —— 截面熔深/熔合线、未熔合与夹渣圈注、层间温度与热输入曲线
// ============================================================

import { currentPlan, currentSeam, currentWorkpiece } from '../store';
import { el, clear, badge, drawGrooveSection, drawChart } from '../ui';
import { buildGroove } from '../../core/groove';
import { analyzeForming } from '../../core/forming';
import { simulateThermal, heatInputCurve } from '../../core/thermal';
import type { FusionIssue } from '../../core/types';

export class FormingPage {
  private host: HTMLElement;
  private segIdx = 0;

  constructor(host: HTMLElement) {
    this.host = host;
    this.render();
  }

  private render(): void {
    const plan = currentPlan();
    const wp = currentWorkpiece();
    const seam = currentSeam();
    clear(this.host);
    this.host.append(el('h2', { class: 'page-title' }, ['焊道成形与热过程 ', el('small', { text: '逐道熔深/熔合线、侧壁未熔合与夹渣角自动圈注;层间温度累计与热输入曲线' })]));
    if (!plan || !wp || !seam) {
      this.host.append(el('div', { class: 'panel', text: '请先在「坡口排道」页生成并选中方案' }));
      return;
    }
    const seg = plan.segments[Math.min(this.segIdx, plan.segments.length - 1)];
    const geom = buildGroove({ ...seam.groove, rootGap: seg.gap });
    const report = analyzeForming(seg, geom);
    const wps = seg.beads[0]?.wps;
    const thermal = wps ? simulateThermal(plan.segments, seam.length, wps) : null;

    // 指标
    const issueCount = report.issues.length;
    this.host.append(
      el('div', { class: 'metrics' }, [
        metric(seg.passCount + '', '本段焊道'),
        metric((report.passRate * 100).toFixed(0) + '%', '一次合格率'),
        metric(String(report.issues.filter((i) => i.kind === 'sidewallLack').length), '侧壁未熔合'),
        metric(String(report.issues.filter((i) => i.kind === 'slagTrap').length), '夹渣风险'),
        metric(thermal ? thermal.maxTemp.toFixed(0) + '℃' : '-', '峰值温度'),
        metric(thermal ? String(thermal.overLimitPasses) : '-', '超层间温度道次'),
      ]),
    );

    const layout = el('div', { class: 'layout' });
    const left = el('div', { class: 'panel scroll-y' });
    const right = el('div', { class: 'panel scroll-y' });
    layout.append(left, right);
    this.host.append(layout);

    // 分段切换
    const segBar = el('div', { class: 'tabbar' });
    plan.segments.forEach((s, i) => {
      segBar.append(el('button', {
        class: i === this.segIdx ? 'active' : '',
        text: `段${i + 1} ${s.gap.toFixed(1)}mm`,
        onclick: () => { this.segIdx = i; this.render(); },
      }));
    });
    left.append(segBar);

    const canvas = el('canvas', { width: 700, height: 460 }) as HTMLCanvasElement;
    left.append(el('h3', { text: '截面熔合分析(红圈=未熔合,黄圈=夹渣)' }), el('div', { class: 'canvas-host host-2d' }, [canvas]));
    queueMicrotask(() => drawGrooveSection(canvas, geom, seg.beads, { issues: report.issues, showAim: false }));

    // 问题清单
    left.append(el('h3', { text: `圈注问题(${issueCount})` }));
    const wl = el('div', { class: 'warnlist' });
    if (issueCount === 0) wl.append(el('div', { class: 'w ok', text: '该段全部焊道侧壁熔合与道间夹角合格' }));
    const grouped = new Map<string, FusionIssue[]>();
    for (const it of report.issues) {
      const k = it.message;
      if (!grouped.has(k)) grouped.set(k, []);
      grouped.get(k)!.push(it);
    }
    grouped.forEach((list, msg) => {
      const kind = list[0].kind;
      wl.append(el('div', { class: kind === 'sidewallLack' ? 'w err' : 'w' }, [
        el('div', { html: `<b>${kind === 'sidewallLack' ? '未熔合' : '夹渣'}</b> · ${msg}` }),
        el('div', { class: 'muted', style: 'font-size:11px', text: `位置(${list[0].position.x.toFixed(1)},${list[0].position.y.toFixed(1)}) 严重度 ${(list[0].severity * 100).toFixed(0)}%` }),
      ]));
    });
    left.append(wl);

    // 每道熔合数据表
    left.append(el('h3', { text: '逐道熔合数据' }));
    left.append(el('div', { class: 'tablewrap' }, [
      el('table', {}, [
        el('thead', {}, [el('tr', {}, ['道', '角色', '左壁弦长', '右壁弦长', '熔深', '道间熔合'].map((h) => el('th', { text: h })))]),
        el('tbody', {}, report.fusions.map((f) => {
          const b = seg.beads[f.pass];
          return el('tr', {}, [
            el('td', { text: String(f.pass + 1) }),
            el('td', { text: b.role }),
            el('td', {}, [f.leftContact > 0 ? badge(f.leftContact.toFixed(1), f.leftContact < b.width * 0.35 ? 'warn' : 'ok') : el('span', { class: 'muted', text: '—' })]),
            el('td', {}, [f.rightContact > 0 ? badge(f.rightContact.toFixed(1), f.rightContact < b.width * 0.35 ? 'warn' : 'ok') : el('span', { class: 'muted', text: '—' })]),
            el('td', { text: f.penetration.toFixed(1) }),
            el('td', { text: f.interBeadFusion.toFixed(1) }),
          ]);
        })),
      ]),
    ]));

    // 右侧:热过程
    if (thermal) {
      const tempCanvas = el('canvas', { width: 640, height: 240 }) as HTMLCanvasElement;
      const heatCanvas = el('canvas', { width: 640, height: 240 }) as HTMLCanvasElement;
      right.append(
        el('h3', { text: '层间温度累计(含超限等待)' }),
        el('div', { class: 'btnrow' }, [
          thermal.overLimitPasses ? badge(`${thermal.overLimitPasses} 道超上限`, 'err') : badge('层间温度全部合格', 'ok'),
          badge(`累计等待 ${thermal.totalWait}s`, thermal.totalWait > 0 ? 'warn' : 'ok'),
          badge(`上限 ${wps!.interpassLimit}℃`, 'info'),
        ]),
        el('div', { class: 'canvas-host gap' }, [tempCanvas]),
        el('h3', { text: '逐道热输入曲线' }),
        el('div', { class: 'canvas-host' }, [heatCanvas]),
      );
      queueMicrotask(() => {
        drawChart(tempCanvas, [
          { name: '焊前温度℃', color: '#4d9fff', points: thermal.states.map((s) => ({ x: s.pass + 1, y: s.tempBefore })) },
          { name: '峰值温度℃', color: '#ff8f40', points: thermal.states.map((s) => ({ x: s.pass + 1, y: s.tempPeak })) },
          { name: '层间上限', color: '#ff5f5f', dashed: true, points: thermal.states.map((s) => ({ x: s.pass + 1, y: wps!.interpassLimit })) },
        ], '℃');
        const qc = heatInputCurve(plan.segments);
        drawChart(heatCanvas, [
          { name: '热输入 kJ/mm', color: '#46c08a', points: qc.map((q) => ({ x: q.pass + 1, y: q.q })) },
        ], 'kJ/mm');
      });
      // 超限道次等待表
      const overs = thermal.states.filter((s) => s.overLimit);
      if (overs.length) {
        right.append(el('h3', { text: '超限道次等待建议' }));
        right.append(el('div', { class: 'tablewrap' }, [
          el('table', {}, [
            el('thead', {}, [el('tr', {}, ['层', '道', '焊前温度', '建议等待s'].map((h) => el('th', { text: h })))]),
            el('tbody', {}, overs.map((s) => el('tr', {}, [
              el('td', { text: String(s.layer + 1) }),
              el('td', { text: String(s.pass + 1) }),
              el('td', { text: s.tempBefore.toFixed(0) + '℃' }),
              el('td', {}, [badge(String(s.waitSeconds), 'warn')]),
            ]))),
          ]),
        ]));
      }
    }
  }
}

function metric(v: string, k: string): HTMLElement {
  return el('div', { class: 'metric' }, [el('div', { class: 'v', text: v }), el('div', { class: 'k', text: k })]);
}
