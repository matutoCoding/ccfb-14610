import type { PlanScheme, WpsParams } from '../core/types';
import { buildGrooveSection } from '../core/groove';
import { beadGeometry, defaultThermal } from '../core/wps';
import { buildScheme } from './plan-service';
import { store } from './store';
import { clear, fmt, h, toast } from './dom';
import { drawGapCurve, drawSection } from './section-draw';

export function renderPlanningPage(root: HTMLElement): void {
  clear(root);
  const seam = store.currentSeam();
  if (!seam) {
    root.append(h('div', { class: 'panel empty' }, '请先在「工件库」选择一条焊缝'));
    return;
  }

  const wps = store.wpsByRole();
  let scheme: PlanScheme | null = store.currentScheme() ?? null;

  const sectionCanvas = h('canvas', { style: { width: '100%', height: '460px' } }) as HTMLCanvasElement;
  const gapCanvas = h('canvas', { style: { width: '100%', height: '200px' } }) as HTMLCanvasElement;
  const kpiHost = h('div', { class: 'grid-3' });
  const tableHost = h('div', {});
  const auditHost = h('div', {});
  const segSelector = h('select', {}) as HTMLSelectElement;

  const redraw = (): void => {
    if (!scheme) return;
    const segIdx = Number(segSelector.value ?? 0);
    const seg = scheme.segments[segIdx];
    const section = buildGrooveSection(seam.groove, seg.gap);
    drawSection(sectionCanvas, section, seg.beads, { showLabels: true, showFusion: true });
    const segData = scheme.segments.map((s) => ({
      s0: s.s0, s1: s.s1, gap: s.gap, beadCount: s.beads.length,
    }));
    drawGapCurve(gapCanvas, segData);
    renderKpis(kpiHost, scheme, seg);
    renderBeadTable(tableHost, seg);
    renderAudit(auditHost, scheme);
  };

  // 分段选择
  segSelector.addEventListener('change', redraw);

  root.append(
    h('div', { class: 'panel' },
      h('h2', {}, '坡口多层多道自动排道 ', h('span', { class: 'tag' }, `焊缝：${seam.name}`)),
      h('div', { class: 'row', style: { marginBottom: '12px' } },
        h('button', { class: 'primary', onclick: () => {
          try {
            const name = `排道方案 ${new Date().toLocaleString('zh-CN', { hour12: false })}`;
            const { scheme: s } = buildScheme({
              workpieceId: store.currentWorkpiece()!.id,
              seam, wps, thermal: defaultThermal(), name,
            });
            scheme = s;
            void store.saveScheme(s);
            segSelector.innerHTML = '';
            s.segments.forEach((sg, i) => {
              const opt = document.createElement('option');
              opt.value = String(i);
              opt.textContent = `段 ${i + 1}（s=${(sg.s0).toFixed(2)}~${sg.s1.toFixed(2)}，间隙 ${sg.gap.toFixed(1)}mm，${sg.beads.length} 道）`;
              segSelector.appendChild(opt);
            });
            redraw();
            toast(s.audit.pass ? `排道完成，面积误差 ${s.audit.errorPct.toFixed(2)}%（≤3% 验收通过）` : '面积误差超 3%，请检查工艺参数', !s.audit.pass);
          } catch (err) {
            toast(`排道失败：${(err as Error).message}`, true);
          }
        } }, '执行自动排道'),
        h('label', { class: 'field', style: { margin: 0, minWidth: '320px' } },
          h('span', {}, '查看分段'), segSelector),
        h('div', { class: 'spacer', style: { flex: 1 } }),
        wpsSummary(wps),
      ),
      kpiHost,
      h('div', { class: 'two-canvas', style: { marginTop: '14px' } },
        h('div', { class: 'canvas-host' }, sectionCanvas,
          h('div', { class: 'hint' }, '绿=根焊 蓝=填充 橙=盖面，红虚圆=熔深范围')),
        h('div', {}, h('div', { class: 'canvas-host', style: { minHeight: '200px' } }, gapCanvas)),
      ),
      auditHost,
    ),
    h('div', { class: 'panel' }, h('h2', {}, '焊道明细（含焊丝指向偏移、工作角/行走角）'), tableHost),
    h('div', { class: 'panel' }, h('h2', {}, '焊接工艺 WPS 参数（可调后重新排道）'), wpsEditor()),
  );

  if (scheme) {
    scheme.segments.forEach((sg, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `段 ${i + 1}（间隙 ${sg.gap.toFixed(1)}mm，${sg.beads.length} 道）`;
      segSelector.appendChild(opt);
    });
    redraw();
  }
}

function wpsSummary(wps: { root: WpsParams; fill: WpsParams; cap: WpsParams }): HTMLElement {
  const geo = beadGeometry(wps.fill);
  return h('div', { class: 'muted mono', style: { fontSize: '11px' } },
    `填充道熔敷面积 ${geo.area.toFixed(1)}mm²  焊道 ${geo.width.toFixed(1)}×${geo.height.toFixed(1)}mm  熔深 ${geo.penetration.toFixed(1)}mm`);
}

function renderKpis(host: HTMLElement, scheme: PlanScheme, seg: PlanScheme['segments'][number]): void {
  clear(host);
  const areaOk = Math.abs(seg.areaErrorPct) <= 3;
  host.append(
    kpi(areaOk ? 'ok' : 'bad', `${fmt(seg.areaErrorPct, 2)}%`, '面积误差（验收 ≤3%）'),
    kpi('info', String(seg.beads.length), `本段焊道数 / ${seg.layers.length} 层`),
    kpi('info', `${fmt(seg.depositedArea, 0)} / ${fmt(seg.grooveArea, 0)}`, '熔敷 / 需求面积 mm²'),
    kpi('info', fmt(scheme.totalWireMass / 1000, 2), '焊丝用量 kg'),
    kpi('info', fmt(scheme.totalArcTime / 60, 1), '焊接工时 min'),
    kpi(scheme.totalWaitTime > 0 ? 'warn' : 'ok', fmt(scheme.totalWaitTime / 60, 1), '层间等待 min'),
  );
}

function kpi(cls: string, v: string, l: string): HTMLElement {
  return h('div', { class: `kpi ${cls}` }, h('div', { class: 'v' }, v), h('div', { class: 'l' }, l));
}

function renderAudit(host: HTMLElement, scheme: PlanScheme): void {
  clear(host);
  host.append(
    h('div', { style: { marginTop: '12px' } },
      h('span', { class: `badge ${scheme.audit.pass ? 'ok' : 'bad'}` },
        scheme.audit.pass ? '面积闭环验收通过' : '面积闭环未达标'),
      h('span', { class: 'muted', style: { marginLeft: '10px' } },
        `需求 ${fmt(scheme.audit.requiredArea, 1)}mm²，熔敷 ${fmt(scheme.audit.depositedArea, 1)}mm²，闭环迭代 ${scheme.audit.iterations} 次`),
      scheme.audit.adjustments.length
        ? h('ul', { style: { fontSize: '11px', color: 'var(--text-dim)', margin: '8px 0 0', paddingLeft: '18px' } },
          ...scheme.audit.adjustments.slice(0, 6).map((a) => h('li', {}, a)))
        : null,
    ),
  );
}

function renderBeadTable(host: HTMLElement, seg: PlanScheme['segments'][number]): void {
  clear(host);
  host.append(h('div', { class: 'table-wrap' },
    h('table', {},
      h('thead', {}, h('tr', {},
        h('th', {}, '道次'), h('th', {}, '层'), h('th', {}, '类型'),
        h('th', { class: 'num' }, '中心x'), h('th', { class: 'num' }, '中心y'),
        h('th', { class: 'num' }, '面积mm²'), h('th', { class: 'num' }, '熔深mm'),
        h('th', { class: 'num' }, '工作角°'), h('th', { class: 'num' }, '行走角°'),
        h('th', { class: 'num' }, '偏移mm'), h('th', { class: 'num' }, '电流A'),
        h('th', { class: 'num' }, '电压V'), h('th', { class: 'num' }, '焊速mm/s'),
        h('th', { class: 'num' }, '热输入kJ/mm'))),
      h('tbody', {}, ...seg.beads.map((b) =>
        h('tr', {},
          h('td', { class: 'num' }, String(b.index)),
          h('td', { class: 'num' }, String(b.layer)),
          h('td', {}, h('span', { class: 'badge info' }, b.role === 'root' ? '根焊' : b.role === 'cap' ? '盖面' : '填充')),
          h('td', { class: 'num' }, fmt(b.center.x, 1)),
          h('td', { class: 'num' }, fmt(b.center.y, 1)),
          h('td', { class: 'num' }, fmt(b.area, 1)),
          h('td', { class: 'num' }, fmt(b.penetration, 2)),
          h('td', { class: 'num' }, fmt(b.workAngleDeg, 1)),
          h('td', { class: 'num' }, fmt(b.travelAngleDeg, 1)),
          h('td', { class: 'num' }, fmt(b.pointerOffset, 1)),
          h('td', { class: 'num' }, String(b.current)),
          h('td', { class: 'num' }, String(b.voltage)),
          h('td', { class: 'num' }, fmt(b.travelSpeed, 1)),
          h('td', { class: 'num' }, fmt(b.heatInput, 3)),
        ))))));
}

function wpsEditor(): HTMLElement {
  const host = h('div', { class: 'grid-3' });
  const wpsList = store.state.wpsList;
  const draw = (): void => {
    clear(host);
    for (const w of wpsList) {
      const geo = beadGeometry(w);
      host.append(h('div', { class: 'panel', style: { margin: 0, background: 'var(--bg-card)' } },
        h('h2', {}, `${w.name} `, h('span', { class: 'tag' }, w.role)),
        numField('送丝速度 m/min', w.wfs, (v) => { w.wfs = v; }),
        numField('焊接速度 mm/s', w.travelSpeed, (v) => { w.travelSpeed = v; }),
        numField('电流 A', w.current, (v) => { w.current = v; }),
        numField('电压 V', w.voltage, (v) => { w.voltage = v; }),
        numField('熔敷效率', w.depositionEfficiency, (v) => { w.depositionEfficiency = v; }, 0.01),
        numField('摆宽 mm', w.weaveWidth, (v) => { w.weaveWidth = v; }),
        numField('摆频 Hz', w.weaveFreq, (v) => { w.weaveFreq = v; }, 0.1),
        h('div', { class: 'muted mono', style: { fontSize: '10.5px' } },
          `面积 ${geo.area.toFixed(1)}mm² 宽 ${geo.width.toFixed(1)} 高 ${geo.height.toFixed(1)} 熔深 ${geo.penetration.toFixed(1)}mm`),
        h('button', { style: { marginTop: '8px' }, onclick: () => { void store.saveWps(w); toast(`WPS「${w.name}」已保存，重新排道生效`); } }, '保存参数'),
      ));
    }
  };
  draw();
  return host;
}

function numField(label: string, value: number, set: (v: number) => void, step = 0.1): HTMLElement {
  return h('label', { class: 'field' }, h('span', {}, label),
    h('input', {
      type: 'number', step: String(step), value: String(value),
      onchange: (e: Event) => set(Number((e.target as HTMLInputElement).value)),
    }));
}
