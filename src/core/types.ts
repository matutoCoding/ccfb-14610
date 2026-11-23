// ============================================================
// 全局数据模型:工件 / 焊缝 / 坡口 / WPS / 排道方案 / 机器人 / 程序
// 单位约定:长度 mm,角度 deg(内部计算用 rad),温度 ℃,时间 s,电流 A,电压 V
// ============================================================

export type Vec2 = { x: number; y: number };

/** 焊缝接头形式 */
export type JointType = 'butt' | 'tee' | 'corner' | 'lap';

/** 坡口截面形式 */
export type GrooveType = 'square' | 'singleV' | 'doubleV' | 'singleBevel' | 'fillet';

/** 典型工件类型 */
export type WorkpieceKind = 'boomBox' | 'stickRib' | 'variableButt';

/** 坡口几何参数(截面,局部坐标:y=0 为板厚中部参考面,焊缝沿 z 方向) */
export interface GrooveParams {
  type: GrooveType;
  plateThickness: number;   // 板厚 T mm
  bevelAngle: number;      // 单边/总坡口角度约定见各类型,deg
  rootFace: number;        // 钝边高度 p mm
  rootGap: number;         // 装配间隙 g mm
  reinforcement: number;   // 余高 h mm
  legSize: number;         // 角焊缝焊脚 K mm(tee/corner/fillet 用)
  bothSide: boolean;       // 是否双面坡口(doubleV)
}

/** 沿焊缝某一截面位置的实测/给定间隙(激光寻位导入) */
export interface GapSample {
  /** 沿焊缝归一化位置 0~1 */
  t: number;
  /** 该位置实测根部间隙 mm */
  gap: number;
  /** 可选:实测错边量 mm */
  mismatch?: number;
}

/** 焊缝定义:工件上的一条焊缝 */
export interface Seam {
  id: string;
  name: string;
  joint: JointType;
  groove: GrooveParams;
  /** 焊缝长度 mm(沿 z) */
  length: number;
  /** 焊缝在工件坐标系中的起点/终点(简化为直线/可带方向),mm */
  start: [number, number, number];
  end: [number, number, number];
  /** 截面间隙序列;为空表示全段使用 groove.rootGap */
  gapProfile: GapSample[];
  /** 焊脚方向(角接用):截面内两壁的单位方向,程序生成工件时填 */
  wallHint?: { vertical: Vec2; horizontal: Vec2 };
}

/** 工件 */
export interface Workpiece {
  id: string;
  name: string;
  kind: WorkpieceKind;
  createdAt: number;
  updatedAt: number;
  /** 截面外轮廓(用于 3D 拉伸与剖面显示),局部坐标 xy */
  outline: Vec2[];
  /** 板件分块轮廓(用于 3D 分色显示),如箱体的翼板/腹板 */
  plates: { name: string; polygon: Vec2[]; thickness: number }[];
  /** 截面拉伸长度 mm */
  extrudeLength: number;
  seams: Seam[];
  /** 备注 */
  note?: string;
}

/** 单道焊接工艺参数(一层内可按道次微调,先给基准 WPS) */
export interface WpsParams {
  id: string;
  name: string;
  process: 'GMAW' | 'FCAW' | 'SAW' | 'GTAW';
  wireDiameter: number;      // 焊丝直径 mm
  wireFeedSpeed: number;     // 送丝速度 m/min
  travelSpeed: number;       // 焊接速度 mm/s
  voltage: number;           // 电弧电压 V
  current: number;           // 焊接电流 A
  depositionEfficiency: number; // 熔敷效率 η 0~1
  weaveWidth: number;        // 摆动宽度 mm(0 不摆)
  weaveFrequency: number;    // 摆动频率 Hz
  workAngle: number;         // 工作角 deg(截面内,相对参考壁)
  travelAngle: number;       // 行走角 deg(沿焊缝方向,推/拉)
  stickout: number;          // 干伸长 mm
  /** 热输入相关 */
  arcEfficiency: number;     // 电弧热效率 η_h
  interpassLimit: number;    // 层间温度上限 ℃
  ambientTemp: number;       // 环境温度 ℃
  preheatTemp: number;       // 预热温度 ℃
  coolingK: number;          // 冷却时间常数经验系数 s(简化集总模型)
  wireDensity: number;       // 焊丝密度 g/cm³(钢 7.85)
}

/** 单道焊道在某一截面上的落点描述 */
export interface BeadPlacement {
  layer: number;             // 层号(0 起)
  pass: number;              // 道号(整条累计,0 起)
  passInLayer: number;       // 层内道号(0 起)
  center: Vec2;              // 焊道截面圆心/形心
  radius: number;            // 等效熔敷圆半径
  crownHeight: number;       // 冠高(余高贡献)
  penetration: number;       // 熔深 mm(向母材/前道方向)
  width: number;             // 焊道宽度
  area: number;              // 该道熔敷金属截面积 mm²
  /** 焊丝指向:截面内倾角(工作角实际值),deg;相对竖直参考 */
  aimAngle: number;
  /** 焊丝指向相对焊道中心的偏移(指向坡口侧壁/根部),mm */
  aimOffset: Vec2;
  /** 该道使用的工艺(可被排道微调,如 cap 层降焊速) */
  wps: WpsParams;
  /** 道次类型 */
  role: 'root' | 'hot' | 'fill' | 'cap';
}

/** 一个截面段(变间隙分段后)的排道结果 */
export interface SegmentPlan {
  index: number;
  t0: number;                // 段起始归一化位置
  t1: number;
  gap: number;               // 本段采用的间隙
  targetArea: number;        // 坡口+余高目标截面积 mm²
  plannedArea: number;       // 实际排道熔敷面积合计 mm²
  areaErrorPct: number;      // 面积误差 %(带符号)
  layerCount: number;
  passCount: number;
  beads: BeadPlacement[];
  /** 截面型腔多边形(用于绘制与面积核对) */
  cavity: Vec2[];
  reinforcementArea: number;
}

/** 整条焊缝的排道方案 */
export interface PassPlan {
  id: string;
  name: string;
  seamId: string;
  workpieceId: string;
  wpsId: string;
  createdAt: number;
  segments: SegmentPlan[];
  /** 汇总 */
  totalPasses: number;
  totalDepositionVolume: number; // mm³
  totalWeldTime: number;         // s(纯燃弧)
  totalWireLength: number;       // m
  totalHeatInput: number;        // 平均热输入 kJ/mm
  maxAreaErrorPct: number;       // 各段最大面积误差绝对值
  /** 方案级排道参数 */
  strategy: { targetLayerThickness: number; capOverride: boolean };
}

/** 六轴机器人关节角 deg */
export type JointAngles = [number, number, number, number, number, number];

/** 双轴变位机关节角 deg */
export type PositionerAngles = [number, number];

/** 机器人 DH/几何参数(关节型 6R,腕部球形) */
export interface RobotConfig {
  id: string;
  name: string;
  /** 连杆长度 mm */
  d1: number; // 基座→肩
  a2: number; // 上臂
  a3: number; // 前臂
  d4: number; // 腕偏置
  d6: number; // 腕心→法兰
  /** 关节上下限 deg */
  limits: { min: number; max: number }[];
  /** 奇异点警告阈值 */
  singularityWristThreshold: number; // deg
  singularityElbowThreshold: number; // deg
}

/** 变位机配置:头尾架双轴(旋转+倾斜),相对机器人基座的安装变换 xyz,mm */
export interface PositionerConfig {
  id: string;
  name: string;
  baseToPositioner: [number, number, number];
  axis1Limit: { min: number; max: number };
  axis2Limit: { min: number; max: number };
  /** 台面半径 mm(碰撞简化体) */
  tableRadius: number;
}

/** 一个机器人目标点(程序行) */
export interface RobotTarget {
  id: string;
  name: string;
  /** 工具末端(TCP)在机器人基座坐标系下的位姿 */
  position: [number, number, number];
  /** ZYX 欧拉角 deg,three.js 约定 */
  eulerDeg: [number, number, number];
  joints: JointAngles;
  positioner: PositionerAngles;
  /** 运动类型 */
  moveType: 'MOVJ' | 'MOVL';
  speed: number;          // mm/s 或 关节速比
  /** 工艺行 */
  arcOn: boolean;
  wps?: WpsParams;
  beadPass?: number;
  /** 碰撞/奇异/限位警告 */
  warnings: string[];
  /** 关联的焊缝归一化位置与道次,用于仿真 */
  seamT?: number;
  layer?: number;
  pass?: number;
}

/** 机器人程序 */
export interface RobotProgram {
  id: string;
  name: string;
  planId: string;
  workpieceId: string;
  robotId: string;
  positionerId: string;
  createdAt: number;
  targets: RobotTarget[];
  /** 过渡路径总长度 mm */
  transitionLength: number;
  /** 总节拍 s(含过渡与空程,简化估算) */
  cycleTime: number;
}

/** IndexedDB 存储名 */
export type StoreName = 'workpieces' | 'wps' | 'plans' | 'programs' | 'robots' | 'positioners';

/** 焊道成形问题圈注 */
export interface FusionIssue {
  kind: 'sidewallLack' | 'slagTrap' | 'overlap' | 'underfill';
  pass: number;
  layer: number;
  position: Vec2;
  /** 严重度 0~1 */
  severity: number;
  message: string;
}

export interface DBShape {
  workpieces: Workpiece;
  wps: WpsParams;
  plans: PassPlan;
  programs: RobotProgram;
  robots: RobotConfig;
  positioners: PositionerConfig;
}
