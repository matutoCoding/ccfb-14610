// ============================================================
// 页面6:工艺卡 —— 每道参数汇总、机器人程序文本导出、带截面图工艺卡导出
// ============================================================

import { currentPlan, currentProgram, currentSeam, currentWorkpiece, getState } from '../store';
import { el, clear, badge, drawGrooveSection, download, beadColor } from '../ui';
import { exportProgramText, exportWpsCardText, downloadCanvas } from '../../core/program';
import { buildGroove } from '../../core/groove';
import { simulateThermal } from '../../core/thermal';

export class WpsCardPage {
  private host: HTMLElement;

  constructor(host: HTMLElement) {
    this.host = host;
    this.render();
  }

  private render(): void {
    const plan = currentPlan();
    const wp = currentWorkpiece();
    const seam = currentSeam();
    const program = currentProgram();
    clear(this.host);
    this.host.append(el('h2', { class: 'page-title' }, ['焊接工艺卡与程序导出 ', el('small', { text: '汇总每道电流/电压/焊速/摆宽/起收弧点,导出机器人程序与带截面图工艺卡' })]));
    if (!plan || !wp || !seam) {
      this.host.append(el('div', { class: 'panel', text: '请先在「坡口排道」页生成并选中方案' }));
      return;
    }
    const wps = getState().wpsList.find((x) => x.id === plan.wpsId) ?? getState().wpsList[0]!;
    const seg = plan.segments[0];
    const thermal = simulateThermal(plan.segments, seam.length, wps);

    const layout = el('div', { class: 'layout' });
    const left = el('div', { class: 'panel scroll-y' });
    const right = el('div', { class: 'panel scroll-y' });
    layout.append(left, right);
    this.host.append(layout);

    // 左:导出 + 截面图
    left.append(
      el('h3', { text: '导出' }),
      el('div', { class: 'btnrow' }, [
        el('button', {
          class: 'primary', text: '下载机器人程序(.txt)',
          onclick: () => {
            if (!program) { alert('请先在「离线仿真」页生成机器人程序'); return; }
            download(`${program.name}.txt`, exportProgramText(program));
          },
        }),
        el('button', {
          text: '下载工艺卡文本(.txt)',
          onclick: () => download(`工艺卡-${wp.name}.txt`, exportWpsCardText(plan, wp, wps, thermal)),
        }),
        el('button', {
          text: '下载截面排道图(.png)',
          onclick: () => {
            const c = el('canvas', { width: 1200, height: 800 }) as HTMLCanvasElement;
            const geom = buildGroove({ ...seam.groove, rootGap: seg.gap });
            drawGrooveSection(c, geom, seg.beads, { showAim: true });
            const ctx = c.getContext('2d')!;
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 28px sans-serif';
            ctx.fillText(`${wp.name} - ${seam.name} 截面排道图`, 30, 40);
            downloadCanvas(`排道图-${seam.name}.png`, c);
          },
        }),
      ]),
      el('h3', { text: '截面排道图(可导出 PNG)' }),
    );
    const canvas = el('canvas', { width: 700, height: 480 }) as HTMLCanvasElement;
    left.append(el('div', { class: 'canvas-host host-2d' }, [canvas]));
    queueMicrotask(() => {
      const geom = buildGroove({ ...seam.groove, rootGap: seg.gap });
      drawGrooveSection(canvas, geom, seg.beads, { showAim: true });
    });

    // 右:工艺卡内容
    right.append(
      el('h3', { text: '工艺卡表头' }),
      el('div', { class: 'metrics' }, [
        metric(seg.passCount + '', '道数(首段)'),
        metric(seg.layerCount + '', '层数'),
        metric(plan.maxAreaErrorPct.toFixed(2) + '%', '面积闭合误差'),
        metric((plan.totalWeldTime / 60).toFixed(1), '燃弧 min'),
        metric(plan.totalWireLength.toFixed(1), '焊丝 m'),
        metric((plan.totalDepositionVolume / 1000).toFixed(1), '熔敷 cm³'),
      ]),
      el('div', { class: 'btnrow' }, [
        badge(`${wps.process} φ${wps.wireDiameter}`, 'info'),
        badge(`${seam.groove.type} ${seam.groove.plateThickness}mm`, 'info'),
        badge(`热输入 ${plan.totalHeatInput.toFixed(2)} kJ/mm`, 'info'),
        badge(`层间上限 ${wps.interpassLimit}℃`, 'info'),
      ]),
      el('h3', { text: '逐道工艺参数(起收弧点)' }),
      el('div', { class: 'tablewrap' }, [
        el('table', {}, [
          el('thead', {}, [el('tr', {}, ['层', '道', '角色', '电流A', '电压V', '焊速', '摆宽', '摆频', '工作角', '行走角', '起弧点', '收弧点'].map((h) => el('th', { text: h })))]),
          el('tbody', {}, seg.beads.map((b) => el('tr', {}, [
            el('td', { text: String(b.layer + 1) }),
            el('td', { style: `color:${beadColor(b)};font-weight:600`, text: String(b.pass + 1) }),
            el('td', { text: b.role }),
            el('td', { text: String(b.wps.current) }),
            el('td', { text: String(b.wps.voltage) }),
            el('td', { text: b.wps.travelSpeed.toFixed(1) }),
            el('td', { text: b.wps.weaveWidth.toFixed(1) }),
            el('td', { text: b.wps.weaveFrequency.toFixed(1) }),
            el('td', { text: b.aimAngle.toFixed(0) + '°' }),
            el('td', { text: b.wps.travelAngle + '°' }),
            el('td', { style: 'font-size:10.5px', text: `(${b.center.x.toFixed(0)},${b.center.y.toFixed(0)},0)` }),
            el('td', { style: 'font-size:10.5px', text: `(${b.center.x.toFixed(0)},${b.center.y.toFixed(0)},${seam.length})` }),
          ]))),
        ]),
      ]),
    );

    if (program) {
      right.append(el('h3', { text: '机器人程序预览(前 40 行)' }));
      const lines = exportProgramText(program).split('\n').slice(0, 40).join('\n');
      right.append(el('pre', {
        style: 'background:#0b1017;border:1px solid var(--line);border-radius:6px;padding:10px;font-size:11px;overflow:auto;max-height:320px;color:#9fd0ff',
        text: lines,
      }));
    } else {
      right.append(el('div', { class: 'warnlist gap' }, [el('div', { class: 'w', text: '尚未生成机器人程序,请到「离线仿真」页生成后再导出' })]));
    }
  }
}

function metric(v: string, k: string): HTMLElement {
  return el('div', { class: 'metric' }, [el('div', { class: 'v', text: v }), el('div', { class: 'k', text: k })]);
}
