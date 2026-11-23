// ============================================================
// UI 工具:DOM 构建、截面 Canvas 视图、折线图
// ============================================================

import type { BeadPlacement, Vec2 } from '../core/types';
import type { FusionIssue } from '../core/types';
import type { GrooveGeometry } from '../core/groove';

type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | ((e: Event) => void)> = {},
  children: Child[] | Child = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = String(v);
    else if (k === 'text') node.textContent = String(v);
    else if (k === 'html') node.innerHTML = String(v);
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v as (e: Event) => void);
    } else if (k === 'value') (node as HTMLInputElement).value = String(v);
    else if (k === 'disabled' && v) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  const kids = Array.isArray(children) ? children : [children];
  for (const c of kids) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function clear(node: HTMLElement): HTMLElement {
  node.innerHTML = '';
  return node;
}

export function field(label: string, input: HTMLElement, unit = ''): HTMLElement {
  return el('label', { class: 'field' }, [el('span', { text: label }), input, unit ? el('em', { text: unit }) : null]);
}

export function numInput(value: number, step: number, onChange: (v: number) => void): HTMLInputElement {
  const inp = el('input', { type: 'number', step, value }) as HTMLInputElement;
  inp.addEventListener('change', () => onChange(parseFloat(inp.value) || 0));
  return inp;
}

// ---------------- 截面视图 ----------------

const LAYER_COLORS = ['#e8a33d', '#e07b39', '#d95f43', '#c94752', '#9c3d8a', '#5b6ee1', '#3d9ae0', '#37b89a'];

export function beadColor(b: BeadPlacement): string {
  if (b.role === 'root') return '#ff7043';
  if (b.role === 'cap') return '#7e9cff';
  return LAYER_COLORS[b.layer % LAYER_COLORS.length];
}

export class SectionView {
  private ctx: CanvasRenderingContext2D;
  private scale = 10;
  private ox = 0;
  private oy = 0;

  constructor(public canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  fit(points: Vec2[], padding = 24): void {
    const w = this.canvas.width;
    const h = this.canvas.height;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of points) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    const bw = Math.max(1, maxX - minX);
    const bh = Math.max(1, maxY - minY);
    this.scale = Math.min((w - padding * 2) / bw, (h - padding * 2) / bh);
    this.ox = (w - bw * this.scale) / 2 - minX * this.scale;
    this.oy = h - (h - bh * this.scale) / 2 + minY * this.scale; // y 翻转
  }

  tx(x: number): number {
    return this.ox + x * this.scale;
  }
  ty(y: number): number {
    return this.oy - y * this.scale;
  }
  ts(v: number): number {
    return v * this.scale;
  }

  clear(bg = '#141a22'): void {
    this.ctx.fillStyle = bg;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  polygon(poly: Vec2[], fill: string, stroke = '#3a4556', lw = 1.5): void {
    const c = this.ctx;
    c.beginPath();
    poly.forEach((p, i) => (i === 0 ? c.moveTo(this.tx(p.x), this.ty(p.y)) : c.lineTo(this.tx(p.x), this.ty(p.y))));
    c.closePath();
    c.fillStyle = fill;
    c.fill();
    c.strokeStyle = stroke;
    c.lineWidth = lw;
    c.stroke();
  }

  plates(polys: { name: string; polygon: Vec2[] }[]): void {
    for (const p of polys) {
      this.polygon(p.polygon, '#232c3a', '#46546b', 1);
      const c0 = p.polygon[0];
      this.ctx.fillStyle = '#7f8da3';
      this.ctx.font = '11px sans-serif';
      this.ctx.fillText(p.name, this.tx(c0.x) + 2, this.ty(c0.y) - 2);
    }
  }

  bead(b: BeadPlacement, highlight = false): void {
    const c = this.ctx;
    c.beginPath();
    c.arc(this.tx(b.center.x), this.ty(b.center.y), this.ts(b.radius), 0, Math.PI * 2);
    c.fillStyle = beadColor(b) + (highlight ? '' : 'cc');
    c.fill();
    c.strokeStyle = highlight ? '#fff' : 'rgba(0,0,0,0.45)';
    c.lineWidth = highlight ? 2 : 1;
    c.stroke();
    if (this.scale > 4) {
      c.fillStyle = 'rgba(20,26,34,0.85)';
      c.font = `${Math.min(12, this.ts(b.radius) * 0.7)}px sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(String(b.pass + 1), this.tx(b.center.x), this.ty(b.center.y));
      c.textAlign = 'start';
      c.textBaseline = 'alphabetic';
    }
  }

  aim(b: BeadPlacement): void {
    const c = this.ctx;
    c.beginPath();
    c.moveTo(this.tx(b.center.x), this.ty(b.center.y));
    c.lineTo(this.tx(b.center.x + b.aimOffset.x * 2.2), this.ty(b.center.y + b.aimOffset.y * 2.2));
    c.strokeStyle = '#ffd54f';
    c.lineWidth = 1.2;
    c.stroke();
  }

  issues(list: FusionIssue[]): void {
    const c = this.ctx;
    for (const it of list) {
      c.beginPath();
      c.arc(this.tx(it.position.x), this.ty(it.position.y), 8 + it.severity * 6, 0, Math.PI * 2);
      c.strokeStyle = it.kind === 'sidewallLack' ? '#ff5252' : '#ffca28';
      c.lineWidth = 2.5;
      c.stroke();
    }
  }

  text(s: string, x: number, y: number, color = '#c8d2e0'): void {
    this.ctx.fillStyle = color;
    this.ctx.font = '12px sans-serif';
    this.ctx.fillText(s, x, y);
  }

  grid(): void {
    const c = this.ctx;
    c.strokeStyle = 'rgba(255,255,255,0.05)';
    c.lineWidth = 1;
    for (let x = 0; x < this.canvas.width; x += 40) {
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, this.canvas.height);
      c.stroke();
    }
    for (let y = 0; y < this.canvas.height; y += 40) {
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(this.canvas.width, y);
      c.stroke();
    }
  }
}

export function drawGrooveSection(
  canvas: HTMLCanvasElement,
  geom: GrooveGeometry,
  beads: BeadPlacement[],
  opts: { showAim?: boolean; issues?: FusionIssue[]; showPlates?: boolean } = {},
): SectionView {
  const v = new SectionView(canvas);
  v.clear();
  v.grid();
  const all = [...geom.cavity, ...geom.plates.flatMap((p) => p.polygon), ...beads.map((b) => b.center)];
  v.fit(all);
  if (opts.showPlates !== false) v.plates(geom.plates);
  v.polygon(geom.cavity, 'rgba(70,90,120,0.25)', '#6fa8dc', 2);
  for (const b of beads) v.bead(b);
  if (opts.showAim) for (const b of beads) v.aim(b);
  if (opts.issues) v.issues(opts.issues);
  return v;
}

// ---------------- 折线图 ----------------

export interface ChartSeries {
  name: string;
  color: string;
  points: { x: number; y: number }[];
  dashed?: boolean;
}

export function drawChart(canvas: HTMLCanvasElement, series: ChartSeries[], yLabel = ''): void {
  const ctx = canvas.getContext('2d')!;
  const W = canvas.width;
  const H = canvas.height;
  ctx.fillStyle = '#141a22';
  ctx.fillRect(0, 0, W, H);
  const pad = { l: 52, r: 14, t: 26, b: 34 };
  const all = series.flatMap((s) => s.points);
  if (all.length === 0) return;
  let minX = Math.min(...all.map((p) => p.x));
  let maxX = Math.max(...all.map((p) => p.x));
  let minY = Math.min(...all.map((p) => p.y));
  let maxY = Math.max(...all.map((p) => p.y));
  if (minY === maxY) {
    minY -= 1;
    maxY += 1;
  }
  minY = Math.min(0, minY);
  const px = (x: number): number => pad.l + ((x - minX) / (maxX - minX || 1)) * (W - pad.l - pad.r);
  const py = (y: number): number => H - pad.b - ((y - minY) / (maxY - minY)) * (H - pad.t - pad.b);

  // 坐标网格
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.fillStyle = '#8fa0b8';
  ctx.font = '11px sans-serif';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + ((H - pad.t - pad.b) / 4) * i;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(W - pad.r, y);
    ctx.stroke();
    const val = maxY - ((maxY - minY) / 4) * i;
    ctx.fillText(val.toFixed(1), 6, y + 4);
  }
  ctx.fillText(yLabel, 6, 14);

  for (const s of series) {
    ctx.beginPath();
    s.points.forEach((p, i) => (i === 0 ? ctx.moveTo(px(p.x), py(p.y)) : ctx.lineTo(px(p.x), py(p.y))));
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    ctx.setLineDash(s.dashed ? [5, 4] : []);
    ctx.stroke();
    ctx.setLineDash([]);
    s.points.forEach((p) => {
      ctx.beginPath();
      ctx.arc(px(p.x), py(p.y), 2.5, 0, Math.PI * 2);
      ctx.fillStyle = s.color;
      ctx.fill();
    });
  }
  // 图例
  let lx = pad.l;
  ctx.font = '12px sans-serif';
  for (const s of series) {
    ctx.fillStyle = s.color;
    ctx.fillRect(lx, 8, 14, 4);
    ctx.fillStyle = '#c8d2e0';
    ctx.fillText(s.name, lx + 18, 13);
    lx += ctx.measureText(s.name).width + 34;
  }
}

export function badge(text: string, kind: 'ok' | 'warn' | 'err' | 'info' = 'info'): HTMLElement {
  return el('span', { class: `badge badge-${kind}`, text });
}

export function download(filename: string, content: string, mime = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = el('a') as HTMLAnchorElement;
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
