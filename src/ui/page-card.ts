import type { PlanScheme } from '../core/types';
import { buildGrooveSection } from '../core/groove';
import { exportRobotProgram, type BuiltTrajectory } from '../core/trajectory';
import { store } from './store';
import { downloadText, fmt, h, clear } from './dom';
import { drawSection } from './section-draw';
import { formatWait } from '../core/thermal';

export function renderProcessCardPage(root: HTMLElement): void {
  clear(root);
  const seam = store.currentSeam();
  const schemes = store.state.schemes.filter((s) => !seam || s.seamId === seam?.id);
  if (!seam || !schemes.length) {
    root.append(h('div', { class: 'panel empty' }, '请先在「坡口排道」生成至少一个方案'));
    return;
  }

  root.append(renderComparison(schemes), renderDetail(schemes));
}

function renderComparison(schemes: PlanScheme[]): HTMLElement {
  const totalBeads = (s: PlanScheme): number => s.segments.reduce((n, seg) => n + seg.beads.length, 0);
  return h('div', { class: 'panel' },
    h('h2', {}, '排道方案对比 ', h('span', { class: 'tag' }, '焊道数 / 熔敷量 / 工时 三维择优')),
    h('div', { class: 'table-wrap' },
      h('table', {},
        h('thead', {}, h('tr', {},
          h('th', {}, '方案'), h('th', { class: 'num' }, '总面积误差%'),
          h('th', { class: 'num' }, '焊道数'), h('th', { class: 'num' }, '层数'),
          h('th', { class: 'num' }, '熔敷体积 L'), h('th', { class: 'num' }, '焊丝 kg'),
          h('th', { class: 'num' }, '焊接 min'), h('th', { class: 'num' }, '等待 min'),
          h('th', {}, '验收'), h('th', {}, '操作'))),
        h('tbody', {}, ...schemes.map((s) =>
          h('tr', { style: s.id === store.state.currentSchemeId ? 'background:#1b3a57' : '' },
            h('td', { style: 'white-space:normal' }, s.name),
            h('td', { class: 'num' }, fmt(s.audit.errorPct, 2)),
            h('td', { class: 'num' }, String(totalBeads(s))),
            h('td', { class: 'num' }, String(Math.max(...s.segments.map((x) => x.layers.length)))),
            h('td', { class: 'num' }, fmt(s.totalDepositionVolume / 1e6, 2)),
            h('td', { class: 'num' }, fmt(s.totalWireMass / 1000, 2)),
            h('td', { class: 'num' }, fmt(s.totalArcTime / 60, 1)),
            h('td', { class: 'num' }, fmt(s.totalWaitTime / 60, 1)),
            h('td', {}, h('span', { class: `badge ${s.audit.pass ? 'ok' : 'bad'}` }, s.audit.pass ? '通过' : '超差')),
            h('td', {}, h('button', { onclick: () => { store.state.currentSchemeId = s.id; store.emit(); } }, '查看')),
          ))))),
  );
}

function renderDetail(schemes: PlanScheme[]): HTMLElement {
  const scheme = store.currentScheme() ?? schemes[schemes.length - 1];
  const seam = store.currentSeam()!;
  const host = h('div', { class: 'panel' });
  const canvas = h('canvas', { style: { width: '100%', height: '360px' } }) as HTMLCanvasElement;
  const programOut = h('pre', { class: 'program' }) as HTMLPreElement;

  const draw = (): void => {
    const seg = scheme.segments[0];
    const section = buildGrooveSection(seam.groove, seg.gap);
    drawSection(canvas, section, seg.beads, { showLabels: true });
  };

  const allBeads = scheme.segments[Math.floor(scheme.segments.length / 2)].beads;
  const fakeTraj: BuiltTrajectory = {
    keys: [], weldLength: seam.length, airLength: 0,
    arcTime: scheme.totalArcTime, airTime: 0,
  };
  const programText = exportRobotProgram(fakeTraj, `WELD_${scheme.id.slice(-6)}`);

  host.append(
    h('h2', {}, '工艺卡与程序导出'),
    h('div', { class: 'grid-2' },
      h('div', { class: 'canvas-host', style: { minHeight: '360px' } }, canvas),
      h('div', {},
        h('div', { class: 'legend', style: { marginBottom: '8px' } },
          h('span', {}, h('i', { style: 'background:#2fbf71' }), '根焊'),
          h('span', {}, h('i', { style: 'background:#3b9dff' }), '填充'),
          h('span', {}, h('i', { style: 'background:#f0a93b' }), '盖面')),
        beadCardTable(allBeads),
      ),
    ),
    h('div', { class: 'row', style: { margin: '12px 0' } },
      h('button', { class: 'primary', onclick: () => downloadText(`${scheme.id}.robot.txt`, programText) }, '导出机器人程序 (.txt)'),
      h('button', { onclick: () => downloadText(`${scheme.id}-工艺卡.txt`, buildProcessCardText(scheme, seam.name)) }, '导出工艺卡 (.txt)'),
      h('button', { onclick: () => exportCardHtml(scheme, seam.name, canvas) }, '导出带截面图工艺卡 (.html)'),
      h('button', { class: 'danger', onclick: async () => {
        if (confirm('删除该方案？')) { await store.deleteScheme(scheme.id); }
      } }, '删除方案'),
    ),
    h('h2', { style: { fontSize: '12.5px' } }, '机器人程序预览（通用六轴+双轴变位机格式）'),
    (programOut.textContent = programText, programOut),
  );
  requestAnimationFrame(draw);
  return host;
}

function beadCardTable(beads: PlanScheme['segments'][number]['beads']): HTMLElement {
  return h('div', { class: 'table-wrap', style: { maxHeight: '360px' } },
    h('table', {},
      h('thead', {}, h('tr', {},
        h('th', {}, '道'), h('th', {}, '层'), h('th', { class: 'num' }, '电流A'),
        h('th', { class: 'num' }, '电压V'), h('th', { class: 'num' }, '焊速'),
        h('th', { class: 'num' }, '摆宽'), h('th', { class: 'num' }, '起收弧'))),
      h('tbody', {}, ...beads.map((b) =>
        h('tr', {},
          h('td', { class: 'num' }, String(b.index)),
          h('td', { class: 'num' }, String(b.layer)),
          h('td', { class: 'num' }, String(b.current)),
          h('td', { class: 'num' }, String(b.voltage)),
          h('td', { class: 'num' }, fmt(b.travelSpeed, 1)),
          h('td', { class: 'num' }, b.weaveWidth ? fmt(b.weaveWidth, 0) : '—'),
          h('td', { class: 'num' }, `${b.travelAngleDeg.toFixed(0)}°`))))));
}

function buildProcessCardText(scheme: PlanScheme, seamName: string): string {
  const lines: string[] = [];
  lines.push('========== 焊接工艺卡（自动生成）==========');
  lines.push(`方案：${scheme.name}`);
  lines.push(`焊缝：${seamName}`);
  lines.push(`生成时间：${new Date(scheme.createdAt).toLocaleString('zh-CN')}`);
  lines.push(`面积审计：需求 ${scheme.audit.requiredArea.toFixed(1)}mm²，熔敷 ${scheme.audit.depositedArea.toFixed(1)}mm²，误差 ${scheme.audit.errorPct.toFixed(2)}%（≤3% ${scheme.audit.pass ? '通过' : '未通过'}）`);
  lines.push(`熔敷体积：${(scheme.totalDepositionVolume / 1e6).toFixed(2)}L  焊丝：${(scheme.totalWireMass / 1000).toFixed(2)}kg`);
  lines.push(`焊接工时：${(scheme.totalArcTime / 60).toFixed(1)}min  层间等待：${formatWait(scheme.totalWaitTime)}`);
  lines.push(`层间温限：${scheme.thermal.interpassLimit}℃  环境温度：${scheme.thermal.ambientTemp}℃`);
  lines.push('');
  lines.push('道次 层 角色  电流  电压  焊速   摆宽  工作角 行走角 热输入kJ/mm');
  for (const seg of scheme.segments) {
    lines.push(`--- 段 ${seg.index + 1}（间隙 ${seg.gap.toFixed(1)}mm，${seg.beads.length} 道，面积误差 ${seg.areaErrorPct.toFixed(2)}%）---`);
    for (const b of seg.beads) {
      lines.push(
        `${String(b.index).padStart(3)} ${String(b.layer).padStart(2)} ` +
        `${b.role.padEnd(4)} ${String(b.current).padStart(4)} ${String(b.voltage).padStart(5)} ` +
        `${b.travelSpeed.toFixed(1).padStart(5)} ${(b.weaveWidth ? b.weaveWidth.toFixed(0) : '—').padStart(4)} ` +
        `${b.workAngleDeg.toFixed(0).padStart(5)}° ${b.travelAngleDeg.toFixed(0).padStart(5)}° ${b.heatInput.toFixed(3)}`,
      );
    }
  }
  return lines.join('\n');
}

function exportCardHtml(scheme: PlanScheme, seamName: string, canvas: HTMLCanvasElement): void {
  const img = canvas.toDataURL('image/png');
  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>焊接工艺卡 ${scheme.name}</title>
<style>body{font-family:'Microsoft YaHei',sans-serif;max-width:900px;margin:24px auto;color:#222}
table{border-collapse:collapse;width:100%;font-size:12px;margin:12px 0}
th,td{border:1px solid #999;padding:5px 7px;text-align:right}th{background:#eee}
img{width:100%;border:1px solid #ccc;border-radius:6px}h1{font-size:18px}</style></head><body>
<h1>焊接工艺卡 — ${seamName}</h1>
<p>方案 ${scheme.name}｜面积误差 ${scheme.audit.errorPct.toFixed(2)}%（验收≤3% ${scheme.audit.pass ? '通过' : '未通过'}）｜
焊丝 ${(scheme.totalWireMass / 1000).toFixed(2)}kg｜工时 ${(scheme.totalArcTime / 60).toFixed(1)}min</p>
<h2>坡口排道截面</h2><img src="${img}" alt="section"/>
<h2>逐道工艺参数</h2>
<table><thead><tr><th>道</th><th>层</th><th>角色</th><th>电流A</th><th>电压V</th><th>焊速mm/s</th><th>摆宽mm</th><th>工作角°</th><th>行走角°</th><th>热输入</th></tr></thead><tbody>
${scheme.segments.flatMap((seg) => seg.beads).map((b) =>
  `<tr><td>${b.index}</td><td>${b.layer}</td><td>${b.role}</td><td>${b.current}</td><td>${b.voltage}</td>
  <td>${b.travelSpeed.toFixed(1)}</td><td>${b.weaveWidth || ''}</td><td>${b.workAngleDeg.toFixed(0)}</td>
  <td>${b.travelAngleDeg.toFixed(0)}</td><td>${b.heatInput.toFixed(3)}</td></tr>`).join('')}
</tbody></table></body></html>`;
  downloadText(`${scheme.id}-工艺卡.html`, html, 'text/html');
}
