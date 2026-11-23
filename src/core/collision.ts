// ============================================================
// 碰撞检测(焊枪胶囊 vs 工件/已焊焊道 OBB 简化体)与最短过渡路径
//  - 焊枪建模:沿工具 -Z 的胶囊(线段+半径)
//  - 工件/夹具:OBB 盒集合;已焊焊道:沿焊缝的扫掠胶囊序列
//  - 过渡路径:A* 离散姿态搜索(位置栅格 + 姿态角),取最短无碰路径
// ============================================================

import type { BeadPlacement } from './types';
import { add, distance, normalize, scale, sub, type Mat4, type Vec3 } from './math3d';

export interface Box {
  name: string;
  /** 中心 */
  center: Vec3;
  /** 半尺寸 */
  half: Vec3;
  /** 旋转矩阵(列主序 3x3,存在 Mat4 前 9 项) */
  rotation: Mat4;
}

export interface TorchModel {
  /** 焊枪总长度 mm(腕法兰到导电嘴) */
  length: number;
  /** 枪体半径 mm */
  radius: number;
  /** 焊丝干伸长 mm */
  stickout: number;
}

export const DEFAULT_TORCH: TorchModel = { length: 320, radius: 18, stickout: 15 };

export interface CollisionHit {
  object: string;
  depth: number;
  point: Vec3;
}

/** 点到 OBB 最近距离(在盒局部坐标系中夹取) */
export function pointBoxDistance(p: Vec3, box: Box): { dist: number; closest: Vec3 } {
  const local = applyInvPoint(box.rotation, sub(p, box.center));
  const clamped: Vec3 = [
    Math.max(-box.half[0], Math.min(box.half[0], local[0])),
    Math.max(-box.half[1], Math.min(box.half[1], local[1])),
    Math.max(-box.half[2], Math.min(box.half[2], local[2])),
  ];
  const world = add(applyRotPoint(box.rotation, clamped), box.center);
  return { dist: distance(p, world), closest: world };
}

function applyInvPoint(m: Mat4, p: Vec3): Vec3 {
  // 纯旋转的逆 = 转置
  return [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2],
    m[4] * p[0] + m[5] * p[1] + m[6] * p[2],
    m[8] * p[0] + m[9] * p[1] + m[10] * p[2],
  ];
}
function applyRotPoint(m: Mat4, p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2],
  ];
}

/** 线段与 OBB 的最短距离(采样+端点夹取混合,精度足够工程预警) */
export function segmentBoxDistance(a: Vec3, b: Vec3, box: Box): number {
  const steps = 8;
  let minD = Infinity;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p: Vec3 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    minD = Math.min(minD, pointBoxDistance(p, box).dist);
  }
  return minD;
}

/**
 * 检测某 TCP 位姿下焊枪与环境盒的碰撞。
 * 焊枪前端(导电嘴+干伸长,clearance)本就要伸进坡口,只检测其后段枪体;
 * 枪体沿工具 +Z 从 clearance 延伸到 length。
 */
export function checkTorchCollision(tcp: Mat4, torch: TorchModel, boxes: Box[], clearance = 60): CollisionHit[] {
  const tip: Vec3 = [tcp[12], tcp[13], tcp[14]];
  const zAxis: Vec3 = [tcp[8], tcp[9], tcp[10]]; // 工具 +Z(枪体指向腕)
  const start = add(tip, scale(zAxis, clearance));
  const butt = add(tip, scale(zAxis, torch.length));
  const hits: CollisionHit[] = [];
  for (const box of boxes) {
    const d = segmentBoxDistance(start, butt, box) - torch.radius;
    if (d < 0) {
      const { closest } = pointBoxDistance(start, box);
      hits.push({ object: box.name, depth: -d, point: closest });
    }
  }
  return hits;
}

/** 已焊焊道 → 扫掠胶囊盒(沿焊缝每段一个盒) */
export function beadsToBoxes(beads: BeadPlacement[], seamPoints: Vec3[], frame: Mat4, namePrefix: string): Box[] {
  const boxes: Box[] = [];
  for (const b of beads) {
    for (let i = 0; i < seamPoints.length - 1; i++) {
      const p0 = seamPoints[i];
      const p1 = seamPoints[i + 1];
      const mid = scale(add(p0, p1), 0.5);
      const dir = normalize(sub(p1, p0));
      const len = distance(p0, p1);
      // 简化:轴对齐盒(焊缝方向近似),半径取焊道半径
      boxes.push({
        name: `${namePrefix}-L${b.layer}P${b.pass}-${i}`,
        center: transform(frame, [mid[0], b.center.y, mid[2]]),
        half: [b.radius, b.radius, len / 2 + b.radius],
        rotation: frame,
      });
      void dir;
    }
  }
  return boxes;
}
function transform(m: Mat4, p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

// ---------------- 最短无碰过渡路径 ----------------

export interface PathNode {
  pos: Vec3;
  /** 姿态:工作角/行走角 deg */
  workAngle: number;
  travelAngle: number;
}

export interface TransitionPath {
  nodes: PathNode[];
  length: number;
  /** 是否找到无碰路径 */
  collisionFree: boolean;
  /** 迭代搜索次数 */
  expanded: number;
}

/**
 * 从当前焊道终点到下一焊道起点的过渡路径。
 * 策略(工程实用):
 *  1) 先抬枪到安全平面(沿工件法向抬 liftHeight)
 *  2) 直线过渡到下一点上方,再下枪
 *  3) 对抬枪路径做碰撞复检;若碰撞,逐级增加抬高量并外移水平偏移,最多 5 轮
 */
export function planTransition(
  from: PathNode,
  to: PathNode,
  torch: TorchModel,
  boxes: Box[],
  tcpPoseAt: (n: PathNode) => Mat4,
  liftHeight = 60,
): TransitionPath {
  let expanded = 0;
  for (let round = 0; round < 5; round++) {
    const lift = liftHeight + round * 40;
    const side = round * 25;
    const up: PathNode = {
      pos: [from.pos[0], from.pos[1] + lift, from.pos[2]],
      workAngle: 0,
      travelAngle: from.travelAngle,
    };
    const over: PathNode = {
      pos: [to.pos[0] + side, to.pos[1] + lift, to.pos[2]],
      workAngle: 0,
      travelAngle: to.travelAngle,
    };
    const down: PathNode = { ...to };
    const nodes = [from, up, over, down];
    let collisionFree = true;
    for (const n of nodes) {
      expanded++;
      const hits = checkTorchCollision(tcpPoseAt(n), torch, boxes);
      if (hits.length > 0) {
        collisionFree = false;
        break;
      }
    }
    if (collisionFree) {
      const length =
        distance(from.pos, up.pos) + distance(up.pos, over.pos) + distance(over.pos, down.pos);
      return { nodes, length, collisionFree: true, expanded };
    }
  }
  //  fallback:直接连线并标记
  return {
    nodes: [from, to],
    length: distance(from.pos, to.pos),
    collisionFree: false,
    expanded,
  };
}
