// 全局领域模型：工件 / 焊缝 / 坡口 / 工艺 / 排道 / 机器人

export interface Vec2 { x: number; y: number }
export interface Vec3 { x: number; y: number; z: number }

export type JointKind = 'butt' | 'tee' | 'corner';        // 对接 / T型 / 角接
export type GrooveKind = 'V' | 'X' | 'U' | 'fillet';      // V形 / 双V(X) / U形 / 角焊缝
export type PartTemplateId = 'boom-box' | 'arm-rib' | 'variable-butt';

/** 坡口几何参数（mm / deg） */
export interface GrooveParams {
  kind: GrooveKind;
  thickness: number;        // 板厚 t
  grooveAngleDeg: number;   // 单侧坡口角度 α
  rootFace: number;         // 钝边 p
  rootGap: number;          // 装配间隙 g
  reinforcement: number;    // 余高 h
  uRadius: number;          // U形坡口圆弧半径
  legSize: number;          // 角焊缝焊脚 L
}

export type WpsPassRole = 'root' | 'fill' | 'cap';

/** 一套焊接工艺参数（对应根焊/填充/盖面中的一种） */
export interface WpsParams {
  id: string;
  name: string;
  role: WpsPassRole;
  wireDiameter: number;     // 焊丝直径 mm
  wireDensity: number;      // 焊丝密度 g/mm³（仅质量统计用）
  wfs: number;              // 送丝速度 m/min
  travelSpeed: number;      // 焊接速度 mm/s
  depositionEfficiency: number; // 熔敷效率 η (0~1)
  current: number;          // 电流 A
  voltage: number;          // 电压 V
  thermalEfficiency: number;    // 热效率 η_h (0~1)
  weaveWidth: number;       // 摆动宽度 mm
  weaveFreq: number;        // 摆动频率 Hz
  penetrationFactor: number; // 熔深系数 kp：熔深 = kp * I (mm)
  beadShapeFactor: number;  // 焊道宽/当量直径比（>1 扁宽）
}

export interface ThermalSettings {
  ambientTemp: number;      // 环境温度 ℃
  interpassLimit: number;   // 层间温度上限 ℃
  risePerKjPerMm: number;   // 每 kJ/mm 热输入的温升系数 ℃
  coolingTau: number;       // 冷却时间常数 s
  repositionTime: number;   // 道间变位/移动时间 s
}

/** 激光寻位测得的变间隙序列 */
export interface GapStation {
  s: number;                // 沿焊缝归一化位置 0~1
  gap: number;              // 该截面间隙 mm
}

export interface WeldSeam {
  id: string;
  name: string;
  jointKind: JointKind;
  groove: GrooveParams;
  /** 焊缝在工件坐标系下的路径：局部坐标 p(s)、切线 t(s)、坡口法向 n(s)、上表面方向 b(s) */
  length: number;           // mm
  pathKind: 'straight' | 'curved';
  curvatureRadius: number;  // 曲缝曲率半径（straight 时为 0）
  gapSeries: GapStation[];  // 空数组 = 恒定间隙（取 groove.rootGap）
  segments: number;         // 变间隙分段数
}

export interface Workpiece {
  id: string;
  name: string;
  template: PartTemplateId;
  plateThickness: number;
  overallSize: Vec3;
  createdAt: number;
  notes?: string;
  seams: WeldSeam[];
  /** 程序化工件的实体描述（供 three.js 与碰撞检测使用） */
  solids: PartSolid[];
}

export interface PartSolid {
  id: string;
  kind: 'box';
  center: Vec3;
  size: Vec3;
  rpyDeg: Vec3;             // 绕固定轴旋转（度）
}

/** 排道中的单道焊道（截面信息） */
export interface PlannedBead {
  index: number;            // 全局道次号（从1开始）
  layer: number;            // 层号（从1开始）
  role: WpsPassRole;
  center: Vec2;             // 截面中心 (mm，坡口局部坐标)
  area: number;             // 熔敷面积 mm²
  nominalArea: number;      // 未做面积闭环修正前的名义面积
  radiusEq: number;         // 等面积圆半径
  beadWidth: number;        // 焊道宽
  beadHeight: number;       // 焊道高
  penetration: number;      // 熔深 mm
  workAngleDeg: number;     // 工作角（焊丝相对坡口平分线/板的指向角）
  travelAngleDeg: number;   // 行走角（推/拖枪角）
  pointerOffset: number;    // 焊丝指向相对坡口中心的横向偏移 mm
  wfs: number;
  travelSpeed: number;
  current: number;
  voltage: number;
  weaveWidth: number;
  weaveFreq: number;
  heatInput: number;        // kJ/mm
  areaAdjusted: boolean;    // 是否为面积闭环调整过的道
}

export interface PlanLayer {
  layer: number;
  y: number;                // 该层布道高度
  beads: PlannedBead[];
}

/** 一个变间隙分段的排道结果 */
export interface PlanSegment {
  index: number;
  s0: number;
  s1: number;
  gap: number;              // 该段实际使用的间隙
  beads: PlannedBead[];
  layers: PlanLayer[];
  grooveArea: number;       // 该段坡口（含余高）需求面积
  depositedArea: number;    // 排道总熔敷面积
  areaErrorPct: number;     // 面积误差 %
}

export interface AreaAudit {
  requiredArea: number;
  depositedArea: number;
  errorPct: number;
  pass: boolean;            // ≤3%
  iterations: number;
  adjustments: string[];    // 闭环动作日志
}

export interface PlanScheme {
  id: string;
  workpieceId: string;
  seamId: string;
  name: string;
  createdAt: number;
  wpsIds: { root: string; fill: string; cap: string };
  thermal: ThermalSettings;
  segments: PlanSegment[];
  audit: AreaAudit;
  totalDepositionVolume: number; // mm³
  totalWireMass: number;         // g
  totalArcTime: number;          // s
  totalWaitTime: number;         // s（层间等待）
  totalTime: number;             // s
}

export interface ThermalPassState {
  beadIndex: number;
  segmentIndex: number;
  tempBefore: number;
  tempAfter: number;
  heatInput: number;       // kJ/mm
  arcTime: number;
  waitBefore: number;      // 需要等待秒数
  overLimit: boolean;
}

export interface DefectMark {
  beadIndex: number;
  kind: 'sidewall-lack-fusion' | 'slag-trap' | 'interlayer-lack-fusion';
  severity: 'warn' | 'bad';
  position: Vec2;
  message: string;
  metric: number;
  threshold: number;
}

export interface RobotLimits {
  jMin: number[];  // rad, 长度6
  jMax: number[];
  jMaxSpeed: number[]; // rad/s
}

export interface IKSolution {
  joints: number[];        // 6 关节 rad
  reachable: boolean;
  withinLimits: boolean;
  limitMarginDeg: number;  // 最小限位裕量
  singularity: {
    wristSin: number;      // |sin θ5|
    minSigma: number;      // 雅可比最小奇异值
    condition: number;     // 条件数
    nearSingular: boolean;
  };
  fkRoundTrip: {
    positionErrorMm: number;
    orientationErrorDeg: number;
  };
  warnings: string[];
}

export interface RobotProgramLine {
  lineNo: number;
  text: string;
  beadIndex?: number;
  kind: 'move' | 'arc-on' | 'arc-off' | 'wait' | 'weave' | 'comment';
}
