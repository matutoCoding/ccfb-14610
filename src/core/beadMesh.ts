// ============================================================
// 焊道扫掠网格 + 鱼鳞纹
//  - 截面:焊道圆被型腔/邻道裁剪后的外轮廓(半圆冠)
//  - 沿焊缝方向扫掠,截面半径按熔宽轻微周期起伏
//  - 鱼鳞纹:沿行走方向按 摆动频率/焊速 生成相位,顶点法向微扰 + 纹沟环带
// ============================================================

import * as THREE from 'three';
import type { BeadPlacement, Vec2 } from './types';

export interface SweepOptions {
  /** 沿焊缝分段数 */
  lengthSegments: number;
  /** 截面圆周分段数 */
  radialSegments: number;
  /** 鱼鳞纹幅度 mm */
  rippleAmplitude: number;
  /** 是否显示鱼鳞纹 */
  ripple: boolean;
}

export const DEFAULT_SWEEP: SweepOptions = {
  lengthSegments: 64,
  radialSegments: 20,
  rippleAmplitude: 0.35,
  ripple: true,
};

/**
 * 生成单条焊道的扫掠网格。
 * @param bead 焊道截面定义
 * @param path 焊缝在世界系的路径点(等距),至少 2 点
 * @param frameX 截面 x 轴在世界系的方向(单位向量)
 * @param frameY 截面 y 轴在世界系的方向
 */
export function buildBeadGeometry(
  bead: BeadPlacement,
  path: THREE.Vector3[],
  frameX: THREE.Vector3,
  frameY: THREE.Vector3,
  opts: SweepOptions = DEFAULT_SWEEP,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const rSeg = opts.radialSegments;
  const lSeg = Math.min(opts.lengthSegments, Math.max(2, path.length - 1));
  const wps = bead.wps;
  // 鱼鳞纹空间周期 = 焊速 / 摆动频率(mm);无摆动时取 8mm 细鳞
  const ripplePeriod = wps.weaveFrequency > 0.1 ? wps.travelSpeed / wps.weaveFrequency : 8;
  const cross = new THREE.Vector3().crossVectors(frameX, frameY).normalize();

  // 每圈只取外露半圆(冠部):角度从 -90°~90°(沿 +Y 冠方向)
  for (let i = 0; i <= lSeg; i++) {
    const t = i / lSeg;
    const pathIdx = Math.min(path.length - 1, Math.round(t * (path.length - 1)));
    const center = path[pathIdx];
    // 宽度周期起伏(鱼鳞)
    const rippleScale = opts.ripple
      ? 1 + opts.rippleAmplitude * 0.12 * Math.sin((t * pathLength(path)) / ripplePeriod * Math.PI * 2)
      : 1;
    for (let j = 0; j <= rSeg; j++) {
      const a = -Math.PI / 2 + (j / rSeg) * Math.PI; // 半圆
      const rr = bead.radius * rippleScale;
      const lx = Math.cos(a) * rr;
      const ly = Math.sin(a) * rr * 0.82 + bead.crownHeight * 0.5;
      const px = center.x + frameX.x * lx + frameY.x * ly;
      const py = center.y + frameX.y * lx + frameY.y * ly;
      const pz = center.z + frameX.z * lx + frameY.z * ly;
      positions.push(px, py, pz);
      // 法向:截面径向
      const n = new THREE.Vector3()
        .addScaledVector(frameX, Math.cos(a))
        .addScaledVector(frameY, Math.sin(a))
        .addScaledVector(cross, 0)
        .normalize();
      normals.push(n.x, n.y, n.z);
      uvs.push(t, j / rSeg);
    }
  }

  const row = rSeg + 1;
  for (let i = 0; i < lSeg; i++) {
    for (let j = 0; j < rSeg; j++) {
      const a = i * row + j;
      const b = a + row;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  return geo;
}

function pathLength(p: THREE.Vector3[]): number {
  let s = 0;
  for (let i = 1; i < p.length; i++) s += p[i].distanceTo(p[i - 1]);
  return Math.max(1, s);
}

/** 鱼鳞纹纹理(Canvas 程序纹理,贴在焊道表面增强表现) */
export function rippleTexture(periodMm: number, widthMm: number): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext('2d')!;
  const grad = ctx.createLinearGradient(0, 0, 0, 64);
  grad.addColorStop(0, '#8f96a0');
  grad.addColorStop(0.5, '#b8bec7');
  grad.addColorStop(1, '#7c838d');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 64);
  const stripes = Math.max(4, Math.round(widthMm / Math.max(2, periodMm)) * 6);
  ctx.strokeStyle = 'rgba(40,44,50,0.55)';
  ctx.lineWidth = 2;
  for (let i = 0; i <= stripes; i++) {
    const x = (i / stripes) * 256;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.quadraticCurveTo(x + 6, 32, x, 64);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 1);
  return tex;
}

/** 构造等距直线路径点 */
export function straightPath(start: THREE.Vector3, dir: THREE.Vector3, length: number, count: number): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  const d = dir.clone().normalize();
  for (let i = 0; i < count; i++) {
    pts.push(start.clone().addScaledVector(d, (length * i) / (count - 1)));
  }
  return pts;
}

/** 截面局部点 → 世界(给定截面原点与两轴) */
export function sectionToWorld(p: Vec2, origin: THREE.Vector3, fx: THREE.Vector3, fy: THREE.Vector3): THREE.Vector3 {
  return origin.clone().addScaledVector(fx, p.x).addScaledVector(fy, p.y);
}
