/**
 * LoadExpert Web - 核心领域类型定义
 *
 * 字段语义对齐逆向文档 load_expert_algorithm_analysis.md：
 * - BOX 表：REAL_/LOAD_ 三维尺寸、STACK_CLASS、A~F_SUPPORT_STACK_CLASS（六向承托级别）、
 *   SUPPORT_PCT_ 三维（底部承托比例）、NET/GROSS_WEIGHT、PCS_COUNT
 * - CON 表：内尺寸 + WEIGHT_CAPACITY
 */

/** 货物（对应数据库 BOX 表） */
export interface Box {
  /** 唯一标识 */
  id: string;
  /** 名称 */
  name: string;
  /** SKU（可选，用于清单/3D 浮层展示） */
  sku?: string;
  /** 批次（可选） */
  batch?: string;
  /** 单价（可选） */
  unitPrice?: number;
  /** 单位（可选，如 箱/件/托盘） */
  unit?: string;
  /** 分组名（可选，用于前端分组过滤） */
  groupName?: string;
  /** 长（x 轴向原始尺寸，mm） */
  length: number;
  /** 宽（y 轴向原始尺寸，mm） */
  width: number;
  /** 高（z 轴向原始尺寸，mm） */
  height: number;
  /** 重量（kg，对应 NET/GROSS_WEIGHT，此处取毛重语义） */
  weight: number;
  /** 堆码级别 STACK_CLASS（值越大允许堆得越高） */
  stackClass: number;
  /** 六向承托级别 A~F_SUPPORT_STACK_CLASS（索引=方向 0..5） */
  supportClasses: readonly number[];
  /** 底部承托比例 SUPPORT_PCT（[x, y, z] 三向，0~1） */
  supportPct: readonly [number, number, number];
  /** 每箱小件数 PCS_COUNT（件数=箱数*PCS_COUNT） */
  pcsCount: number;
  /** 可用箱数 */
  quantity: number;
  // ---- 以下为原软件 BOX 表的补充字段（P1 字段补齐）----
  /** 描述 DESCRIPTION */
  description?: string;
  /** 净重（kg）NET_WEIGHT；缺省时等于 weight（毛重） */
  netWeight?: number;
  /** 颜色 COLOR（用于 3D 渲染与报表） */
  color?: string;
  /** 尺寸单位 DIMENSION_UNIT（mm/cm/in，默认 mm） */
  dimensionUnit?: string;
  /** 重量单位 WEIGHT_UNIT（kg/g/lb，默认 kg） */
  weightUnit?: string;
  /** 型变系数 DEFORM_FACTOR：实际尺寸 = 名义尺寸 × 该系数（软包装压缩等） */
  deformFactor?: number;
  /** 型变公差 DEFORM_TOLERANCE：允许的尺寸偏差比例（0~1） */
  deformTolerance?: number;
  /** 六向允许摆放 A~F_ALLOW（索引=方向 0..5，false 表示该方向禁止） */
  allowDirections?: readonly boolean[];
  /** 六向最大堆放数 MAX_PLACE_DEEP/HORZ/VERT（索引=方向 0..5，0 = 不限） */
  maxPlaceDepth?: readonly number[];
  /** 六向承重面 A~F_BOTTOM/TOP/HEAD/TAIL（索引=方向 0..5，true 表示可承重） */
  supportFaces?: readonly boolean[];
}

/** 六向标签（供 UI 与报表展示） */
export const SIX_DIRECTION_LABELS: readonly string[] = ['dir0 长×宽×高', 'dir1 宽×长×高', 'dir2 长×高×宽', 'dir3 高×长×宽', 'dir4 高×宽×长', 'dir5 宽×高×长'];

/** 柜型（对应数据库 CON 表） */
export interface Container {
  /** 唯一标识 */
  id: string;
  /** 名称 */
  name: string;
  /** 内长（mm） */
  innerLength: number;
  /** 内宽（mm） */
  innerWidth: number;
  /** 内高（mm） */
  innerHeight: number;
  /** 载重（kg，WEIGHT_CAPACITY） */
  weightCapacity: number;
  /** 柜型标签（如 20GP / 40GP / 40HQ） */
  label?: string;
  // ---- 以下为原软件 CON 表的补充字段（P1 字段补齐）----
  /** 描述 DESCRIPTION */
  description?: string;
  /** 角件尺寸 CONNER_*（[长, 宽, 高]，mm） */
  cornerDims?: readonly [number, number, number];
  /** 门尺寸 DOOR_*（[宽, 高]，mm） */
  doorDims?: readonly [number, number];
  /** 空柜自重（kg）TARE_WEIGHT */
  emptyWeight?: number;
  /** 成本 COST */
  cost?: number;
  /** 计量单位 UNIT */
  unit?: string;
  /** 尺寸单位 DIMENSION_UNIT（mm/cm/in，默认 mm） */
  dimensionUnit?: string;
  /** 重量单位 WEIGHT_UNIT（kg/lb，默认 kg） */
  weightUnit?: string;
}

/** 六方向姿态轴序（对应 0x5f8ac0 查表，18 字节轴序映射） */
export type OrientationAxisOrder = readonly [number, number, number];

/**
 * 摆放姿态/方位（Placement）
 * dims 为货物原始 (L,W,H) 经轴序映射后的容器坐标系尺寸 (dx,dy,dz)
 */
export interface Placement {
  /** 方向 0..5 */
  orientation: number;
  /** 容器坐标系下尺寸 (dx, dy, dz) */
  dims: readonly [number, number, number];
  /** 原点坐标 (mm) */
  x: number;
  y: number;
  z: number;
  /** 货物引用 */
  boxId: string;
  /** 该放置包含的箱数 */
  count: number;
  /** 该货物的堆码级别（用于堆码约束判定） */
  stackClass: number;
  /** 该放置方向对应的承托级别（用于承托约束判定） */
  supportClass: number;
}

/** 候选块中的子块（对齐 0x44 字节块 = 4×0x10 子块 {x,y,z,flag} + 件数） */
export interface SubBlock {
  /** 子块 x 尺寸 */
  x: number;
  /** 子块 y 尺寸 */
  y: number;
  /** 子块 z 尺寸 */
  z: number;
  /** 子块标志（方向/姿态等；语义未完全还原，TODO/UNCERTAIN） */
  flag: number;
}

/** 候选块（CandidateBlock，0x44 字节布局） */
export interface CandidateBlock {
  /** 子块列表（最多 4 个） */
  subBlocks: SubBlock[];
  /** 该块包含的箱数 */
  pieceCount: number;
  /** 生成该块的方向 0..5 */
  orientation: number;
  /** 放置原点（容器坐标系，mm） */
  x: number;
  y: number;
  z: number;
  /** 层序号（主循环层高枚举结果） */
  level: number;
  /** 生成策略 0..5 */
  strategy: number;
  /** 块总重量（kg） */
  weight: number;
}

/**
 * 单箱放置（把聚合 Placement 按件展开后的逐件坐标）
 *
 * 聚合 Placement.dims 是块包围盒、count 是箱数，3D 若按整块渲染会失真
 * （432 箱渲染成一个实心大方块）。本类型给出每一箱的真实位置与姿态，
 * 供 3D 逐箱渲染、分层统计、报表与坐标导出使用。
 *
 * 块内排布规则（与 candidate-blocks.ts 各策略一致）：
 * 网格 nx × ny × nz，nx = round(bbox.x / carton.x) 等；
 * 按 z 主序填充（x 变化最快，其次 y，最后 z），装满 count 后停止，
 * 末尾可能残留空槽（如策略 2 末行不足）。
 */
export interface CartonPlacement {
  /** 全局唯一序号（跨 placement 递增） */
  index: number;
  /** 所属聚合放置在 result.placements 中的下标 */
  placementIndex: number;
  /** 该聚合放置内的逐件序号（0 起） */
  indexInPlacement: number;
  /** 货物引用 */
  boxId: string;
  /** 方向 0..5 */
  orientation: number;
  /** 该姿态下单箱尺寸 (dx, dy, dz) */
  dims: readonly [number, number, number];
  /** 单箱最小角坐标 (mm) */
  x: number;
  y: number;
  z: number;
  /** 透传堆码级别（报表/筛选用） */
  stackClass: number;
  /** 透传该方向承托级别 */
  supportClass: number;
}

/** 空间块（0x20 字节/块：位置+尺寸） */
export interface SpaceBlock {
  /** 原点 x（mm） */
  x: number;
  /** 原点 y（mm） */
  y: number;
  /** 原点 z（mm） */
  z: number;
  /** x 方向长度（mm） */
  dx: number;
  /** y 方向长度（mm） */
  dy: number;
  /** z 方向长度（mm） */
  dz: number;
  /**
   * 正下方紧邻的那个块属于哪种货物；`undefined` = 直接坐在柜底/地面
   *
   * 只用于调度层判断「该不该在别人头顶上继续码」（见 load.ts 的 pickSpaceFor）。
   * 侧边条带与尾端条带虽然与块在同一高度区间，但它们**底部落在柜底**上，
   * 故同样是 `undefined`。
   */
  baseBoxId?: string;
}

/** 层信息（按 z 高度分层的装入统计） */
export interface LayerInfo {
  /** 层序号（从 1 起） */
  level: number;
  /** 该层 z 方向起始高度（mm） */
  zMin: number;
  /** 该层 z 方向结束高度（mm） */
  zMax: number;
  /** 该层方向 */
  orientation: number;
  /** 该层箱数 */
  count: number;
  /** 该层占用体积（mm^3） */
  volume: number;
  /** 该层所属货物 */
  boxId: string;
}

/** 装柜结果 */
export interface PackResult {
  /** 使用的柜型 */
  container: Container;
  /** 全部放置 */
  placements: Placement[];
  /** 已占用体积（mm^3） */
  usedVolume: number;
  /** 装载率 = usedVolume / 柜内容积（0~1） */
  loadRate: number;
  /** 总重量（kg） */
  totalWeight: number;
  /** 总件数（箱数*PCS_COUNT 累计） */
  pieces: number;
  /** 层信息 */
  layers: LayerInfo[];
  /** 使用的策略 */
  strategy: number;
  /** 是否启用 LP 配比 */
  lpEnabled: boolean;
  /** 未能装入的货物及原因 */
  rejected: Array<{ boxId: string; reason: string }>;
  /** 算法迭代次数（放置循环执行轮数） */
  iterations: number;
}

/** LP 配比结果（主调度 lp 层输出） */
export interface LpMixResult {
  /** 是否求解成功 */
  ok: boolean;
  /** 每种货物装入箱数 */
  counts: number[];
  /** 目标函数值（体积配比总和） */
  value: number;
}

/** 计算高级设置（options，随计算请求透传） */
export interface LoadOptions {
  /** LP 体积配比开关（默认 false） */
  lpEnabled?: boolean;
  /** 是否允许旋转姿态（默认 true；false 时仅允许原方向 dir0 平放） */
  allowRotation?: boolean;
  /** 堆码级别判定开关（默认 true；false 时不做 STACK_CLASS 堆码约束） */
  stackRulesEnabled?: boolean;
  /** 承托级别判定开关（默认 true；false 时不做底部承托约束） */
  supportRulesEnabled?: boolean;
  /** 候选块数量上限（默认 0 = 不限制；达到上限后停止枚举并截断） */
  candidateLimit?: number;
  /** 主循环最大迭代次数（默认 100000，防止极端输入死循环） */
  maxIterations?: number;
  // UNCERTAIN：以下原程序参数未在 Web 版实现（语义未完全还原，不支持时忽略）：
  // preciseFitting / rotationAxis / cornerPriority / oversizePolicy
}

/** 多柜自动装载结果（同柜型循环装载） */
export interface MultiPlanResult {
  /** 每柜装载结果（仅含至少装入一件的有效柜） */
  plans: PackResult[];
  /** 使用柜数 */
  totalContainers: number;
  /** 已装总体积（mm^3） */
  totalLoadedVolume: number;
  /** 总柜内容积（mm^3） */
  totalContainerVolume: number;
  /** 总体装载率 = totalLoadedVolume / totalContainerVolume（0~1） */
  overallRate: number;
  /** 未能装入的剩余货物及数量 */
  remaining: Array<{ boxId: string; qty: number }>;
}
