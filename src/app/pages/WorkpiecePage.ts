// ============================================================
// 页面1:工件库 —— 典型件生成 / 坡口参数编辑 / 激光间隙导入 / 3D 预览
// ============================================================

import type { GrooveParams, Seam, Workpiece, WorkpieceKind } from '../../core/types';
import { createWorkpiece, WORKPIECE_KIND_LABELS } from '../../core/defaults';
import { getState, saveWorkpiece, removeWorkpiece, update } from '../store';
import { el, clear, field, numInput, badge } from '../ui';
import { Scene3D } from '../viewer';
import { uid } from '../../core/db';

export class WorkpiecePage {
  private host: HTMLElement;
  private viewer?: Scene3D;
  private viewHost?: HTMLElement;

  constructor(host: HTMLElement) {
    this.host = host;
    this.render();
  }

  dispose(): void {
    this.viewer?.dispose();
  }

  private render(): void {
    const s = getState();
    clear(this.host);
    this.host.append(
      el('h2', { class: 'page-title' }, ['工件库 ', el('small', { text: '程序生成典型结构件,坡口/钝边/间隙/板厚可改,数据存 IndexedDB' })]),
    );
    const layout = el('div', { class: 'layout' });
    const left = el('div', { class: 'panel scroll-y' });
    const right = el('div', { class: 'panel' });
    layout.append(left, right);
    this.host.append(layout);

    // 左:新建 + 列表
    left.append(el('h3', { text: '典型工件生成' }));
    const kindRow = el('div', { class: 'btnrow' });
    (Object.keys(WORKPIEDE_KINDS) as WorkpieceKind[]).forEach((k) => {
      kindRow.append(el('button', { text: WORKPIECE_KIND_LABELS[k], onclick: () => this.create(k) }));
    });
    left.append(kindRow, el('div', { class: 'gap' }), el('h3', { text: `工件列表(${s.workpieces.length})` }));
    if (s.workpieces.length === 0) left.append(el('p', { class: 'muted', text: '暂无工件,点击上方按钮生成' }));
    for (const wp of s.workpieces) {
      const active = wp.id === s.currentWorkpieceId;
      const item = el('div', { class: 'listitem' + (active ? ' active' : ''), onclick: () => { update({ currentWorkpieceId: wp.id, currentSeamId: wp.seams[0]?.id ?? null }); this.render(); } }, [
        el('div', { class: 't row' }, [el('span', { text: wp.name }), el('span', { class: 'spacer' }), badge(WORKPIECE_KIND_LABELS[wp.kind], 'info')]),
        el('div', { class: 'd', text: `${wp.seams.length} 条焊缝 · 长 ${wp.extrudeLength}mm · ${wp.note ?? ''}` }),
        el('div', { class: 'btnrow' }, [
          el('button', { class: 'danger', text: '删除', onclick: (e) => { e.stopPropagation(); if (confirm(`删除工件「${wp.name}」?`)) removeWorkpiece(wp.id); } }),
        ]),
      ]);
      left.append(item);
    }

    this.renderRight(right);
  }

  private renderRight(right: HTMLElement): void {
    clear(right);
    const wp = getState().workpieces.find((w) => w.id === getState().currentWorkpieceId);
    if (!wp) {
      right.append(el('p', { class: 'muted', text: '← 请先生成或选择一个工件' }));
      return;
    }
    const seam = wp.seams.find((x) => x.id === getState().currentSeamId) ?? wp.seams[0];

    // 3D 预览
    this.viewHost = el('div', { class: 'canvas-host host-3d' }) as HTMLElement;
    right.append(el('h3', { text: '三维预览(拖动旋转/滚轮缩放)' }), this.viewHost);
    queueMicrotask(() => {
      this.viewer?.dispose();
      this.viewer = new Scene3D(this.viewHost!);
      this.viewer.showWorkpiece(wp);
    });

    // 焊缝选择
    const seamSel = el('select', {
      onchange: (e) => update({ currentSeamId: (e.target as HTMLSelectElement).value }),
    }, wp.seams.map((sm) => el('option', { value: sm.id, text: sm.name, ...(sm.id === seam?.id ? { selected: true } : {}) }))) as HTMLSelectElement;
    right.append(el('h3', { text: '焊缝与坡口参数' }), el('div', { class: 'row' }, [el('span', { class: 'muted', text: '焊缝:' }), seamSel]));

    if (seam) right.append(this.grooveForm(wp, seam));
  }

  private grooveForm(wp: Workpiece, seam: Seam): HTMLElement {
    const g = seam.groove;
    const box = el('div', {});
    const upd = (patch: Partial<GrooveParams>): void => {
      Object.assign(g, patch);
      void saveWorkpiece(wp);
      this.viewer?.showWorkpiece(wp);
    };
    const typeSel = el('select', {
      onchange: (e) => upd({ type: (e.target as HTMLSelectElement).value as GrooveParams['type'] }),
    }, (['square', 'singleV', 'doubleV', 'singleBevel', 'fillet'] as const).map((t) =>
      el('option', { value: t, text: t, ...(t === g.type ? { selected: true } : {}) }))) as HTMLSelectElement;

    box.append(
      field('坡口形式', typeSel),
      field('板厚 T', numInput(g.plateThickness, 1, (v) => upd({ plateThickness: v })), 'mm'),
      field('坡口角', numInput(g.bevelAngle, 1, (v) => upd({ bevelAngle: v })), '°'),
      field('钝边 p', numInput(g.rootFace, 0.5, (v) => upd({ rootFace: v })), 'mm'),
      field('根部间隙', numInput(g.rootGap, 0.1, (v) => upd({ rootGap: v })), 'mm'),
      field('余高 h', numInput(g.reinforcement, 0.1, (v) => upd({ reinforcement: v })), 'mm'),
    );
    if (g.type === 'fillet') {
      box.append(field('焊脚 K', numInput(g.legSize, 1, (v) => upd({ legSize: v })), 'mm'));
    }
    box.append(
      el('div', { class: 'gap' }),
      el('h3', { text: '激光寻位间隙序列(变间隙)' }),
      this.gapEditor(wp, seam),
    );
    return box;
  }

  private gapEditor(wp: Workpiece, seam: Seam): HTMLElement {
    const box = el('div', {});
    const ta = el('textarea', { rows: 5, placeholder: '每行:位置t(0~1),间隙mm;如 0.5,4.2' }) as HTMLTextAreaElement;
    ta.value = seam.gapProfile.map((p) => `${p.t},${p.gap}`).join('\n');
    const status = el('span', { class: 'muted', text: seam.gapProfile.length ? `已导入 ${seam.gapProfile.length} 个截面` : '未导入,使用固定根部间隙' });
    box.append(ta, el('div', { class: 'btnrow' }, [
      el('button', {
        text: '应用间隙序列', onclick: () => {
          const rows = ta.value.split(/\n+/).map((r) => r.trim()).filter(Boolean);
          const profile = rows.map((r) => {
            const [t, gap] = r.split(/[,\s]+/).map(parseFloat);
            return { t, gap };
          }).filter((p) => Number.isFinite(p.t) && Number.isFinite(p.gap))
            .map((p) => ({ t: Math.max(0, Math.min(1, p.t)), gap: Math.max(0, p.gap) }))
            .sort((a, b) => a.t - b.t);
          seam.gapProfile = profile;
          void saveWorkpiece(wp);
          status.textContent = `已导入 ${profile.length} 个截面`;
        },
      }),
      el('button', {
        class: 'ghost', text: '生成示例(正弦变间隙)', onclick: () => {
          const arr = Array.from({ length: 9 }, (_, i) => {
            const t = i / 8;
            return { t, gap: +(seam.groove.rootGap + 1.8 * Math.sin(t * Math.PI) + 0.4 * Math.sin(t * 9)).toFixed(2) };
          });
          ta.value = arr.map((p) => `${p.t},${p.gap}`).join('\n');
        },
      }),
      el('button', { class: 'danger', text: '清空', onclick: () => { seam.gapProfile = []; ta.value = ''; void saveWorkpiece(wp); status.textContent = '已清空,使用固定间隙'; } }),
    ]), el('div', { class: 'gap' }), status);
    return box;
  }

  private create(kind: WorkpieceKind): void {
    const wp = createWorkpiece(kind);
    // 保证 id 唯一
    wp.id = uid('wp');
    void saveWorkpiece(wp).then(() => {
      update({ currentWorkpieceId: wp.id, currentSeamId: wp.seams[0]?.id ?? null });
      this.render();
    });
  }
}

const WORKPIEDE_KINDS: Record<WorkpieceKind, string> = WORKPIECE_KIND_LABELS;
