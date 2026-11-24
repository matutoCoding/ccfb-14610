import type { DefectMark, ThermalSettings } from '../core/types';
import { buildGrooveSection } from '../core/groove';
import { detectDefects } from '../core/defects';
import { planThermal } from '../core/thermal';
import { store } from './store';
import { clear, fmt, h } from './dom';
import { drawSection } from './section-draw';

export function renderFormingPage(root: HTMLElement): void {
  clear(root);
  const seam = store.currentSeam();
  const scheme = store.currentScheme();
  if (!seam || !scheme) {
    root.append(h('div', { class: 'panel empty' }, '请先在「坡口排道」生成并保存方案'));
    return;
  }

  const segSel = h('select', {}) as HTMLSelectElement;
  scheme.segments.forEach((s, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = `段 ${i + 1}（间隙 ${s.gap.toFixed(1)}mm）`;
    segSel.appendChild(o);
  });

  const sectionCanvas = h('canvas', { style: { width: '100%', height: '440px' } }) as HTMLCanvasElement;
  const thermalCanvas = h('canvas', { style: { width: '100%', height: '260px' } }) as HTMLCanvasElement;
  const defectHost = h('div', {});
  const thermalHost = h('div', {});

  const redraw = (): void => {
    const seg = scheme.segments[Number(segSel.value ?? 0)];
    const section = buildGrooveSection(seam.groove, seg.gap);
    const marks: DefectMark[] = detectDefects(seg.beads, section);
    drawSection(sectionCanvas, section, seg.beads, {
      showDefects: marks, showFusion: true, showLabels: true,
    });
    renderDefects(defectHost, marks);

    const segLen = seam.length / scheme.segments.length;
    const thermal = planThermal(seg.beads, segLen, scheme.thermal);
    drawThermal(thermalCanvas, thermal.states.map((s) => ({
      bead: s.beadIndex, tempBefore: s.tempBefore, tempAfter: s.tempAfter,
      wait: s.waitBefore, heatInput: s.heatInput, over: s.overLimit,
    })), scheme.thermal);
    renderThermalSummary(thermalHost, thermal, scheme.thermal);
  };
  segSel.addEventListener('change', redraw);

  root.append(
    h('div', { class: 'panel' },
      h('h2', {}, '焊道成形与缺陷检测 ', h('span', { class: 'tag' }, '侧壁未熔合 / 夹渣谷角 / 层间未熔合 自动圈注')),
      h('label', { class: 'field', style: { maxWidth: '320px' } }, h('span', {}, '选择分段'), segSel),
      h('div', { class: 'two-canvas' },
        h('div', { class: 'canvas-host' }, sectionCanvas,
          h('div', { class: 'hint' }, '红虚圆=熔深范围，红/橙圈=缺陷位置')),
        h('div', { class: 'canvas-host', style: { minHeight: '260px' } }, thermalCanvas,
          h('div', { class: 'hint' }, '柱=道后温度，折线=热输入 kJ/mm，红柱=超层间温限'))),
      defectHost,
      thermalHost,
    ),
  );
  redraw();
}

function renderDefects(host: HTMLElement, marks: DefectMark[]): void {
  clear(host);
  if (!marks.length) {
    host.append(h('div', { style: { marginTop: '12px' } },
      h('span', { class: 'badge ok' }, '未检测到成形缺陷'),
      h('span', { class: 'muted', style: { marginLeft: '8px' } }, '侧壁熔合、谷角、层间搭接均在阈值内')));
    return;
  }
  const kindName: Record<DefectMark['kind'], string> = {
    'sidewall-lack-fusion': '侧壁未熔合',
    'slag-trap': '夹渣(谷角过小)',
    'interlayer-lack-fusion': '层间未熔合',
  };
  host.append(
    h('div', { class: 'table-wrap', style: { marginTop: '12px' } },
      h('table', {},
        h('thead', {}, h('tr', {},
          h('th', {}, '道次'), h('th', {}, '缺陷类型'), h('th', {}, '等级'),
          h('th', { class: 'num' }, '实测值'), h('th', { class: 'num' }, '阈值'), h('th', {}, '说明'))),
        h('tbody', {}, ...marks.map((m) =>
          h('tr', {},
            h('td', { class: 'num' }, String(m.beadIndex)),
            h('td', {}, kindName[m.kind]),
            h('td', {}, h('span', { class: `badge ${m.severity === 'bad' ? 'bad' : 'warn'}` }, m.severity === 'bad' ? '严重' : '预警')),
            h('td', { class: 'num' }, fmt(m.metric, 2)),
            h('td', { class: 'num' }, fmt(m.threshold, 2)),
            h('td', { style: { whiteSpace: 'normal', color: 'var(--text-dim)' } }, m.message)))))));
}

interface ThermalRow {
  bead: number; tempBefore: number; tempAfter: number; wait: number; heatInput: number; over: boolean;
}

function drawThermal(canvas: HTMLCanvasElement, rows: ThermalRow[], thermal: ThermalSettings): void {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = rect.width, H = rect.height, pad = 40;
  ctx.clearRect(0, 0, W, H);
  const maxT = Math.max(...rows.map((r) => r.tempAfter), thermal.interpassLimit) * 1.1;
  const maxQ = Math.max(...rows.map((r) => r.heatInput)) * 1.2;
  const X = (i: number): number => pad + (i / Math.max(1, rows.length - 1)) * (W - pad * 2);
  const Yt = (t: number): number => H - pad - (t / maxT) * (H - pad * 2);
  const Yq = (q: number): number => H - pad - (q / maxQ) * (H - pad * 2);

  // 层间温限线
  ctx.strokeStyle = '#ef5b5b';
  ctx.setLineDash([6, 4]);
  ctx.beginPath(); ctx.moveTo(pad, Yt(thermal.interpassLimit)); ctx.lineTo(W - pad, Yt(thermal.interpassLimit)); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#ef5b5b';
  ctx.font = '10px Consolas';
  ctx.fillText(`层间温限 ${thermal.interpassLimit}℃`, W - pad - 110, Yt(thermal.interpassLimit) - 4);

  // 温度柱
  const bw = Math.max(4, (W - pad * 2) / rows.length * 0.6);
  rows.forEach((r, i) => {
    const x = X(i) - bw / 2;
    const y = Yt(r.tempAfter);
    ctx.fillStyle = r.over ? 'rgba(239,91,91,0.7)' : 'rgba(59,157,255,0.55)';
    ctx.fillRect(x, y, bw, H - pad - y);
    if (r.wait > 0) {
      ctx.fillStyle = '#f0a93b';
      ctx.font = '9px Consolas';
      ctx.fillText(`${Math.round(r.wait)}s`, x - 2, y - 4);
    }
  });
  // 热输入折线
  ctx.strokeStyle = '#2fbf71';
  ctx.lineWidth = 2;
  ctx.beginPath();
  rows.forEach((r, i) => {
    const x = X(i), y = Yq(r.heatInput);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = '#2fbf71';
  rows.forEach((r, i) => { ctx.beginPath(); ctx.arc(X(i), Yq(r.heatInput), 2.5, 0, Math.PI * 2); ctx.fill(); });

  ctx.strokeStyle = '#46586e';
  ctx.beginPath(); ctx.moveTo(pad, pad); ctx.lineTo(pad, H - pad); ctx.lineTo(W - pad, H - pad); ctx.stroke();
  ctx.fillStyle = '#8494a6';
  ctx.font = '10px Consolas';
  ctx.fillText('道次 →', W - pad - 40, H - 8);
  ctx.fillText('温度℃(柱) / 热输入 kJ/mm(绿线)', pad, 14);
}

function renderThermalSummary(host: HTMLElement, thermal: ReturnType<typeof planThermal>, thermalCfg: ThermalSettings): void {
  clear(host);
  const overCount = thermal.states.filter((s) => s.overLimit).length;
  host.append(h('div', { class: 'grid-3', style: { marginTop: '12px' } },
    kpi(thermal.peakTemp > thermalCfg.interpassLimit ? 'warn' : 'ok', fmt(thermal.peakTemp, 0), '峰值层间温度 ℃'),
    kpi(overCount ? 'warn' : 'ok', String(overCount), '需等待的道次数'),
    kpi('info', fmt(thermal.totalWait / 60, 1), '累计等待 min'),
  ));
}

function kpi(cls: string, v: string, l: string): HTMLElement {
  return h('div', { class: `kpi ${cls}` }, h('div', { class: 'v', style: { fontSize: '18px' } }, v), h('div', { class: 'l' }, l));
}
