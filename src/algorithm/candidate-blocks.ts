/**
 * 候选块生成器（PLACE_BOX 0x4b48d0 下的策略函数 0~5）
 *
 * 对齐逆向文档：
 *  - 候选块 0x44 字节 = 4 子块 {x,y,z,flag}（0x10/子块）+ 件数区
 *  - 策略3 为模板：姿态尺寸 → 方向可用空间 → ceil_div 件数 → 填块
 *  - 策略差异矩阵：见逆向文档（各策略切块逻辑不同，本文件按文档描述实现，
 *    未完全还原处标注 TODO/UNCERTAIN）
 *  - 策略0：单方向条块（只沿最长轴铺一条线）
 *  - 策略5 细分 5a/5b/5c（本实现提供基础 FillSpace 行为，差异部分标注）
 *
 * 返回的候选块随后进入评分（0x4c2f44：4 子块体积和选最大）。
 */
import type { Box, CandidateBlock, Container, SpaceBlock, SubBlock } from '../types/index.js';
import { orientDims, effectiveDims } from './orientations.js';

/** 策略标识 */
export const STRATEGY_SINGLE_RECT = 0;
export const STRATEGY_FILL_2D = 1;
export const STRATEGY_LAYER_BY_LAYER = 2;
export const STRATEGY_CANONICAL = 3;
export const STRATEGY_SUPPORT_STACK = 4;
export const STRATEGY_FILL_SPACE_LP = 5;

/**
 * 各策略的姿态准入策略表
 *
 * 6 个策略的姿态档 + 分块几何组合：
 *   0 单条 → heightRank0 + 单轴长条  ：最扁 + 只沿最长轴铺一条线
 *   1 单层 → heightRank0 + 整层面    ：最扁 + 只吃整行、不放残层
 *   2 逐层 → heightRank1 + 残层      ：次扁 + 末行不足也照放
 *   3 满舱 → heightRank2 + 堆满     ：最高面朝下 + 只吃整层（装载率基准）
 *   4 承托 → heightRank1 + 级数上限  ：次扁 + 层数受堆码级别硬约束
 *   5 均衡 → all + 够用即止         ：全姿态 + 层数按实际货量反推
 *
 * ## 关键认知：改变分块方式不足以改变最终结果
 * 贪心主循环会把块切分后重新填充，分块痕迹（1 块 vs 24 块）最终被完全抹平。
 * 实测：S0 分 24 块 / S3 分 1 块，展开后 432 箱坐标完全一致。
 * 真正决定结果的是**姿态（orientation）** → 不同的 nx/ny/nz 网格 → 不同的逐箱坐标。
 * 故策略必须限制可选姿态集合，才能产生真正不同的装柜结果。
 *
 * ## 关于策略收敛（几何必然，非缺陷）
 * 当两个策略同时满足 ①姿态档相同 ②分块几何在当前输入下等价
 * （如均为"放满整层"且数量整除），它们必然产出同一套逐箱坐标。
 * 强行制造差异只会输出不合理的摆法。立方货物（三轴等长）6 姿态映射同一网格，
 * 策略天然不可区分。由 scripts/strategy-compare.mjs 在 8 个场景下持续监测。
 *
 * ## 多货物混装下的块大小 / 足迹限制（P0-d）
 * 策略 3/5 会生成"吃满整个空间"的巨型块，装完后剩余空间不足一箱，
 * **其它货物完全无法介入** —— 调度层再怎么轮转也无济于事
 * （实测 S3/S5 混装时第二种货物装入 0 件）。
 * 故多货物场景下同时限制单块**体积占比**与 **xy 足迹**，
 * 迫使算法把柜子切成多块、给其它货物留出可用的矩形空间。
 * 单货物场景不设限（保持满舱策略的装载率优势）。
 */
export const STRATEGY_ORIENTATION_POLICY: Record<number, OrientationPolicy> = {
  0: 'heightRank0',
  1: 'heightRank0',
  2: 'heightRank1',
  3: 'heightRank2',
  4: 'heightRank1',
  5: 'all',
};

export const MAX_SUBBLOCKS = 4;

/**
 * 单块体积占目标空间体积的最大比例（仅多货物场景生效，0 = 不限制）
 * 设为 0.5 表示单块最多占当前空间的 50%，强制算法留出空间给后续货物。
 */
export const MULTI_CARGO_MAX_BLOCK_RATIO = 0.75;

/**
 * 多货物场景下的块足迹限制系数（0 = 不限制）
 *
 * 除了限制块高（体积上限），还必须限制块的 **xy 足迹**：
 * 若某货物（如 1200×900×150 的扁平件）的块铺满柜宽柜深，
 * 切分后只会剩下几厘米宽的细条（12032-12000=32mm），
 * 其它货物再也无法放入 —— 实测 3 货物场景下大扁平件会让另外两种货物装入 0 箱。
 * 限制足迹可保证剩余空间是**可用的矩形区域**。
 */
export const MULTI_CARGO_FOOTPRINT_RATIO = 0.75;

/** ceil 除法：ceil(a/b) */
export function ceilDiv(a: number, b: number): number {
  if (b <= 0) {
    return 0;
  }
  return Math.ceil(a / b);
}

/** floor 除法：floor(a/b) */
export function floorDiv(a: number, b: number): number {
  if (b <= 0) {
    return 0;
  }
  return Math.floor(a / b);
}

/**
 * 按足迹比例限制某轴的可放件数
 * @param n 原本可放件数
 * @param unit 单箱该轴尺寸
 * @param span 空间该轴尺寸
 * @param ratio 足迹比例上限（<=0 不限制）
 */
function capFootprint(n: number, unit: number, span: number, ratio: number): number {
  if (ratio <= 0 || unit <= 0 || span <= 0) {
    return Math.max(1, n);
  }
  const limited = Math.floor((ratio * span) / unit);
  return Math.max(1, Math.min(n, limited));
}

/**
 * 计算单块可占的最大层数（受 maxBlockVolumeRatio 约束）
 *
 * 块的 xy 方向已铺满空间，故 块体积/空间体积 ≈ zUsed*dz / space.dz，
 * 于是体积上限等价于层数上限：zUsed <= ratio * space.dz / dz。
 * 至少返回 1（允许放单层），避免多货物场景下某姿态完全不可用。
 */
function maxLayersByVolumeCap(input: GenerateBlocksInput, dz: number): number {
  const ratio = input.maxBlockVolumeRatio ?? 0;
  if (ratio <= 0 || dz <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(1, Math.floor((ratio * input.space.dz) / dz));
}

/**
 * 策略的姿态准入策略
 *
 * 按「该姿态下压到 z（高度）的轴，在三轴中按长度排第几小」分档：
 *   heightRank0 → 最扁（最小面朝下，重心低）
 *   heightRank1 → 次扁
 *   heightRank2 / heightTallest → 最长面朝下（同一判据，不同时分配给两个策略）
 *   all → 不限制姿态（由体积评分选最优）
 */
export type OrientationPolicy = 'all' | 'heightRank0' | 'heightRank1' | 'heightRank2' | 'heightTallest';

/** 该姿态下货物三个轴映射到 (x,y,z) 的原始轴下标（取自 ORIENTATION_AXIS_ORDERS） */
const AXIS_ORDER: readonly (readonly [number, number, number])[] = [
  [0, 1, 2],
  [1, 0, 2],
  [0, 2, 1],
  [2, 0, 1],
  [2, 1, 0],
  [1, 2, 0],
];

/**
 * 某姿态下"压到 z（高度）的那个轴"在三轴中的长短排名
 * @returns 0=最短（最扁，重心低）… 2=最长
 */
export function heightRank(orientation: number, dims: readonly [number, number, number]): 0 | 1 | 2 {
  if (orientation < 0 || orientation >= 6) {
    return 0;
  }
  const heightAxis = AXIS_ORDER[orientation][2];
  return [0, 1, 2].sort((a, b) => dims[a] - dims[b]).indexOf(heightAxis) as 0 | 1 | 2;
}

/**
 * 判定姿态是否被策略准入
 * @param policy 策略姿态策略
 * @param orientation 方向 0..5
 * @param dims 货物原始 (L,W,H)
 */
export function orientationAllowed(policy: OrientationPolicy, orientation: number, dims: readonly [number, number, number]): boolean {
  if (orientation < 0 || orientation >= 6) {
    return false;
  }
  if (policy === 'all') {
    return true;
  }
  if (policy === 'heightTallest') {
    return heightRank(orientation, dims) === 2;
  }
  const want = policy === 'heightRank0' ? 0 : policy === 'heightRank1' ? 1 : 2;
  return heightRank(orientation, dims) === want;
}

/**
 * 策略姿态档的**回退顺序**：首选档，然后按 |rank - 首选| 由近及远
 *
 * 背景（本项目踩过的坑）：姿态档原本是**硬过滤**。当货物的六向限制
 * （A~F_ALLOW / A~F_SUPPORT_STACK_CLASS=0）恰好把某策略那一档的两个方向都禁掉时，
 * 该策略与可用方向的交集为空 → **整柜 0 放置**。
 * 实测 480×380×380 与 515×380×425 各限 dir0/dir1 时（这两个方向恰为 heightRank1）：
 *   策略0/1(heightRank0) ∩ {dir0,dir1} = ∅ → 0%
 *   策略3(heightRank2) ∩ {dir0,dir1} = ∅ → 0%  ← 且策略3 是**默认预选策略**
 * 用户手工能装下（策略5 实测 630+330、装载率 82.7%），界面却显示"装不下"。
 *
 * 正确语义：姿态档表达的是策略的**摆放偏好**（最扁/次扁/最高），
 * 不是硬约束 —— 首选档不可行时应退到次偏好档，而不是交白卷。
 * 这样：全部方向可用时行为与原来完全一致（首选档即命中，策略区分度不变）；
 * 有方向限制时退到可行档，不会出现 0 放置。
 */
const RANK_FALLBACK_ORDER: Record<0 | 1 | 2, ReadonlyArray<0 | 1 | 2>> = {
  0: [0, 1, 2],
  1: [1, 0, 2],
  2: [2, 1, 0],
};

/**
 * 按当前**实际可用方向**解析出策略的生效姿态档
 *
 * @param strategy 策略号 0..5
 * @param dims     货物原始 (L,W,H)
 * @param availDirs 通过有效性判定 + 六向限制 + allowRotation 后的可用方向
 * @returns 生效的姿态档；无可用方向时返回首选档（交由上层按 no-fit 处理）
 */
export function resolveOrientationPolicy(
  strategy: number,
  dims: readonly [number, number, number],
  availDirs: readonly number[],
): OrientationPolicy {
  const policy = STRATEGY_ORIENTATION_POLICY[strategy] ?? 'all';
  if (policy === 'all') {
    return 'all';
  }
  const preferred: 0 | 1 | 2 = policy === 'heightRank0' ? 0 : policy === 'heightRank1' ? 1 : 2;
  for (const rank of RANK_FALLBACK_ORDER[preferred]) {
    const hit = availDirs.some((o) => heightRank(o, dims) === rank);
    if (hit) {
      return rank === 0 ? 'heightRank0' : rank === 1 ? 'heightRank1' : 'heightRank2';
    }
  }
  // availDirs 为空：上层会按 no-fit 处理，这里返回首选档即可
  return policy;
}

export interface GenerateBlocksInput {
  box: Box;
  container: Container;
  /** 放置原点 */
  x: number;
  y: number;
  z: number;
  /** 可用空间 */
  space: SpaceBlock;
  /** 方向 0..5 */
  orientation: number;
  /** 层序号（主循环传入，1..ceil(conH/boxH)） */
  level: number;
  /** 该方向剩余可用数量（件数上限，通常为 box.quantity 减去已用） */
  availableCount: number;
  /**
   * 单块体积占目标空间的体积上限比例（0 = 不限制）
   * 多货物混装时由 load() 传入（见 MULTI_CARGO_MAX_BLOCK_RATIO）
   */
  maxBlockVolumeRatio?: number;
  /**
   * 混装时单块 xy 足迹占目标空间 xy 足迹的最大比例（0 / 缺省 = 不限制）
   *
   * 与 maxBlockVolumeRatio 同属「防止先手货物吃满整柜、饿死后来者」的保护，
   * 但同样**随场景翻转**（见 load.ts 的 CARGO_CONFIGS 多起点）：
   * 足迹上限小 → 每块窄、留给别人的空间多但整体被切碎；
   * 足迹上限大 → 一次占满一个方向的整条（如 11900 长柜一次铺满），装载率高。
   * 典型：用户实测 40HQ(11900×2340×2680) + 480×380×380×630 + 515×380×425×330，
   * 足迹 0.75 会把首个 30 柱长块压到 18 柱（8640mm），白丢 3260mm 的整条尾部。
   */
  maxBlockFootprintRatio?: number;
}

function makeBlock(input: GenerateBlocksInput, subBlocks: SubBlock[], pieceCount: number, strategy: number): CandidateBlock | null {
  if (pieceCount <= 0 || subBlocks.length === 0) {
    return null;
  }
  // 物理越界检查：任何子块尺寸不得超过可用空间（ceil 层高枚举的最后层可能超出）
  if (subBlocks.some((sb) => sb.x > input.space.dx + 1e-6 || sb.y > input.space.dy + 1e-6 || sb.z > input.space.dz + 1e-6)) {
    return null;
  }
  return {
    subBlocks,
    pieceCount,
    orientation: input.orientation,
    x: input.x,
    y: input.y,
    z: input.z,
    level: input.level,
    strategy,
    weight: 0, // 重量由调用方按 unitWeight 计算
  };
}

/**
 * 策略0：单方向条块（只沿最长轴铺一条线）
 *
 * 与其它策略的根本差异：只占用空间的一个方向（横向单排 / 纵深单列 / 竖向单根），
 * 不做面填充。产出细长条块，剩余空间留给后续货物或后续迭代。
 */
export function generateStrategy0(input: GenerateBlocksInput): CandidateBlock | null {
  const [dx, dy, dz] = orientDims(input.box, input.orientation);
  if (dx <= 0 || dy <= 0 || dz <= 0) {
    return null;
  }
  const nX = floorDiv(input.space.dx, dx);
  const nY = floorDiv(input.space.dy, dy);
  const nZ = Math.min(floorDiv(input.space.dz, dz), input.level);
  if (nX <= 0 || nY <= 0 || nZ <= 0) {
    return null;
  }
  // 选可延伸件数最多的轴，只沿该轴铺满一条线
  const axis = nX >= nY && nX >= nZ ? 0 : nY >= nZ ? 1 : 2;
  const run = axis === 0 ? nX : axis === 1 ? nY : nZ;
  const count = Math.min(run, input.availableCount);
  if (count <= 0) {
    return null;
  }
  const sub: SubBlock = {
    x: axis === 0 ? dx * count : dx,
    y: axis === 1 ? dy * count : dy,
    z: axis === 2 ? dz * count : dz,
    flag: input.orientation,
  };
  return makeBlock(input, [sub], count, STRATEGY_SINGLE_RECT);
}

/**
 * 策略1：单层薄片（横向铺满一个面，z 只放一层）
 *
 * 几何特征：x、y 双向铺满，z 方向仅 1 个单箱高。
 * 与策略3（满舱）的区别是**主动放弃竖直空间**，为易碎品/软包装留出上方空腔。
 * 只允许整行（x 方向铺满、y 方向按整行递增），避免出现不规则残块。
 */
export function generateStrategy1(input: GenerateBlocksInput): CandidateBlock | null {
  const [dx, dy, dz] = orientDims(input.box, input.orientation);
  if (dx <= 0 || dy <= 0 || dz <= 0) {
    return null;
  }
  const fp = input.maxBlockFootprintRatio ?? 0;
  const nX = capFootprint(floorDiv(input.space.dx, dx), dx, input.space.dx, fp);
  const nY = capFootprint(floorDiv(input.space.dy, dy), dy, input.space.dy, fp);
  if (nX <= 0 || nY <= 0) {
    return null;
  }
  // 整行约束：件数通常是 nX 的整数倍
  const rows = Math.min(nY, floorDiv(input.availableCount, nX));
  if (rows <= 0) {
    // 需求不足一整行（availableCount < nX）时 floorDiv 给 0 → 原本直接 null = 一件不装。
    // 保留"整行优先"的性格：只在放不下任何完整一行时，才退而放一个**残行**，
    // 处理方式与 generateStrategy2 的残层一致（见其注释）。
    const count = Math.min(nX, input.availableCount);
    if (count <= 0) {
      return null;
    }
    const ragged: SubBlock = { x: dx * count, y: dy, z: dz, flag: input.orientation };
    return makeBlock(input, [ragged], count, STRATEGY_FILL_2D);
  }
  const sub: SubBlock = { x: dx * nX, y: dy * rows, z: dz, flag: input.orientation };
  return makeBlock(input, [sub], nX * rows, STRATEGY_FILL_2D);
}

/**
 * 策略2：逐层码放（严格单层，且件数可不足整层）
 *
 * 与策略1 的区别：允许**残层**（末行不足整行也照放），因此在货物数量不整除时
 * 能多装；策略1 只吃整行、会主动舍弃零头。
 * 每次放置恰好一层，层与层由 SpaceManager.split 的"块正上方"空间自然衔接。
 */
export function generateStrategy2(input: GenerateBlocksInput): CandidateBlock | null {
  const [dx, dy, dz] = orientDims(input.box, input.orientation);
  if (dx <= 0 || dy <= 0 || dz <= 0) {
    return null;
  }
  const fp = input.maxBlockFootprintRatio ?? 0;
  const nX = capFootprint(floorDiv(input.space.dx, dx), dx, input.space.dx, fp);
  const nY = capFootprint(floorDiv(input.space.dy, dy), dy, input.space.dy, fp);
  if (nX <= 0 || nY <= 0) {
    return null;
  }
  const count = Math.min(nX * nY, input.availableCount);
  if (count <= 0) {
    return null;
  }
  // 残层：不足一层时按实际件数收紧 y 方向占位，块包围盒才与实际件数自洽
  const rows = ceilDiv(count, nX);
  const sub: SubBlock = { x: dx * Math.min(nX, count), y: dy * rows, z: dz, flag: input.orientation };
  return makeBlock(input, [sub], count, STRATEGY_LAYER_BY_LAYER);
}

/**
 * 策略3：满舱主块（文档明确还原的基准实现，作为装载率基准）
 *
 * 几何特征：x、y 铺满，z 方向按 level 尽可能堆高，**只吃整层**（保持矩形完整）。
 * 这是 6 个策略中装载率最高的一个，作为其它策略的对照基准。
 * 注意：候选块子块描述块内部几何（0x44 布局的 4 子块），
 * 剩余空间切分由 SpaceManager.split 负责，不混入候选块子块。
 */
export function generateStrategy3(input: GenerateBlocksInput): CandidateBlock | null {
  const [dx, dy, dz] = orientDims(input.box, input.orientation);
  if (dx <= 0 || dy <= 0 || dz <= 0) {
    return null;
  }
  // 多货物时限制块足迹，保证剩余空间是可用的矩形区域（P0-d）
  const fp = input.maxBlockFootprintRatio ?? 0;
  const nX = capFootprint(floorDiv(input.space.dx, dx), dx, input.space.dx, fp);
  const nY = capFootprint(floorDiv(input.space.dy, dy), dy, input.space.dy, fp);
  if (nX <= 0 || nY <= 0) {
    return null;
  }
  // 多货物时限制单块层数占比，给其它货物留出参与空间（P0-d）
  const maxZ = Math.min(ceilDiv(input.space.dz, dz), input.level, maxLayersByVolumeCap(input, dz));

  // 优先按需求量精确拟合 (列数, 排数, 层数)：一次性吃掉本货物当前全部可用量形成"整块"，
  // 几何残余自然成为留给其它货物的干净空间（见 fitLayerGrid 注释）
  const fit = fitLayerGrid(nX, nY, maxZ, input.availableCount);
  if (fit) {
    const sub: SubBlock = { x: dx * fit.a, y: dy * fit.b, z: dz * fit.c, flag: input.orientation };
    return makeBlock(input, [sub], fit.a * fit.b * fit.c, STRATEGY_CANONICAL);
  }

  // 无精确解：退回「铺满 xy + 只截断 z」的原有行为
  const perLayer = nX * nY;
  let total = 0;
  let zUsed = 0;
  for (let l = 1; l <= maxZ; l++) {
    if (total + perLayer > input.availableCount) {
      break;
    }
    total += perLayer;
    zUsed = l;
  }
  if (total <= 0) {
    // 需求不满一整层时上面那层循环第一轮就 break，total 恒为 0。
    // 再加一层"不超过需求的最大矩形"兜底，否则这里直接 null = 一件都装不进。
    // 详见 fitLayerGridAtMost 的说明（这是一个真实缺陷，不是设计取舍）。
    const partial = fitLayerGridAtMost(nX, nY, maxZ, input.availableCount);
    if (!partial) {
      return null;
    }
    const psub: SubBlock = { x: dx * partial.a, y: dy * partial.b, z: dz * partial.c, flag: input.orientation };
    return makeBlock(input, [psub], partial.a * partial.b * partial.c, STRATEGY_CANONICAL);
  }
  const sub: SubBlock = { x: dx * nX, y: dy * nY, z: dz * zUsed, flag: input.orientation };
  return makeBlock(input, [sub], total, STRATEGY_CANONICAL);
}

/**
 * 按需求量**精确拟合**层网格：找 (a, b, c) 满足 a ≤ nX, b ≤ nY, c ≤ maxZ 且 a*b*c == need
 *
 * ## 为什么需要这一步（策略3 原本只截断 z）
 * 策略3 原来固定用 (nX, nY) 铺满 xy，只在 z 上按 `total + perLayer > available` 截断，
 * 于是当需求量不是 perLayer 的整数倍时，**永远凑不出刚好吃完货量的整块**。
 *
 * 典型：水泵场景 WP20 = 480×380×380，dir1 下 x=380 / y=480 / z=380，
 * 空间 11900×2340×2680 → nX=31, nY=4, 每层 124 件、需求 630 件。
 * - 只截断 z：630/124 = 5.08 → 只能做 5 层 = 620 件，**浪费 10 件且留下 2 层的空腔**
 * - 拟合网格：a=30, b=3 → 每层 90 件，7 层正好 **630 = 需求**，且块的占位是
 *   11400×1440×2660 —— 与原软件 LoadExpert 的 WP20 整块**完全一致**。
 *
 * 原软件正是这么摆的：它先让 WP20 一次吃掉 30×3×7 的整块，
 * 剩下的 y 向 900mm 条带 + x 向 380mm 尾巴自然留给 WP30 —— 几何残余即"预留空间"。
 *
 * @returns 命中的 (a, b, c)；无精确解时返回 null，由调用方退回原截断逻辑
 */
function fitLayerGrid(
  nX: number,
  nY: number,
  maxZ: number,
  need: number,
): { a: number; b: number; c: number } | null {
  if (nX <= 0 || nY <= 0 || maxZ <= 0 || need <= 0) {
    return null;
  }
  // 层高优先（越高越像"整块"），其次每层件数尽量多
  for (let c = Math.min(maxZ, need); c >= 1; c--) {
    if (need % c !== 0) {
      continue;
    }
    const perLayer = need / c;
    if (perLayer > nX * nY) {
      continue;
    }
    // 在 a ≤ nX 内找能整除 perLayer 的最大 a（b = perLayer/a 需 ≤ nY）
    for (let a = Math.min(nX, perLayer); a >= 1; a--) {
      if (perLayer % a === 0 && perLayer / a <= nY) {
        return { a, b: perLayer / a, c };
      }
    }
  }
  return null;
}

/**
 * 兜底拟合：在 (nX, nY, maxZ) 内找**件数最多且不超过 need** 的层网格
 *
 * ## 为什么必须有它（一个真实的"装 0"缺陷，不是设计取舍）
 *
 * `fitLayerGrid` 要求 `a*b*c === need` 精确整除；而 generateStrategy3 的老兜底
 * （铺满 xy + 只截断 z）在 `need < nX*nY` 时第一层就 break → total = 0 → null。
 * 两者叠加的结果是：**只要需求凑不出三因子分解、又不满一层，就一件都装不进**。
 *
 * 实测 40HQ + 水泵3 515×380×425（策略 3）：
 *   qty=96 → 装 96　qty=97 → 装 **0**　qty=98 → 装 **0**　qty=99 → 装 99
 * 97 是质数，在 nX=23 / nY=6 / maxZ≤7 范围内没有三因子分解，于是直接报 `no-fit`。
 * 「装 97 箱」都装不进，业务上说不通；更隐蔽的是它在**多柜循环**里悄悄吃掉
 * 最后一个柜的剩余量 —— 40HQ 再也装不下那 98 件，用户只看到"有 1 种货物未能全部装入"。
 *
 * generateStrategy4 有同一个洞（`layers = min(..., floorDiv(need, perLayer))`，
 * need < perLayer 时为 0）；generateStrategy1 是"不足一行"版本。
 * 三个都补上同一类兜底。
 *
 * ## 形状偏好（与既有约定一致）
 * 层高优先（c 从大到小），其次 a*b 最大、同值取 a 大 —— 与 `fitLayerGrid` 的
 * "整块尽量高、尽量沿 x 铺开"观感一致，不改变已有块的形状。
 *
 * 允许块不满：剩下的量交给下一轮贪心迭代（本来就是多轮），必要时再补一块。
 */
function fitLayerGridAtMost(
  nX: number,
  nY: number,
  maxZ: number,
  need: number,
): { a: number; b: number; c: number } | null {
  if (nX <= 0 || nY <= 0 || maxZ <= 0 || need <= 0) {
    return null;
  }
  let best: { a: number; b: number; c: number } | null = null;
  for (let c = Math.min(maxZ, need); c >= 1; c--) {
    const cap = Math.floor(need / c);
    if (cap <= 0) {
      continue;
    }
    // 在 a ≤ nX、b ≤ nY、a*b ≤ cap 下取 a*b 最大者（b 从大到小扫，nY 很小）
    for (let b = Math.min(nY, cap); b >= 1; b--) {
      const a = Math.min(nX, Math.floor(cap / b));
      if (a <= 0) {
        continue;
      }
      const pieces = a * b * c;
      if (!best || pieces > best.a * best.b * best.c || (pieces === best.a * best.b * best.c && a > best.a)) {
        best = { a, b, c };
      }
      break;
    }
  }
  return best;
}

/**
 * 策略4：承托分级分层（层数受堆码级别硬上限约束）
 *
 * 与策略3 的关键差异：z 向层数**不超过货物自身堆码级别 stackClass**。
 * 即使柜内还有竖直空间也不继续堆高 —— 尊重货物承载能力，
 * 适合重货 / 底部易损货物，代价是装载率低于策略3。
 * TODO/UNCERTAIN：原程序 0x4b78c7 与 0x4baffe 的承托分层细节未完全还原。
 */
export function generateStrategy4(input: GenerateBlocksInput): CandidateBlock | null {
  const [dx, dy, dz] = orientDims(input.box, input.orientation);
  if (dx <= 0 || dy <= 0 || dz <= 0) {
    return null;
  }
  const fp = input.maxBlockFootprintRatio ?? 0;
  const nX = capFootprint(floorDiv(input.space.dx, dx), dx, input.space.dx, fp);
  const nY = capFootprint(floorDiv(input.space.dy, dy), dy, input.space.dy, fp);
  if (nX <= 0 || nY <= 0) {
    return null;
  }
  // 层数硬上限 = min(空间可容层数, level 枚举层数, 堆码级别, 多货物体积上限)
  const cap = Math.max(1, input.box.stackClass);
  const maxZ = Math.min(ceilDiv(input.space.dz, dz), input.level, cap, maxLayersByVolumeCap(input, dz));
  const perLayer = nX * nY;
  // 承托策略：一次只放「一个承托级」的小批量（cap 层），
  // 而非像策略2 那样把空间一次填满 —— 这样每次放置都受堆码级别真正约束，
  // 剩余层留给后续迭代，也让本策略与策略2 产出不同的逐箱坐标。
  const layers = Math.min(maxZ, cap, floorDiv(input.availableCount, perLayer));
  if (layers <= 0) {
    // 需求不满一整层 → layers=0 → 一件都装不进（与策略3 同源缺陷，见 fitLayerGridAtMost）。
    // maxZ 已经把堆码级别 cap 算进去了，所以这个兜底仍然受承托分级约束。
    const partial = fitLayerGridAtMost(nX, nY, maxZ, input.availableCount);
    if (!partial) {
      return null;
    }
    const psub: SubBlock = { x: dx * partial.a, y: dy * partial.b, z: dz * partial.c, flag: input.orientation };
    return makeBlock(input, [psub], partial.a * partial.b * partial.c, STRATEGY_SUPPORT_STACK);
  }
  const sub: SubBlock = { x: dx * nX, y: dy * nY, z: dz * layers, flag: input.orientation };
  return makeBlock(input, [sub], perLayer * layers, STRATEGY_SUPPORT_STACK);
}

/**
 * 策略5：均衡层高（把剩余空间在"装得满"与"装得均匀"之间取平衡）
 *
 * 与策略3 的差异：策略3 一路堆到空间顶（极不均匀：底部满、顶部空）。
 * 策略5 按可用件数反推**够用即可**的层数 —— 层数 = ceil(availableCount / perLayer)，
 * 通常小于空间可容层数，因此块的竖直占位更贴合实际货物量，
 * 剩余竖直空间留给其它货物/其它姿态。数量不整除时允许残层。
 */
export function generateStrategy5(input: GenerateBlocksInput): CandidateBlock | null {
  const [dx, dy, dz] = orientDims(input.box, input.orientation);
  if (dx <= 0 || dy <= 0 || dz <= 0) {
    return null;
  }
  const fp = input.maxBlockFootprintRatio ?? 0;
  const nX = capFootprint(floorDiv(input.space.dx, dx), dx, input.space.dx, fp);
  const nY = capFootprint(floorDiv(input.space.dy, dy), dy, input.space.dy, fp);
  if (nX <= 0 || nY <= 0) {
    return null;
  }
  const perLayer = nX * nY;
  const maxZ = Math.min(ceilDiv(input.space.dz, dz), input.level);
  if (maxZ <= 0) {
    return null;
  }
  // 够装即可：按可用件数反推所需层数（不强行堆满）；多货物时再受体积上限约束
  const needLayers = ceilDiv(input.availableCount, perLayer);
  const zUsed = Math.min(maxZ, maxLayersByVolumeCap(input, dz), Math.max(1, needLayers));
  const total = Math.min(input.availableCount, perLayer * zUsed);
  if (total <= 0) {
    return null;
  }
  // 每层在 y 方向占满 nY 行，故 y 始终为 dy * nY；
  // 末层不足整层只减少件数，不收紧包围盒（否则会与 zUsed 不自洽，
  // 展开时按 bbox 反推网格会算出比实际层数多的层 → 逐箱坐标溢出柜体）。
  const sub: SubBlock = {
    x: dx * nX,
    y: dy * nY,
    z: dz * zUsed,
    flag: input.orientation,
  };
  return makeBlock(input, [sub], total, STRATEGY_FILL_SPACE_LP);
}

/** 策略函数路由（按 strategy 选择生成器） */
export function generateCandidateBlock(input: GenerateBlocksInput, strategy: number, policy?: OrientationPolicy): CandidateBlock | null {
  // 姿态准入：策略通过限制可选姿态来产生不同的空间排列（见 OrientationPolicy 注释）。
  // policy 由上层用 resolveOrientationPolicy 按**实际可用方向**解析后传入，
  // 使首选档不可行时能退到次偏好档，而不是因交集为空交白卷。
  const effectivePolicy = policy ?? STRATEGY_ORIENTATION_POLICY[strategy] ?? 'all';
  const box = input.box;
  if (!orientationAllowed(effectivePolicy, input.orientation, [box.length, box.width, box.height])) {
    return null;
  }
  switch (strategy) {
    case STRATEGY_SINGLE_RECT:
      return generateStrategy0(input);
    case STRATEGY_FILL_2D:
      return generateStrategy1(input);
    case STRATEGY_LAYER_BY_LAYER:
      return generateStrategy2(input);
    case STRATEGY_CANONICAL:
      return generateStrategy3(input);
    case STRATEGY_SUPPORT_STACK:
      return generateStrategy4(input);
    case STRATEGY_FILL_SPACE_LP:
      return generateStrategy5(input);
    default:
      return generateStrategy3(input);
  }
}

/** 合法策略列表 */
export const ALL_STRATEGIES = [0, 1, 2, 3, 4, 5] as const;

/**
 * 策略名称（输出用 + 前端显示）
 */
export const STRATEGY_NAMES: Record<number, string> = {
  0: '单方向条块',
  1: '单层薄片',
  2: '逐层残层',
  3: '满舱主块（基准）',
  4: '承托分级分层',
  5: '均衡层高',
};

/** 策略几何特征说明（前端 tooltip） */
export const STRATEGY_HINTS: Record<number, string> = {
  0: '只沿最长轴铺一条线，细长条块，为其它货物留出最大空间',
  1: '横向铺满一个面、竖直只放一层，主动为上方保留空腔',
  2: '每次放一层但允许末层不足整行，货物数量不整除时能多装',
  3: '三轴尽可能堆满且只吃整层，装载率最高，作为对照基准',
  4: '层数不超过货物自身堆码级别，尊重承载能力，装载率低于满舱',
  5: '按可用件数反推层数、够用即止，块的竖直占位更贴合实际货量',
};

/** 柜内容积 */
export function containerVolume(c: Container): number {
  return c.innerLength * c.innerWidth * c.innerHeight;
}

/** 货物单箱有效体积（按型变系数换算，与 orientDims 保持同一口径） */
export function boxVolume(b: Box): number {
  const [l, w, h] = effectiveDims(b);
  return l * w * h;
}

/** 全方向枚举辅助：某方向是否可生成候选（尺寸可容纳） */
export function directionFits(input: GenerateBlocksInput): boolean {
  const [dx, dy, dz] = orientDims(input.box, input.orientation);
  return dx <= input.space.dx && dy <= input.space.dy && dz <= input.space.dz;
}
