import type { GrooveParams, Workpiece } from '../core/types';
import { TEMPLATES, createWorkpiece } from '../core/workpieces';
import { store } from './store';
import { clear, h, toast } from './dom';

export function renderWorkpiecePage(root: HTMLElement): void {
  clear(root);
  const wp = store.currentWorkpiece();

  root.append(
    h('div', { class: 'panel' },
      h('h2', {}, '工件库 ', h('span', { class: 'tag' }, '程序生成典型结构件，参数可编辑并持久化到 IndexedDB')),
      h('div', { class: 'grid-3' },
        ...Object.values(TEMPLATES).map((t) =>
          h('div', { class: 'kpi', style: { cursor: 'pointer' }, onclick: async () => {
            const w = createWorkpiece(t.id);
            await store.addWorkpiece(w);
            toast(`已生成「${w.name}」`);
          } },
            h('div', { class: 'l' }, t.name),
            h('div', { style: { fontSize: '11.5px', color: 'var(--text-dim)', minHeight: '46px' } }, t.desc),
            h('button', { class: 'primary', style: { marginTop: '6px' } }, '生成工件'),
          )),
      ),
    ),
  );

  if (!wp) {
    root.append(h('div', { class: 'panel empty' }, '还没有工件，先从上方生成一个典型件'));
    return;
  }

  root.append(renderWorkpieceList(wp), renderSeamEditor(wp));
}

function renderWorkpieceList(current: Workpiece): HTMLElement {
  return h('div', { class: 'panel' },
    h('h2', {}, '已存工件'),
    h('div', { class: 'table-wrap' },
      h('table', {},
        h('thead', {}, h('tr', {},
          h('th', {}, '名称'), h('th', {}, '类型'), h('th', {}, '板厚 mm'),
          h('th', {}, '外形 mm'), h('th', {}, '焊缝数'), h('th', {}, '操作'))),
        h('tbody', {},
          ...store.state.workpieces.map((w) =>
            h('tr', { style: w.id === current.id ? 'background:#1b3a57' : '' },
              h('td', {}, w.name),
              h('td', {}, TEMPLATES[w.template].name),
              h('td', { class: 'num' }, String(w.plateThickness)),
              h('td', { class: 'num' }, `${w.overallSize.x}×${w.overallSize.y}×${w.overallSize.z}`),
              h('td', { class: 'num' }, String(w.seams.length)),
              h('td', {}, h('div', { class: 'row' },
                h('button', { onclick: () => { store.state.currentWpId = w.id; store.state.currentSeamId = w.seams[0]?.id ?? null; store.emit(); } }, '打开'),
                h('button', { class: 'danger', onclick: async () => {
                  if (confirm(`删除工件「${w.name}」？`)) { await store.deleteWorkpiece(w.id); toast('已删除'); }
                } }, '删除'),
              )),
            )),
        ),
      ),
    ),
  );
}

function renderSeamEditor(wp: Workpiece): HTMLElement {
  const seam = store.currentSeam() ?? wp.seams[0];
  const g = seam.groove as GrooveParams;
  const field = (label: string, key: keyof GrooveParams, step: string, min: number, max: number): HTMLElement =>
    h('label', { class: 'field' }, h('span', {}, label),
      h('input', {
        type: 'number', step, min: String(min), max: String(max), value: String(g[key]),
        onchange: (e: Event) => {
          (g as unknown as Record<string, number>)[key] = Number((e.target as HTMLInputElement).value);
          void store.updateWorkpiece(wp);
          toast('坡口参数已保存');
        },
      }));

  return h('div', { class: 'panel' },
    h('h2', {}, '焊缝与坡口参数'),
    h('div', { class: 'pill-row', style: { marginBottom: '12px' } },
      ...wp.seams.map((s) =>
        h('button', {
          class: s.id === seam.id ? 'primary' : '',
          onclick: () => store.selectSeam(s.id),
        }, s.name))),
    h('div', { class: 'grid-side' },
      h('div', {},
        h('label', { class: 'field' }, h('span', {}, '接头形式'),
          h('select', { onchange: (e: Event) => { seam.jointKind = (e.target as HTMLSelectElement).value as typeof seam.jointKind; void store.updateWorkpiece(wp); } },
            h('option', { value: 'butt', selected: seam.jointKind === 'butt' ? 'true' : undefined }, '对接'),
            h('option', { value: 'tee', selected: seam.jointKind === 'tee' ? 'true' : undefined }, 'T 型'),
            h('option', { value: 'corner', selected: seam.jointKind === 'corner' ? 'true' : undefined }, '角接'),
          )),
        h('label', { class: 'field' }, h('span', {}, '坡口形式'),
          h('select', { onchange: (e: Event) => { g.kind = (e.target as HTMLSelectElement).value as GrooveParams['kind']; void store.updateWorkpiece(wp); } },
            ...(['V', 'X', 'U', 'fillet'] as const).map((k) =>
              h('option', { value: k, selected: g.kind === k ? 'true' : undefined },
                k === 'fillet' ? '角焊缝' : `${k} 形坡口`)),
          )),
        field('板厚 t (mm)', 'thickness', '1', 4, 120),
        field('坡口角度 α (°)', 'grooveAngleDeg', '1', 10, 70),
        field('钝边 p (mm)', 'rootFace', '0.5', 0, 12),
        field('根部间隙 g (mm)', 'rootGap', '0.5', 0, 12),
        field('余高 h (mm)', 'reinforcement', '0.1', 0, 8),
        field('U 形圆弧半径 (mm)', 'uRadius', '0.5', 3, 20),
        field('角焊缝焊脚 L (mm)', 'legSize', '1', 4, 40),
      ),
      h('div', {},
        h('label', { class: 'field' }, h('span', {}, '焊缝长度 (mm)'),
          h('input', { type: 'number', value: String(seam.length), onchange: (e) => {
            seam.length = Number((e.target as HTMLInputElement).value); void store.updateWorkpiece(wp);
          } })),
        h('label', { class: 'field' }, h('span', {}, `变间隙分段数（当前 ${seam.segments}）`),
          h('input', { type: 'range', min: '1', max: '16', value: String(seam.segments), oninput: (e: Event) => {
            seam.segments = Number((e.target as HTMLInputElement).value);
            (e.target as HTMLInputElement).previousElementSibling!.textContent = `变间隙分段数（当前 ${seam.segments}）`;
          }, onchange: () => void store.updateWorkpiece(wp) })),
        h('div', { class: 'panel', style: { background: 'var(--bg-card)' } },
          h('h2', {}, '激光寻位间隙序列'),
          gapEditor(seam),
        ),
      ),
    ),
  );
}

function gapEditor(seam: Workpiece['seams'][number]): HTMLElement {
  const rows = h('div', {});
  const draw = (): void => {
    clear(rows);
    if (!seam.gapSeries.length) {
      rows.append(h('div', { class: 'muted', style: { padding: '8px 0' } }, '当前使用恒定间隙（坡口根部间隙）。可导入或生成激光寻位序列。'));
      return;
    }
    rows.append(h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, '位置 s'), h('th', { class: 'num' }, '间隙 mm'))),
      h('tbody', {}, ...seam.gapSeries.map((st) =>
        h('tr', {}, h('td', { class: 'num' }, st.s.toFixed(2)), h('td', { class: 'num' }, st.gap.toFixed(2)))))));
  };
  draw();
  return h('div', {},
    rows,
    h('div', { class: 'row', style: { marginTop: '8px' } },
      h('button', { onclick: () => {
        // 模拟激光寻位：正弦变化间隙 2~7mm
        seam.gapSeries = Array.from({ length: 9 }, (_, i) => {
          const u = i / 8;
          return { s: u, gap: 2 + 5 * Math.sin(Math.PI * u) };
        });
        void store.updateWorkpiece(seam as unknown as Workpiece);
        draw();
        toast('已生成模拟激光寻位间隙序列');
      } }, '生成模拟序列'),
      h('button', { onclick: () => {
        const text = prompt('粘贴 CSV：每行 s,gap（s 为 0~1 归一化位置）', '0,2\n0.5,7\n1,2');
        if (!text) return;
        try {
          const stations = text.split(/\r?\n/).filter(Boolean).map((line) => {
            const [s, gap] = line.split(/[,，\s]+/).map(Number);
            if (isNaN(s) || isNaN(gap)) throw new Error('格式错误');
            return { s, gap };
          }).sort((a, b) => a.s - b.s);
          seam.gapSeries = stations;
          void store.updateWorkpiece(seam as unknown as Workpiece);
          draw();
          toast(`已导入 ${stations.length} 个测量截面`);
        } catch {
          toast('CSV 解析失败', true);
        }
      } }, '导入 CSV'),
      h('button', { class: 'danger', onclick: () => { seam.gapSeries = []; void store.updateWorkpiece(seam as unknown as Workpiece); draw(); } }, '清除'),
    ),
  );
}
