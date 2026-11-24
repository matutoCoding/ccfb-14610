import type { DefectMark, PlannedBead, Vec2 } from '../core/types';
import type { GrooveSection } from '../core/groove';
import { polygonBounds } from '../core/geometry';

export interface SectionDrawOptions {
  showDefects?: DefectMark[];
  highlightBead?: number;
  showFusion?: boolean;
  showLabels?: boolean;
}

/** 在 canvas 上绘制坡口填充区 + 焊道（等面积圆）+ 缺陷标注 */
export function drawSection(
  canvas: HTMLCanvasElement,
  section: GrooveSection,
  beads: PlannedBead[],
  opts: SectionDrawOptions = {},
): void {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const W = rect.width, H = rect.height;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const b = polygonBounds(section.plates.length ? section.plates : section.fill);
  const pad = 28;
  const scale = Math.min((W - pad * 2) / (b.maxX - b.minX), (H - pad * 2) / (b.maxY - b.minY));
  const ox = (W - (b.maxX - b.minX) * scale) / 2 - b.minX * scale;
  const oy = H - pad - (-b.minY) * scale;
  const X = (x: number): number => ox + x * scale;
  const Y = (y: number): number => oy - y * scale;

  // 母材
  ctx.beginPath();
  section.plates.forEach((p, i) => {
    if (i === 0) ctx.moveTo(X(p.x), Y(p.y));
    else ctx.lineTo(X(p.x), Y(p.y));
  });
  ctx.closePath();
  ctx.fillStyle = '#2a3646';
  ctx.fill();
  ctx.strokeStyle = '#46586e';
  ctx.lineWidth = 1;
  ctx.stroke();

  // 坡口填充区（淡色底）
  ctx.beginPath();
  section.fill.forEach((p, i) => {
    if (i === 0) ctx.moveTo(X(p.x), Y(p.y));
    else ctx.lineTo(X(p.x), Y(p.y));
  });
  ctx.closePath();
  ctx.fillStyle = 'rgba(59,157,255,0.08)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(59,157,255,0.5)';
  ctx.stroke();

  // 侧壁熔合线
  ctx.strokeStyle = '#f0a93b';
  ctx.lineWidth = 1.4;
  for (const sw of section.sidewalls) {
    ctx.beginPath();
    ctx.moveTo(X(sw.a.x), Y(sw.a.y));
    ctx.lineTo(X(sw.b.x), Y(sw.b.y));
    ctx.stroke();
  }

  // 焊道（等面积圆 + 熔深虚圆）
  const layerColor = (role: PlannedBead['role']): string =>
    role === 'root' ? '#2fbf71' : role === 'cap' ? '#f0a93b' : '#3b9dff';
  for (const bead of beads) {
    const cx = X(bead.center.x), cy = Y(bead.center.y);
    const r = bead.radiusEq * scale;
    const hl = opts.highlightBead === bead.index;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = layerColor(bead.role) + (hl ? '' : '55');
    ctx.fill();
    ctx.strokeStyle = hl ? '#fff' : layerColor(bead.role);
    ctx.lineWidth = hl ? 2 : 1;
    ctx.stroke();
    if (opts.showFusion) {
      ctx.beginPath();
      ctx.arc(cx, cy, (bead.radiusEq + bead.penetration) * scale, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(239,91,91,0.55)';
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 0.8;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (opts.showLabels && beads.length <= 40) {
      ctx.fillStyle = '#d7e0ea';
      ctx.font = '9px Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(bead.index), cx, cy);
    }
  }

  // 缺陷圈注
  if (opts.showDefects) {
    for (const m of opts.showDefects) {
      const cx = X(m.position.x), cy = Y(m.position.y);
      ctx.beginPath();
      ctx.arc(cx, cy, 11, 0, Math.PI * 2);
      ctx.strokeStyle = m.severity === 'bad' ? '#ef5b5b' : '#f0a93b';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = m.severity === 'bad' ? '#ef5b5b' : '#f0a93b';
      ctx.font = 'bold 11px Consolas';
      ctx.textAlign = 'center';
      ctx.fillText('!', cx, cy + 1);
    }
  }

  // 坐标轴标注
  ctx.fillStyle = '#8494a6';
  ctx.font = '10px Consolas';
  ctx.textAlign = 'left';
  ctx.fillText(`坡口 ${section.requiredArea.toFixed(0)}mm²`, 8, 14);
}

/** 绘制间隙-道次沿焊缝曲线（变间隙） */
export function drawGapCurve(
  canvas: HTMLCanvasElement,
  segData: Array<{ s0: number; s1: number; gap: number; beadCount: number }>,
): void {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = rect.width, H = rect.height, pad = 34;
  ctx.clearRect(0, 0, W, H);
  const maxGap = Math.max(...segData.map((s) => s.gap), 1);
  const maxBeads = Math.max(...segData.map((s) => s.beadCount), 1);
  const X = (s: number): number => pad + s * (W - pad * 2);
  const Y = (v: number, max: number): number => H - pad - (v / max) * (H - pad * 2);

  // 间隙面积柱
  ctx.fillStyle = 'rgba(59,157,255,0.35)';
  for (const seg of segData) {
    const x0 = X(seg.s0), x1 = X(seg.s1);
    const y = Y(seg.gap, maxGap * 1.15);
    ctx.fillRect(x0 + 1, y, Math.max(1, x1 - x0 - 2), H - pad - y);
  }
  // 道次折线
  ctx.strokeStyle = '#f0a93b';
  ctx.lineWidth = 2;
  ctx.beginPath();
  segData.forEach((seg, i) => {
    const x = X((seg.s0 + seg.s1) / 2), y = Y(seg.beadCount, maxBeads * 1.15);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = '#f0a93b';
  for (const seg of segData) {
    ctx.beginPath();
    ctx.arc(X((seg.s0 + seg.s1) / 2), Y(seg.beadCount, maxBeads * 1.15), 3, 0, Math.PI * 2);
    ctx.fill();
  }
  // 轴
  ctx.strokeStyle = '#46586e';
  ctx.beginPath(); ctx.moveTo(pad, pad); ctx.lineTo(pad, H - pad); ctx.lineTo(W - pad, H - pad); ctx.stroke();
  ctx.fillStyle = '#8494a6';
  ctx.font = '10px Consolas';
  ctx.fillText('间隙(mm,蓝)/道次数(橙)', pad, 14);
  ctx.fillText('0', pad - 4, H - pad + 12);
  ctx.fillText('焊缝长度 →', W - pad - 60, H - 8);
}

export function vecStr(v: Vec2): string { return `(${v.x.toFixed(1)}, ${v.y.toFixed(1)})`; }
