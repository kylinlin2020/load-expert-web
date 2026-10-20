/**
 * 主调度 load() —— 完整装柜流程
 *
 * 对齐逆向文档三层还原（主调度 0x4bc6c0 → 主循环 0x4bc6d9d → lp 配比 0x4a512e）：
 *
 * 1. 构造结果容器、初始化空间块数组（0x20/块）
 * 2. 贪心主循环：for dir 0..5（0x490c30 方向有效性）→ 层高枚举 1..ceil(conH/boxH)
 *    （0x490d6c / 0x52f834 ceil）→ 每层 call 0x4b48d0(PLACE_BOX) 生成候选 → 评分选优
 * 3. 遍历候选块算体积/重量比，调用 LP 配比（可选，lpEnabled=true 时用单纯形求解
 *    多货物数量分配，近似 0x4a512e 语义；TODO/UNCERTAIN：原程序在贪心填充后做
 *    整体 lp 配比修正，本实现作为放置前的数量上限预分配）
 *
 * 主循环针对单一货物类型执行（按传入货物顺序逐个装满），符合原程序"逐货物贪心"结构。
 */
import type { Box, CandidateBlock, Container, LoadOptions, MultiPlanResult, PackResult, Placement, SpaceBlock } from '../types/index.js';
import { validOrientations } from './direction-validity.js';
import { orientDims, ORIENTATION_AXIS_ORDERS, ORIENTATION_COUNT } from './orientations.js';
import { scoreBlock } from './block-scoring.js';
import { SpaceManager, type SpaceTailAxis } from './space-manager.js';
import { checkConstraints } from './constraints.js';
import { solveVolumeMix } from './simplex.js';
import { summarizeLayers } from './expand.js';
import { boxVolume, containerVolume, generateCandidateBlock, resolveOrientationPolicy, MULTI_CARGO_FOOTPRINT_RATIO, STRATEGY_AUTO, ALL_STRATEGIES } from './candidate-blocks.js';

export interface LoadParams {
  /** 货物列表（按优先级顺序处理） */
  boxes: Box[];
  /** 柜型 */
  container: Container;
  /** 候选块策略 0..5 */
  strategy: number;
  /** 是否启用 LP 体积配比（默认 false） */
  lpEnabled?: boolean;
  /** 最大迭代轮数保护（默认 100000） */
  maxIterations?: number;
  /** 计算高级设置（与顶层 lpEnabled/maxIterations 合并，options 优先） */
  options?: LoadOptions;
}

/** 可直接透传"未装原因"的约束类 reason（其余归 no-fit 推断） */
const CONSTRAINT_REASONS = new Set([
  'weight-exceed',
  'volume-exceed',
  'stack-class-exceed',
  'support-pct-exceed',
  'support-pct-invalid',
  'no-support',
]);

/** 候选块包围盒尺寸（各子块尺寸最大值，4 子块平铺于块内） */
function blockBBox(b: CandidateBlock): [number, number, number] {
  return [
    Math.max(...b.subBlocks.map((sb) => sb.x)),
    Math.max(...b.subBlocks.map((sb) => sb.y)),
    Math.max(...b.subBlocks.map((sb) => sb.z)),
  ];
}

/**
 * 查找正下方承托（此前从未传入，导致堆码/承托约束恒不触发）
 *
 * 只认"顶面高度恰好对齐"的下方块：|qTop - z| < 1e-6
 * 再按 xy 投影重叠面积取最大者。z 认作高度轴，故 supportPct[2] 为底面承托比例；
 * 没有任何下方块则视为落在柜底（100% 承托）。
 */
function findSupport(
  placements: readonly Placement[],
  x: number,
  y: number,
  z: number,
  dx: number,
  dy: number,
): { placement: Placement; contactArea: number } | null {
  let best: { placement: Placement; contactArea: number } | null = null;
  for (const q of placements) {
    if (Math.abs(q.z + q.dims[2] - z) > 1e-6) {
      continue;
    }
    const ox = Math.min(x + dx, q.x + q.dims[0]) - Math.max(x, q.x);
    const oy = Math.min(y + dy, q.y + q.dims[1]) - Math.max(y, q.y);
    if (ox <= 1e-6 || oy <= 1e-6) {
      continue;
    }
    const area = ox * oy;
    if (!best || area > best.contactArea) {
      best = { placement: q, contactArea: area };
    }
  }
  return best;
}

/** 货物在当前调度状态下的计数器 */
interface CargoState {
  box: Box;
  /** 剩余可装数量 */
  remaining: number;
  /** 已装入数量 */
  placed: number;
  /** 实际可装上限（可能小于 box.quantity，LP 配比截断） */
  limit: number;
  /** 最近一次"放不下"的原因（用于未装原因分类） */
  lastConstraintReason: string;
  /** 是否已判定"再也放不下"（连续多轮无空间可用） */
  exhausted: boolean;
}

/** 单步放置的返回值 */
interface PlaceOnceResult {
  /** 本步实际装入的件数（0 表示未装） */
  placed: number;
  /** 占用体积（mm^3） */
  volume: number;
  /** 重量（kg） */
  weight: number;
  /** 未装时的原因分类；放置成功为空 */
  reason: string;
}

/**
 * 候选块的「残余整洁度」：放置它之后，剩余空间里**仍装得下本货物**的最大单块体积
 *
 * ## 为什么需要这个指标
 *
 * 块评分 `scoreBlock` = 子块体积和。水泵场景 WP20 在两种姿态下**体积完全相同**：
 * - dir0：18 列 × 5 排 × 7 层 = 8640×1900×2660
 * - dir1：30 列 × 3 排 × 7 层 = 11400×1440×2660
 *
 * 两者体积都是 90 件/层 × 7 层，故评分**精确相等**，
 * 而选优用的是严格 `>`，于是**先枚举到的 dir0 永远赢**。
 *
 * 但两者留下的残余天差地别（split 的三分：块正上方 / x 尾端整高 / y 侧边整高）：
 * - dir0 → 尾端 3260×2340×2680、侧边 8640×440×2680（侧边只有 440mm，装不下 WP30 的 515）
 * - dir1 → 尾端 500×2340×2680、侧边 11400×900×2680（**900mm 整条**，
 *   正好容得下 WP30 的 dir1(515) + dir0(380) 两条带 —— 原软件就是这么摆的）
 *
 * dir0 的残余最大单块 3260×2340×2680；dir1 是 11400×900×2680，**更大且更规整**。
 * 所以「评分相等时选残余更整洁的」能把贪心从"对本货物最优"纠到"对整柜最优"。
 *
 * 只统计**装得下本货物**的残余：否则块正上方那条 20mm 高的死空间
 * （体积上千万）会掩盖真实差异。minDim 取本货物三轴最小边，
 * 三轴都 ≥ minDim 才算可用（保守：保证单箱一定能放进去）。
 */
function residualCleanliness(
  spaces: SpaceManager,
  space: SpaceBlock,
  candidate: CandidateBlock,
  minDim: number,
): number {
  let best = 0;
  for (const r of spaces.split(space, candidate)) {
    if (r.dx >= minDim && r.dy >= minDim && r.dz >= minDim) {
      const v = r.dx * r.dy * r.dz;
      if (v > best) {
        best = v;
      }
    }
  }
  return best;
}

/**
 * 候选块的「残余可装量」：放置它之后，各残余空间里**其它未装完货物**最多还能装多少箱
 *
 * ## 为什么需要跨货物
 *
 * 900mm 条带里的 WP30（实测：容器 11900×2340×2680，WP20 先走 dir1 做成
 * 11400×1440×2660 整块后，y 向只剩 11400×900×2680 一条带，WP30 剩 330）：
 *
 * | 候选 | 一次装 | 块体积 | 残余 | 残余还能装 |
 * |---|---|---|---|---|
 * | dir0 | 264 | 21.95e9 | 11400×**140**×2680（140 < 380，死空间） | 0 |
 * | dir1 | 180 | 14.97e9 | 11400×**385**×2680（还能再放一排 dir0） | 132 |
 *
 * 只看块体积 → dir0 赢（264 > 180），但 dir0 把条带一次占死，**总计 264**；
 * dir1 只放 180 却留下 385mm，还能再放 132，**总计 312**。
 * **局部最优恰好毁掉了全局** —— 这是真正的局部最优陷阱，不是评分打平。
 *
 * 注意残余容量必须按**其它货物**算：若按本货物（WP30）算，两种残余都能装 WP30，
 * 结论仍然是 dir0 赢（因为 dir0 的残余太大，"看起来"更值钱）；
 * 只有把"还有谁没装完"纳入考量，才会发现 140mm 那条带谁都装不下。
 *
 * ## 为什么是「深度 2」而不是「深度 1」
 *
 * 深度1 只看"一个姿态一次铺满 r 能装多少箱"，会**低估可被多次填充的条带**：
 *
 * | 残余条带 r = 11400×900×2680（WP30 = 515×380×425） | 深度1 |
 * |---|---|
 * | dir0 一次铺满（22×2×6） | 264 |
 * | dir1 先放（30×1×6=180），剩 385mm 再放 dir0（22×1×6=132） | 深度1 看不到 |
 *
 * 深度1 因此判 dir0 的残余（264）优于 dir1 的（180），
 * 于是 WP20 会挑 dir0 的 8640×1900 大板而**丢掉 336 箱的潜力**。
 * 深度2 =「用一个姿态铺满 r，再对 split 出的三块残余各算一次深度1」，
 * 才能看到 dir1 那条带是 **180 + 132 = 312** > 264。
 *
 * 这里用**闭式网格**近似铺满（floor 三轴），而非真调块生成器：
 * 无上限时两者等价，而闭式是纯算术、不产生候选对象，快两个数量级。
 * 有上限时闭式会略高估 —— 但它只参与**相对**打分（多起点里另有无上限的腿兜底）。
 *
 * @param competing 仍有剩余需求的货物（含本货物，作为其它都装不下时的兜底）
 */
function capacityDepth1(r: SpaceBlock, competing: readonly Box[], container: Container): number {
  let best = 0;
  for (const b of competing) {
    for (const o of validOrientations(b, container, r)) {
      const [dx, dy, dz] = orientDims(b, o);
      const n =
        Math.floor((r.dx + 1e-6) / dx) *
        Math.floor((r.dy + 1e-6) / dy) *
        Math.floor((r.dz + 1e-6) / dz);
      if (n > best) {
        best = n;
      }
    }
  }
  return best;
}

function residualCapacity(
  spaces: SpaceManager,
  space: SpaceBlock,
  candidate: CandidateBlock,
  competing: readonly Box[],
  container: Container,
): number {
  let total = 0;
  for (const r of spaces.split(space, candidate)) {
    // 深度1
    let best = capacityDepth1(r, competing, container);
    // 深度2：一个姿态铺满 r 后，对三块残余各算一次深度1
    for (const b of competing) {
      for (const o of validOrientations(b, container, r)) {
        const [dx, dy, dz] = orientDims(b, o);
        const nX = Math.floor((r.dx + 1e-6) / dx);
        const nY = Math.floor((r.dy + 1e-6) / dy);
        const nZ = Math.floor((r.dz + 1e-6) / dz);
        if (nX <= 0 || nY <= 0 || nZ <= 0) {
          continue;
        }
        const sx = dx * nX;
        const sy = dy * nY;
        const sz = dz * nZ;
        const placed = nX * nY * nZ;
        const residuals: SpaceBlock[] = [
          { x: 0, y: 0, z: 0, dx: sx, dy: sy, dz: r.dz - sz },
          { x: 0, y: 0, z: 0, dx: r.dx - sx, dy: r.dy, dz: r.dz },
          { x: 0, y: 0, z: 0, dx: sx, dy: r.dy - sy, dz: r.dz },
        ];
        let acc = placed;
        for (const sub of residuals) {
          if (sub.dx > 0 && sub.dy > 0 && sub.dz > 0) {
            acc += capacityDepth1(sub, competing, container);
          }
        }
        if (acc > best) {
          best = acc;
        }
      }
    }
    total += best;
  }
  return total;
}

/**
 * 为单一货物寻找并放置**一个**最优块（不循环）
 *
 * 拆出单步放置是为了让主调度能在多种货物间**轮转**（round-robin），
 * 而不是让先到的货物独占整柜 —— 见 load() 中 P0-d 说明。
 */
function placeOnce(
  box: Box,
  availableCount: number,
  container: Container,
  strategy: number,
  spaces: SpaceManager,
  placements: Placement[],
  usedVolume: number,
  usedWeight: number,
  opts: Required<LoadOptions>,
  preferredSpaceIdx = -1,
  multiCargo = false,
  /** 混装时的单块体积占比上限（由多起点调度传入，见 CARGO_CONFIGS） */
  blockRatio = 0,
  /** 混装时的单块 xy 足迹占比上限（0 = 不限制） */
  footprintRatio = 0,
  /**
   * 评分**相等**时是否优先选「残余更整洁」的块（见 residualCleanliness）
   *
   * 这是多起点的维度之一：评分打平时"先枚举者胜出"是一个**偶然**结果，
   * 而两种姿态常常体积相同、只是残余形状天差地别。
   * 关闭时保留历史行为（体积相等取先出现的），由多起点择优决定用哪种。
   */
  preferCleanResidual = false,
  /**
   * 残余前瞻权重 β：score = 块体积 + β × 残余可装量 × 本箱体积（见 residualCapacity）
   *
   * 0 = 关闭（纯体积评分）。取 0.9 而非 1.0 的理由：
   * β=1 时「装满整块」与「只装 60% 但形状规整」得分几乎相同，
   * 会让评分**对装多少失去区分度**，可能反复放小块「省」空间。
   * β=0.9 保留了「装得越多越优先」的单调性，同时让残余形状足以推翻接近的比分。
   */
  residualWeight = 0,
  /** 仍有剩余需求的货物（含本货物），供残余前瞻评估「这块之外谁还能装」 */
  competingBoxes: readonly Box[] = [],
): PlaceOnceResult {
  if (availableCount <= 0 || spaces.count === 0) {
    return { placed: 0, volume: 0, weight: 0, reason: 'space-exhausted' };
  }
  let lastConstraintReason = '';

  // 选择一个空间：默认体积最大者（FillSpace 常见启发式，TODO/UNCERTAIN：原程序选择策略）
  // 多货物轮转时由调度层指定 preferredSpaceIdx 以实现货物间均衡。
  let spaceIdx = -1;
  if (preferredSpaceIdx >= 0 && preferredSpaceIdx < spaces.count) {
    spaceIdx = preferredSpaceIdx;
  } else {
    let bestSpaceVol = -1;
    for (let i = 0; i < spaces.count; i++) {
      const s = spaces.get(i)!;
      const v = s.dx * s.dy * s.dz;
      if (v > bestSpaceVol) {
        bestSpaceVol = v;
        spaceIdx = i;
      }
    }
  }
  if (spaceIdx < 0) {
    return { placed: 0, volume: 0, weight: 0, reason: 'space-exhausted' };
  }
  const space = spaces.get(spaceIdx)!;

  // 方向枚举 0..5 + 有效性判定
  let dirs = validOrientations(box, container, space);
  if (!opts.allowRotation) {
    // 高级设置：禁止旋转 → 仅保留原方向 dir0（L→x, W→y, H→z）
    dirs = dirs.includes(0) ? [0] : [];
  }
  if (dirs.length === 0) {
    spaces.removeAt(spaceIdx);
    return { placed: 0, volume: 0, weight: 0, reason: 'no-fit' };
  }

  // 层高枚举 1..ceil(space.dz/dz)，每层生成候选块并选评分最高者
  // 姿态档按**实际可用方向**解析：首选档不可行时退到次偏好档，避免因
  // 方向限制与姿态档恰好不相交而整柜 0 放置（见 resolveOrientationPolicy 注释）
  const policy = resolveOrientationPolicy(strategy, [box.length, box.width, box.height], dirs);
  // 残余可用性判定阈值：本货物三轴最小边（三轴都 ≥ 它才算"装得下本货物"）
  const minDim = Math.min(box.length, box.width, box.height);
  let best: CandidateBlock | null = null;
  /** best 的综合评分缓存（避免每次比较都重算残余前瞻） */
  let bestScore = 0;
  /** best 的残余整洁度缓存（仅 preferCleanResidual 时维护，避免重复 split） */
  let bestClean = 0;

  /**
   * 候选块综合评分 = 块体积 + β × 残余可装量 × 本箱体积
   *
   * β=0（residualWeight 缺省）时退化为纯 `scoreBlock`，与历史行为完全一致。
   */
  const effScore = (c: CandidateBlock): number => {
    const own = scoreBlock(c);
    if (residualWeight <= 0) {
      return own;
    }
    return own + residualWeight * residualCapacity(spaces, space, c, competingBoxes, container) * boxVolume(box);
  };

  let candidateSeen = 0;
  let limitHit = false;
  for (const dir of dirs) {
    if (limitHit) {
      break;
    }
    const [dx, dy, dz] = orientDims(box, dir);
    const maxLevels = Math.max(1, Math.ceil(space.dz / dz));
    for (let level = 1; level <= maxLevels; level++) {
      // 高级设置：候选块数量上限（candidateLimit>0 时截断，0 表示不限制）
      if (opts.candidateLimit > 0 && candidateSeen >= opts.candidateLimit) {
        limitHit = true;
        break;
      }
      const candidate = generateCandidateBlock(
        {
          box,
          container,
          x: space.x,
          y: space.y,
          z: space.z,
          space,
          orientation: dir,
          level,
          availableCount,
          // 多货物时限制单块体积/足迹占比，强制留出空间给其它货物（P0-d）；
          // 比例由多起点调度传入（这两个比例同样随场景变化，见 CARGO_CONFIGS）
          maxBlockVolumeRatio: multiCargo ? blockRatio : 0,
          maxBlockFootprintRatio: multiCargo ? footprintRatio : 0,
        },
        strategy,
        policy,
      );
      if (!candidate) {
        continue;
      }
      candidateSeen++;
      candidate.weight = candidate.pieceCount * box.weight;
      // 块包围盒（用于承托接触面积与 xy 重叠判定）
      const [bdx, bdy] = blockBBox(candidate);
      // 查找正下方承托（此前从未传入，导致堆码/承托约束恒不触发）
      const support = findSupport(placements, candidate.x, candidate.y, candidate.z, bdx, bdy);
      // 约束判定（体积/重量/堆码/承托；后两项受高级设置开关控制）
      const cr = checkConstraints({
        box,
        container,
        usedWeight,
        usedVolume,
        count: candidate.pieceCount,
        // 体积按单件姿态尺寸 × 件数计（不按包围盒，避免多件块被重复放大）
        placement: { x: candidate.x, y: candidate.y, z: candidate.z, dims: [dx, dy, dz] },
        space,
        below: support?.placement,
        contactArea: support?.contactArea,
        footprintArea: bdx * bdy,
        enabled: { stack: opts.stackRulesEnabled, support: opts.supportRulesEnabled },
      });
      if (!cr.ok) {
        lastConstraintReason = cr.reason ?? '';
        continue;
      }
      if (!best) {
        best = candidate;
        bestScore = effScore(candidate);
        if (preferCleanResidual) {
          bestClean = residualCleanliness(spaces, space, candidate, minDim);
        }
        continue;
      }
      const candScore = effScore(candidate);
      // 残余整洁度只在综合评分**相等**时才有决定权（体积相同 = 同一批箱子换朝向）
      const tieBroken = preferCleanResidual && Math.abs(candScore - bestScore) <= 1e-6;
      if (candScore > bestScore + 1e-6 || (tieBroken && residualCleanliness(spaces, space, candidate, minDim) > bestClean)) {
        best = candidate;
        bestScore = candScore;
        if (preferCleanResidual) {
          bestClean = residualCleanliness(spaces, space, candidate, minDim);
        }
      }
    }
  }

  if (!best) {
    // 无可行候选：剩余件数不足以构成最小整块，或所有姿态均被约束拒绝。
    // 空间本身仍有利用价值（保留给其他货物），返回原因交由调度层判断。
    const reason = CONSTRAINT_REASONS.has(lastConstraintReason) ? lastConstraintReason : 'no-fit';
    return { placed: 0, volume: 0, weight: 0, reason };
  }

  // 放置整块：候选块包围盒 = 各子块尺寸最大值（4 子块平铺于块内）
  const [bboxDx, bboxDy, bboxDz] = blockBBox(best);
  const place: Placement = {
    orientation: best.orientation,
    dims: [bboxDx, bboxDy, bboxDz],
    x: best.x,
    y: best.y,
    z: best.z,
    boxId: box.id,
    count: best.pieceCount,
    stackClass: box.stackClass,
    supportClass: box.supportClasses[best.orientation] ?? 0,
  };
  placements.push(place);

  const newSpaces = spaces.split(space, { x: best.x, y: best.y, z: best.z, dims: [bboxDx, bboxDy, bboxDz] }, box.id);
  for (const ns of newSpaces) {
    spaces.add(ns);
  }
  spaces.removeAt(spaceIdx);

  const cartonVol = boxVolume(box);
  return {
    placed: best.pieceCount,
    volume: cartonVol * best.pieceCount,
    weight: best.weight,
    reason: '',
  };
}

/**
 * 「别压在别人头上码」的空间偏好系数（pickSpaceFor 用）
 *
 * ## 要解决的真实故障（策略0/1 装载率只有 78%/82%，而单货物时能装满 100%）
 *
 * 逐层码放的策略（策略1「单层薄片」、策略2「逐层码放」）在混装时，
 * 两种货物会**逐层交替**往上码：WP20 码一层 → WP30 在它头顶码一层 → WP20 再往上…
 * 而两种货物的 x 步长不同（480 vs 515），**每交替一次就把可用宽度削掉一截**：
 * ```
 * WP20 层 0：11520 宽（24 列）
 * WP30 层 1：11330 宽（22 列）→ 右侧剩 190mm 谁也放不下
 * WP20 层 2：11040 宽（23 列）→ 又削 290mm
 * WP30 层 3：10815 …→ 空间 x 向单调缩水，最后谁都码不下了（486+327）
 * ```
 * 同一货物自己连续码层则完全稳定（宽度不缩水）——
 * **问题不是块形状，是"谁在码"**。
 *
 * ## 系数取值
 * - 空间坐在**柜底**（`baseBoxId` 未定义）：1.0，正常参与竞争
 * - 空间压在**自己**的块上：1.0，继续把自己的垛码高（这是应该的）
 * - 空间压在**别人**的块上：STACK_AVOID 折价，鼓励两种货物**并排**长
 *   （WP20 走 x 前段、WP30 走 x 尾段），而不是叠在一起互相削宽
 *
 * 取 0.2 而非 0：留一条兜底路 —— 当柜内确实只剩压在别人头上的空间时
 * 仍能放（宁可削宽也不能不装）。策略3/5 的残余多为侧边/尾端条带（都在柜底），
 * 故这条规则对它们基本无影响，零回归。
 *
 * 实测（水泵 630+330 / 40HQ 与三组混装场景，共 18 个场景点）：
 * | 值 | S0 | S1 | 说明 |
 * |---|---|---|---|
 * | 0（关闭） | 773 | 813 | 修复前 |
 * | 0.5 | 910 | 929 | 惩罚太弱，拉不回来 |
 * | **0.2** | **935** | **929** | 采用；相对基线共 17 点提升、仅 1 点 −0.4 |
 * | 0.35 | 935 | 929 | 与 0.2 同分，但 20ft 三货 S5 多掉 1.9 点 |
 */
const STACK_AVOID = 0.2;

function stackBias(s: SpaceBlock, c: CargoState): number {
  if (s.baseBoxId === undefined || s.baseBoxId === c.box.id) {
    return 1;
  }
  return STACK_AVOID;
}

/** 货物优先级比较函数（决定谁先抢空间） */
export type CargoSortKey = (a: CargoState, b: CargoState) => number;

/**
 * 跑一次贪心（多起点的**单条腿**）
 *
 * 贪心主循环（单次）：输入货物列表 + 柜型 + 策略参数 + 货物优先级，输出 PackResult
 *
 * 由 load() 按不同 sortKey 反复调用取最优（见文件下方「多起点调度」）。
 *
 * 导出 runGreedy 与 CARGO_CONFIGS 供 scripts/ 与测试**逐配置诊断**用
 * （只看 `load()` 的聚合结果无法判断是哪一腿赢了、哪一腿饿死了货物）。
 * 业务路径请一律走 `load()`。
 *
 * @param tailAxis 剩余空间切分方向（见 SpaceTailAxis），是**多起点的维度之一**：
 *   同一条腿换切分方向会得到不同的残余空间形状，进而装进不同的块。
 */
export function runGreedy(
  params: LoadParams,
  sortKey: CargoSortKey,
  blockRatio: number,
  footprintRatio: number,
  preferCleanResidual = false,
  residualWeight = 0,
  tailAxis: SpaceTailAxis = 'x',
): PackResult {
  const { boxes, container, strategy, lpEnabled = false, maxIterations = 100000, options } = params;
  // 高级设置合并：options 优先，顶层 lpEnabled/maxIterations 向后兼容
  const opts: Required<LoadOptions> = {
    lpEnabled: options?.lpEnabled ?? lpEnabled,
    allowRotation: options?.allowRotation ?? true,
    stackRulesEnabled: options?.stackRulesEnabled ?? true,
    supportRulesEnabled: options?.supportRulesEnabled ?? true,
    candidateLimit: options?.candidateLimit ?? 0,
    maxIterations: options?.maxIterations ?? maxIterations,
  };
  const containerVol = containerVolume(container);

  // —— 阶段1/2：初始化空间块数组 + 贪心主循环（逐货物）——
  const spaces = new SpaceManager();
  spaces.tailAxis = tailAxis;
  spaces.add({ x: 0, y: 0, z: 0, dx: container.innerLength, dy: container.innerWidth, dz: container.innerHeight });

  const placements: Placement[] = [];
  const rejected: Array<{ boxId: string; reason: string }> = [];
  const iterations = { value: 0 };

  let usedVolume = 0;
  let usedWeight = 0;

  // —— LP 预分配：多货物时用单纯形按体积/重量/上限求每种货物的建议箱数（近似 0x4a512e）——
  const cargo: CargoState[] = boxes
    .filter((b) => b.quantity > 0)
    .map((b) => ({
      box: b,
      remaining: b.quantity,
      placed: 0,
      limit: b.quantity,
      lastConstraintReason: '',
      exhausted: false,
    }))
    .sort(sortKey);

  /**
   * 「数量留空 = 不限」的货物单独成一组，**第二阶段**才参与装载
   *
   * ## 为什么要分阶段（用户反馈：填了数量却没按填的算）
   *
   * 用户把其中几种货物的数量填好、另一种留空，期望是
   * **"填了数量的按填的装满，留空的那种拿剩下的空间"**。
   *
   * 旧实现把留空翻译成 `quantity = 柜内容积 / 单箱体积`（几何容量），
   * 对算法而言它就是一个**普通的、比别的货物大 3~4 倍的硬上限**，
   * 于是和"填了数量"的货物一视同仁地按体积份额瓜分空间：
   *
   * ```
   * 40HQ（74.63 m³）+ 水泵2=630 + 水泵3=336 + 水泵4（400×300×300）留空
   *  → 几何容量 = 74.63 / 0.036 = 2072
   * ```
   *
   * | 策略 | 水泵2 | 水泵3 | 水泵4 | 装载率 |
   * |---|---|---|---|---|
   * | 0 | 385 | 276 | 485 | 89.91% |
   * | 3 | 354 | 336 | 420 | 90.59% |
   * | 5 | **141** | 251 | 984 | 88.54% |
   *
   * 填了 630 的那个被压到 **141**，填了 336 的那个被压到 251 ——
   * 用户看到的就是"我填的数量没被当回事"。
   * 根因不是贪心本身弱，而是**"承诺"和"填充"这两种意图被压成了同一种数字**。
   *
   * ## 分阶段后的语义
   * - 阶段① 只装填了数量的（`unlimited` 为假）：它们之间仍按原有的轮转/均衡逻辑，
   *   **多起点择优（种类数 → 装载率）完全不受影响** —— 全部货物都填数量时
   *   只有一个阶段，行为与改动前逐字节一致（966 箱 / 95.96% 的基准不受影响）。
   * - 阶段② 装留空的：这时剩余空间就是它的，把缝隙填满。
   *
   * 全部留空 / 全部填数量两种情形都只有**一个**阶段，因此是零行为变化。
   */
  const bounded = cargo.filter((c) => !c.box.unlimited);
  const unbounded = cargo.filter((c) => c.box.unlimited === true);

  if (opts.lpEnabled && bounded.length > 1) {
    // LP 只在阶段①内部做配比：对留空货物做配比会直接违背"不限"的语义。
    // 全部货物都填数量时 bounded === cargo，与改动前完全一致。
    const mix = solveVolumeMix(
      bounded.map((c) => boxVolume(c.box)),
      bounded.map((c) => c.remaining),
      bounded.map((c) => c.box.weight),
      containerVol,
      container.weightCapacity,
    );
    if (mix.ok) {
      bounded.forEach((c, i) => {
        const s = mix.solution[i];
        if (Number.isFinite(s) && s >= 0) {
          c.limit = Math.min(c.limit, Math.floor(s));
          c.remaining = Math.min(c.remaining, c.limit);
        }
      });
    }
  }

  // —— 贪心主循环（round-robin）——
  //
  // P0-d 修复：原实现是"先到先得"，每个货物顺序扫一遍空间，
  // 相当于 `for (const box of boxes) fillBox(...)` —— 先到者会吃掉 100% 的空间，
  // 后面两种货物全部 space-exhausted（实测 40HQ 混装 480×380×380 + 420×310×260
  // 的标准场景下，后两种只能装 0 箱）。
  //
  // 改口径为**每轮只装一种货物，然后轮转给下一个未装完的**，
  // 使用每种货物自己的空间选择函数轮转。
  //
  // 循环退出条件：
  //  1. 无可行空间
  //  2. 所有货物都已装完 或 已确认放不下（exhausted）
  //  3. 达到迭代上限
  //
  // 注：`exhausted` 采用"连续 N 轮放不下即放弃"的粘性判定，
  // 避免因空间被其它货物占用而误判该货物永远放不下。
  const STICKY_MISS = 3;
  const misses = new Map<string, number>();
  let guard = 0;
  const guardLimit = Math.max(10000, opts.maxIterations * 2);

  // 多货物时，**按货物逐个选择空间**而非固定取最大空间。
  // 原因：placeOnce 内部固定挑"体积最大的空间"，若所有货物都抢同一个空间，
  // 先轮到的货物会把整块吃掉（策略 3/5 生成巨型块时尤其明显，
  // 实测顺序 A→B 得 507 箱、B→A 得 855 箱，偏差 40%）。
  // 这里为每种货物在"能容纳它的空间"中按体积降序取最大者，
  // 并以各货物已装体积占比做轻微均衡，避免大块反复由同一货物取得。
  //
  // `peers` 是**当前阶段**的同组货物，而不是全部货物 ——
  // 均衡只应在"一起分空间的人"之间做：阶段①里那个留空的货物还没出场，
  // 若把它算进 others，会让阶段①的均衡判据一直偏移。
  const pickSpaceFor = (c: CargoState, peers: CargoState[]): number => {
    if (peers.length <= 1) {
      return -1; // 交给 placeOnce 内部的最大空间启发式
    }
    const dims = [c.box.length, c.box.width, c.box.height];
    // 各货物「期望占用的体积份额」（按可用数量 × 单箱体积）
    const share = (x: CargoState) => Math.max(1, x.limit) * boxVolume(x.box);
    // 当前货物已装体积 / 其期望份额：>= 1 表示已超额，其它货物更该获得空间
    const overshoot = (x: CargoState) => (x.placed * boxVolume(x.box)) / share(x);

    let bestIdx = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < spaces.count; i++) {
      const s = spaces.get(i)!;
      // 该空间至少要能放下当前货物在某个姿态下的一箱
      const canFit = ORIENTATION_AXIS_ORDERS.some((order) => {
        const d = [dims[order[0]], dims[order[1]], dims[order[2]]];
        return d[0] <= s.dx && d[1] <= s.dy && d[2] <= s.dz;
      });
      if (!canFit) {
        continue;
      }
      const spaceVol = s.dx * s.dy * s.dz;
      // 惩罚项：其它货物中若有装得更少的，当前货物应让出大空间
      const others = peers.filter((x) => x !== c && x.remaining > 0);
      const minOther = others.length ? Math.min(...others.map(overshoot)) : Infinity;
      // 差距越大，惩罚越重（分母用 1 避免除零；差距 0 时无惩罚）
      const penalty = 1 / (1 + Math.max(0, minOther === Infinity ? 0 : 0.5 - overshoot(c)));
      // stackBias：避免压在别人头上逐层交错（逐层码放策略的大坑，见其注释）
      const score = spaceVol * penalty * stackBias(s, c);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    return bestIdx;
  };

  /**
   * 一个装载阶段：只让 `peers` 里的货物参与轮转，直到装完或空间用尽
   *
   * 抽成函数而不是写两遍循环，是因为阶段②必须**复用完全相同的贪心逻辑**：
   * 留空的那种货物填缝隙时同样需要轮转、均衡、残余前瞻与 sticky-miss，
   * 任何一处不一致都会让"填缝隙"退化成某种更笨的填法。
   *
   * `guard` / `iterations` / `misses` / `spaces` 与 `usedVolume`/`usedWeight`
   * 都在闭包外，两个阶段**共用同一份空间与累计量**，因此阶段②看到的是
   * 阶段①装完之后剩下的柜子。
   */
  const packPhase = (peers: CargoState[]): void => {
    if (peers.length === 0) {
      return;
    }
    while (spaces.count > 0 && guard < guardLimit) {
      guard++;
      iterations.value++;
      if (iterations.value > opts.maxIterations) {
        break;
      }
      let progressed = false;

      for (const c of peers) {
        if (c.remaining <= 0 || c.exhausted) {
          continue;
        }
        // 块大小上限只在「仍有货物一件未装」时生效：
        // 先让每种货物都拿到入场券（避免先到者吃满整柜），
        // 一旦所有货物都已参与，就解除限制、自由填充以最大化装载率。
        // 一直限着会导致装载率大幅下降（实测策略1 从 80% 掉到 27%）。
        // 判据只看**当前阶段**的同组货物：阶段②的留空货物在阶段①还没装任何一箱，
        // 若把它算进来，阶段①会被永久限着块大小，基准场景直接崩掉。
        const needFairness = peers.some((x) => x.placed === 0 && x.remaining > 0);
        const r = placeOnce(
          c.box,
          c.remaining,
          container,
          strategy,
          spaces,
          placements,
          usedVolume,
          usedWeight,
          opts,
          pickSpaceFor(c, peers),
          peers.length > 1 && needFairness,
          blockRatio,
          footprintRatio,
          preferCleanResidual,
          residualWeight,
          // 残余前瞻需要知道"这块之外还有谁没装完"
          peers.filter((x) => x.remaining > 0).map((x) => x.box),
        );
        if (r.placed > 0) {
          usedVolume += r.volume;
          usedWeight += r.weight;
          c.remaining -= r.placed;
          c.placed += r.placed;
          progressed = true;
        } else {
          c.lastConstraintReason = r.reason;
          const n = (misses.get(c.box.id) ?? 0) + 1;
          misses.set(c.box.id, n);
        }
      }

      if (progressed) {
        // 空间拓扑已变化（某货物成功放置 → split 产生新空间），
        // 必须清空所有 miss 计数：否则先到的货物会在自身放不下的时刻
        // 被永久标记 exhausted，而此时其它货物仍在不断腾出新空间，
        // 后到的货物将再无参与机会（实测 B→A 顺序下 A 恒装入 0 箱）。
        misses.clear();
        continue;
      }

      // 本轮全体零进展：连续多轮无解才判定这些货物确实放不下
      let allDone = true;
      for (const c of peers) {
        if (c.remaining > 0 && (misses.get(c.box.id) ?? 0) >= STICKY_MISS) {
          c.exhausted = true;
        }
        if (c.remaining > 0 && !c.exhausted) {
          allDone = false;
        }
      }
      if (allDone) {
        // 本轮所有货物都放不下 → 空间已无法再被利用
        break;
      }
    }
  };

  // 阶段①先装填了数量的（承诺），阶段②再让留空的去填剩余空间。
  // 全部填数量 / 全部留空时都只有一个阶段，行为与改动前一致。
  packPhase(bounded);
  packPhase(unbounded);

  // —— 未装清单与原因分类 ——
  for (const c of cargo) {
    if (c.placed < c.limit) {
      let reason: string;
      if (c.placed === 0 && c.limit < c.box.quantity) {
        // LP 配比截断：建议数量为 0
        reason = 'lp-capped';
      } else if (iterations.value > opts.maxIterations) {
        reason = 'iteration-limit';
      } else if (spaces.count === 0) {
        reason = 'space-exhausted';
      } else if (CONSTRAINT_REASONS.has(c.lastConstraintReason)) {
        reason = c.lastConstraintReason;
      } else {
        reason = 'no-fit';
      }
      rejected.push({ boxId: c.box.id, reason });
    } else if (c.limit < c.box.quantity) {
      // 装满了 LP 建议上限，仍有剩余可用量
      rejected.push({ boxId: c.box.id, reason: 'lp-capped' });
    }
  }

  // 层信息：按每箱实际 z 底面聚合（不再把整个聚合块当作一层）
  // 原实现按 placement 包围盒聚类，导致 200³ 小箱装出 3 个物理层却只报 1 层
  const layers = summarizeLayers(placements, boxes);

  const pieces = placements.reduce((acc, p) => acc + p.count * (boxes.find((b) => b.id === p.boxId)?.pcsCount ?? 1), 0);
  const loadRate = containerVol > 0 ? usedVolume / containerVol : 0;

  return {
    container,
    placements,
    usedVolume,
    loadRate,
    totalWeight: usedWeight,
    pieces,
    layers,
    strategy,
    lpEnabled,
    rejected,
    iterations: iterations.value,
  };
}

/* ───────────────────────── 多起点调度 ───────────────────────── */

/** 单箱体积降序（大件优先，经典装箱启发式；也是历史行为） */
const VOL_DESC: CargoSortKey = (x, y) => boxVolume(y.box) - boxVolume(x.box);
/** 箱数降序（需求最多的货物优先，它最需要连续大空间） */
const QTY_DESC: CargoSortKey = (x, y) => y.box.quantity - x.box.quantity || boxVolume(y.box) - boxVolume(x.box);

/**
 * 多起点候选配置表
 *
 * ## 为什么要多起点（而不是猜一个启发式）
 *
 * ### ① 货物优先级 —— 没有普适最优
 * | 场景 | 单箱体积降序 | 箱数降序 |
 * |---|---|---|
 * | 40HQ 三货物 S0/S1 | 76.1% / 83.6% | **64.7% / 63.7%**（掉 10~20 点） |
 * | 水泵（11900×2340×2680，630+330）S3 | 89.79% | **92.62%**（WP20 拿到完整 30×3×7 整块） |
 *
 * - 「体积降序」大件先走 → 大件拿干净空间，小件填残余（三货物更优）
 * - 「箱数降序」需求最多的先走 → 它需要最大连续空间，否则永远凑不满整块（水泵更优）
 *
 * ### ② 混装块体积上限 —— 同样随场景翻转
 * 上限小 → 每块矮、留白多、别的货物容易介入，但整体被切碎；
 * 上限大 → 一次成整块、装载率高，但可能把别的货物挤死。
 *
 * 与其猜启发式，不如**都跑一遍取装载率最高的**。
 *
 * ## 重要教训：新增维度必须「追加」不能「替换」
 * 曾把候选⑤⑥替换成「残余整洁」变体，结果 20ft 三货物 S1 从 84.8% 掉到 **76.4%** ——
 * 老的无上限腿在 20ft 场景上不可替代。老腿即使在某个场景不是最优，
 * 也可能在别的场景是唯一解。
 */
export const CARGO_CONFIGS: ReadonlyArray<{ sortKey: CargoSortKey; blockRatio: number; footprintRatio: number; preferCleanResidual: boolean; residualWeight: number }> = [
  // ── ①~④：残余整洁维度引入前的历史四腿，全部保留（一改动就会掉 5~8 个点）──
  // ① 单箱体积降序 + 原有双上限（历史行为，保证不退化）
  { sortKey: VOL_DESC, blockRatio: 0.5, footprintRatio: MULTI_CARGO_FOOTPRINT_RATIO, preferCleanResidual: false, residualWeight: 0 },
  // ② 箱数降序 + 原有双上限（需求最多的先走，能拿到整条长块；水泵场景胜出腿）
  { sortKey: QTY_DESC, blockRatio: 0.5, footprintRatio: MULTI_CARGO_FOOTPRINT_RATIO, preferCleanResidual: false, residualWeight: 0 },
  // ③ 放宽体积上限（三货物场景更优）
  { sortKey: VOL_DESC, blockRatio: 0.75, footprintRatio: MULTI_CARGO_FOOTPRINT_RATIO, preferCleanResidual: false, residualWeight: 0 },
  // ④ 放宽体积上限 + 箱数降序（40HQ 两货物 S3 的 93.1% 靠这条腿）
  { sortKey: QTY_DESC, blockRatio: 0.75, footprintRatio: MULTI_CARGO_FOOTPRINT_RATIO, preferCleanResidual: false, residualWeight: 0 },
  // ── ⑤⑥：完全无上限（足迹也不限）──
  //   实测「无上限」本身并非普适最优，但它会产出与 ①~④ **互补**的解法，
  //   在 20ft 三货物 S1/S2 上比任何带上限的腿高 8 个点。
  { sortKey: VOL_DESC, blockRatio: 0, footprintRatio: 0, preferCleanResidual: false, residualWeight: 0 },
  { sortKey: QTY_DESC, blockRatio: 0, footprintRatio: 0, preferCleanResidual: false, residualWeight: 0 },
  // ── ⑦⑧：残余整洁优先（评分打平时不让「先枚举者」这个偶然决定结果）──
  //   ⑦ 水泵 944 箱（WP30 拿满 330），与 ② 的 948（WP20 拿满 630）**分项互补**：
  //   一个把大件装完、另一个把小件装完，谁更优随场景翻转，两条腿都得留着。
  { sortKey: VOL_DESC, blockRatio: 0, footprintRatio: MULTI_CARGO_FOOTPRINT_RATIO, preferCleanResidual: true, residualWeight: 0 },
  { sortKey: QTY_DESC, blockRatio: 0, footprintRatio: 0, preferCleanResidual: true, residualWeight: 0 },
  // ── ⑨⑩：残余前瞻（跨货物深度 2）—— 唯一能把水泵场景打满 960 的一类腿 ──
  //   纯块评分只看「这一块装多少」，于是会选那种**一次装得多、却把残余占死**的块：
  //   900mm 条带里 WP30 选 dir0（264）而不是 dir1（180，留 385mm 再放 132 = 312），
  //   典型的局部最优陷阱。
  //   加入前瞻后评分变为「块体积 + β × 残余还能装多少箱（按其它未装完货物算，深度 2）」，
  //   这类陷阱被破解：**水泵 630+330 达到 960 箱，两种货物都 100% 装完（95.29%）**。
  //   β=0.9：0.7~1.0 实测同为 960，取中间偏保守值以保留「装得越多越优先」的单调性。
  { sortKey: QTY_DESC, blockRatio: 0, footprintRatio: 0, preferCleanResidual: false, residualWeight: 0.9 },
  { sortKey: VOL_DESC, blockRatio: 0, footprintRatio: 0, preferCleanResidual: false, residualWeight: 0.9 },
  // ── ⑪⑫：足迹比例 0.6 —— 逐层码放策略（1/2）的最优足迹比例，与 0.75/0 都不同 ──
  //   实测扫描（scripts/footprint-tradeoff.mjs，水泵 630+330）：
  //   | fp | S0 | S1 | S2 | S3 |
  //   |---|---|---|---|---|
  //   | 0.60 | 935 | **948** | **948** | 942 | ← 采用
  //   | 0.75 | 935 | 921 | 921 | 942 | 候选表原有
  //   | 0（不限） | 935 | 813 | 814 | 960 | 策略3 在这里才到 960
  //   即 **fp=0.6 对策略1/2 最好、fp=0 对策略3 最好**，两者不可兼得。
  //   注意 S0 对 fp 完全不敏感（generateStrategy0 根本没调 capFootprint），
  //   所以新增这两腿不会改变 S0 的 935。
  { sortKey: QTY_DESC, blockRatio: 0, footprintRatio: 0.6, preferCleanResidual: false, residualWeight: 0.9 },
  { sortKey: VOL_DESC, blockRatio: 0, footprintRatio: 0.6, preferCleanResidual: false, residualWeight: 0.9 },
  // ── ⑬~⑱：残余前瞻 β 的中间档（0.3）+ 残余整洁与「足迹也放到 0」的组合 ──
  //   这六条是**贪心集合覆盖**在全网格上选出来的（见下方「怎么选出来的」）。
  //   逐条对应一个明确收益（第 1 条 +6.32、第 2 条 +5.40、第 3 条 +3.01、
  //   第 4 条 +1.61、第 5 条 +1.45、第 6 条 +0.88 点，六条合计吃掉 96% 的可达空间）。
  //
  //   ⑬ 无上限 + 残余整洁 + 无前瞻（= ⑦ 把足迹也从 0.75 放开到 0）
  //      单条腿就值 +6.32 点，是全部新增里最值钱的一条。
  { sortKey: VOL_DESC, blockRatio: 0, footprintRatio: 0, preferCleanResidual: true, residualWeight: 0 },
  //   ⑭ 放宽双上限 + **β=0.3**（前瞻强度取中间档）
  //      +5.40 点。原表只有 β=0 与 β=0.9 两档，**0.3 这一档是空的**：
  //      β=0 完全不看残余、β=0.9 又过度看重残余而牺牲当次装入量。
  { sortKey: VOL_DESC, blockRatio: 0.75, footprintRatio: MULTI_CARGO_FOOTPRINT_RATIO, preferCleanResidual: false, residualWeight: 0.3 },
  //   ⑮ 无上限 + β=0.3（= ⑤/⑦ 把 β 换成中间档）
  //      +3.01 点，专门补「数量不齐」这类场景：有的货物已装完、有的还没装完时，
  //      前瞻权重太高会让算法一直盯着早装完的货物。
  { sortKey: VOL_DESC, blockRatio: 0, footprintRatio: 0, preferCleanResidual: false, residualWeight: 0.3 },
  //   ⑯ 箱数降序 + 无体积上限 + 保留足迹上限 + β=0.9
  //      +1.61 点，补「大小悬殊」场景（大件必须先拿到整块，小件随后填缝）。
  { sortKey: QTY_DESC, blockRatio: 0, footprintRatio: MULTI_CARGO_FOOTPRINT_RATIO, preferCleanResidual: false, residualWeight: 0.9 },
  //   ⑰ 原有体积上限 + 足迹放到 0 + β=0.3
  { sortKey: VOL_DESC, blockRatio: 0.5, footprintRatio: 0, preferCleanResidual: false, residualWeight: 0.3 },
  //   ⑱ 原有体积上限 + 残余整洁 + β=0.3
  { sortKey: VOL_DESC, blockRatio: 0.5, footprintRatio: MULTI_CARGO_FOOTPRINT_RATIO, preferCleanResidual: true, residualWeight: 0.3 },
];

/**
 * 剩余空间切分方向 ── 多起点的**又一个维度**
 *
 * 同一个「放置哪些块、谁先走」的决策，在放完一块之后要把剩余空间切开；
 * 而切法有两种（见 SpaceManager.split 的 SpaceTailAxis），**哪一种更好随场景翻转**：
 *
 * | 场景（策略 3） | 切分 x（历史） | 切分 y（镜像） | 差 |
 * |---|---|---|---|
 * | 45HQ 三货物 | 84.79% | **86.01%** | +1.23 |
 * | 两货物尺寸接近 | 87.37% | **89.30%** | +1.93 |
 * | 20ft 三货物 | 88.58% | **90.26%** | +1.68 |
 * | 45HQ 长条件 | 86.29% | **87.78%** | +1.50 |
 * | 水泵基准 630+336（40HQ） | **95.96%** | 94.62% | −1.34 |
 * | 三货物大规模 | **91.75%** | 88.04% | −3.71 |
 * | 扁平大件 | **85.87%** | 81.81% | −4.05 |
 *
 * 单独替换是**中性**的（120 个「场景×策略」组合：升 54 / 降 31 / 平 83，平均 +0.014 点），
 * 所以**只加不减**：两种方向都跑，按既有的择优口径（多货物：种类数 → 装载率；
 * 单货物：装载率）取最好的一次。作为追加维度实测 **平均 +0.42 点、最大 +3.04 点、零下降**，
 * 基准场景（水泵 966 箱 / 95.96%）逐位不变。
 *
 * 代价是贪心次数翻倍（单柜约 7ms → 14ms），与 ① 单货物多起点同量级。
 * 顺序上**先 x 后 y**：完全打平时保留历史切法的结果，不做无收益的放置变化。
 */
const SPACE_TAIL_AXES: readonly SpaceTailAxis[] = ['x', 'y'];

/* ───────────────────── 候选表是怎么选出来的（⑬~⑮ 的来历）───────────────────── */

/**
 * ## 起因：一次"我说错了"的纠正
 *
 * 用户问「多货物混装能不能把利用率最大化」。我先手工试了 8 组参数
 * （足迹 0.3/0.5/0.75/0.9、体积上限 0.35/0.9、前瞻 1.4/1.8…），
 * 结论是「现有 12 条腿已够，没有值得追加的维度」。
 *
 * **那个结论是错的**，错在**取样偏差**：那 8 组恰好都挨着现有腿，
 * 天然打不赢。改成每场景随机撒 500 组（1000 次尝试）后，
 * 8 个场景里 **6 个**能被超过，平均 +3.35 点、最大 +6.42 点。
 *
 * ## 真正的缺口不是"升序排序"，是 β 的中间档
 *
 * 随机搜索里 `residualWeight=0.3`（残余前瞻强度）反复出现在最优参数中，
 * 而**原表只有 β=0 与 β=0.9 两档，中间是空的**：
 * β=0 完全不看残余，β=0.9 又过度看重残余而牺牲当次装入量。
 *
 * 我曾猜缺口是「小件优先的升序排序」（12 条腿全是降序，从没试过升序）——
 * **数据否掉了这个猜测**：全网格 144 组里没有任何一条升序腿进入最终名单，
 * 胜出者全是已有的 VOL_DESC / QTY_DESC。混装的收益来自**前瞻强度**，
 * 不是来自**谁先走**。
 *
 * ## 选腿方法：贪心集合覆盖
 *
 * `load()` 在全部候选腿里按 max(种类数 → 装载率) 择优，
 * 所以**新增腿只可能让结果变好或持平，不可能变差**
 * （实测「最差 0.00 点、种类数从未下降」印证）。
 * 于是问题不是"怎么别回归"，而是"用**最少**的腿吃掉**最多**的可达空间"。
 *
 * 网格：4 种排序 × 块上限{0, 0.5, 0.75} × 足迹{0, 0.75} × 整洁{Y,N} × β{0, 0.3, 0.9} = 144 组
 * 场景：22 个（含 5 个**代码/测试里记录在案的回归场景**，
 *       如水泵基准 966/95.96%、三货物含大扁平件 C 的 40HQ/20ft）
 *
 * 全部 144 组都加上的总可达空间 = **19.45 点**（分布在 9 个场景）。
 * 贪心每轮挑"吃掉剩余空间最多"的那条：
 *
 * | 轮次 | 边际收益 | 累计占比 | 该腿 |
 * |---|---|---|---|
 * | 1 | +6.32 | 32% | 体积降序 无上限 无足迹上限 整洁 β=0 |
 * | 2 | +5.40 | 60% | 体积降序 块.75 足迹.75 **β=0.3** |
 * | 3 | +3.01 | 76% | 体积降序 无上限 **β=0.3** |
 * | 4 | +1.61 | 84% | 箱数降序 无块上限 足迹.75 β=0.9 |
 * | 5 | +1.45 | 91% | 体积降序 块.5 无足迹上限 **β=0.3** |
 * | 6 | +0.88 | 96% | 体积降序 块.5 足迹.75 整洁 **β=0.3** |
 * | 7 | +0.42 | 98% | （收益已明显递减） |
 * | 8~10 | +0.15/+0.12/+0.09 | 100% | （+0.1 点的量级，判为调参噪声，不采纳） |
 *
 * **只取前 6 条**：覆盖 96% 的可达空间，每条都值 ≥0.88 点；
 * 第 7 条之后进入调参噪声区，为省 CPU 不加。
 *
 * ## 采纳后的实测结果（22 个场景）
 *
 * - 提升 **14/22**，持平 8，**下降 0**
 * - 平均 **+0.88 点**，最大 **+4.93 点**（六种货物场景 85.90% → 90.83%）
 * - 水泵基准 **95.96% 逐位不变**（新腿在它上面没有任何收益，也不拖累它）
 * - 三个"记录在案的回归场景"全部提升或持平：+0.97 / +0.56 / +0.39 / 0.00
 *
 * ## 一个必须说清的限制
 *
 * 这六条腿是**在这 22 个场景上**选出来的，存在过拟合可能。
 * 但风险是**有界的**：由于择优取最大值，即使某条腿在新场景上毫无价值，
 * 它也只是白烧 3ms CPU，**不会让结果变差**。
 * 换句话说：最坏情况是浪费一点时间，不会浪费装柜单。
 */

/**
 * 把结果里的"装入种类"拆成**点名要的**与**留空填充的**两笔账
 *
 * ## 为什么要拆
 *
 * 「种类数是硬约束」的初衷（见 `load()` 的注释）是：**一份把某个品项整个漏掉的
 * 装柜单，即使装载率更高也是废单**。这对用户**填了数量**的货物完全成立。
 *
 * 但对「数量留空 = 不限」的那种货物不成立 —— 它装 0 箱并不是"漏掉"，
 * 而是说明**前面点名的货物把柜子装得更满了**（缝隙都塞不下它）。
 * 实测 40HQ + 水泵2=630 + 水泵3=336 + 水泵4 留空，逐腿诊断：
 *
 * ```
 * 腿8  WP20=630  WP30=336  WP40=  0   95.96%   ← 两个承诺全装满
 * 腿3  WP20=630  WP30=254  WP40= 21   87.83%   ← 为了塞进 21 箱填充货，牺牲了 82 箱承诺货
 * ```
 *
 * 按旧口径腿3 因"种类=3 > 2"胜出，于是水泵3 被压到 254 —— 用户填的 336 又没被当回事。
 * 拆分后：点名的货物 0 箱仍然算失败（hard），填充货物的 0 箱只用于**同分时的末位比较**。
 */
function kindsSplit(r: PackResult, boundedIds: ReadonlySet<string>): { hard: number; soft: number } {
  let hard = 0;
  let soft = 0;
  const seen = new Set<string>();
  for (const p of r.placements) {
    if (p.count <= 0 || seen.has(p.boxId)) {
      continue;
    }
    seen.add(p.boxId);
    if (boundedIds.has(p.boxId)) {
      hard++;
    } else {
      soft++;
    }
  }
  return { hard, soft };
}

/** 择优分数 = 装入种类数（硬/软）+ 装载率（口径见 load() 的说明） */
function scoreOfResult(r: PackResult, boundedIds: Set<string>): { hard: number; soft: number; rate: number } {
  const k = kindsSplit(r, boundedIds);
  return { hard: k.hard, soft: k.soft, rate: r.loadRate };
}

/** a 是否优于 b（字典序：硬种类数 → 装载率 → 软种类数；「全留空」时软种类数并入硬） */
function isBetterResult(
  a: { hard: number; soft: number; rate: number },
  b: { hard: number; soft: number; rate: number },
  kindsAsHard: boolean,
): boolean {
  const aHard = kindsAsHard ? a.hard + a.soft : a.hard;
  const bHard = kindsAsHard ? b.hard + b.soft : b.hard;
  if (aHard !== bHard) {
    return aHard > bHard;
  }
  // 用相对比较避免浮点误差导致来回抖动
  if (Math.abs(a.rate - b.rate) > 1e-9) {
    return a.rate > b.rate;
  }
  return a.soft > b.soft;
}

/**
 * 单策略主调度：输入货物列表 + 柜型 + **一个具体策略**，输出 PackResult
 *
 * 多货物时按候选配置**多起点**跑贪心，按下列**字典序**择优：
 *   ① 装入的货物种类数多者优（硬约束，见下）
 *   ② 装载率高者优
 *
 * ## 为什么种类数是硬约束
 * 只按装载率挑选会选中"装载率高但把某个货物整个饿死"的结果 ——
 * 实测加「无上限」配置后，40HQ 三货物装载率从 90.3% 涨到 92.8%，
 * 但种类数从 **18/18 掉到 13/18**（整个货物一件没装上）。
 * **一份把某个品项整个漏掉的装柜单，即使装载率更高也是废单**：
 * 现场要的是"每种货都要上车"，剩余量只是次要指标（会显示在未装清单里）。
 * 这与 P0-d「先到者不许吃满整柜」的初衷一致，多起点不能把它破坏掉。
 *
 * ## 硬约束只对「用户点名要的货物」生效
 *
 * 「数量留空 = 不限」的货物装 0 箱不是漏掉，而是说明前面装得更满。
 * 若把填充货物也算进硬约束，就会出现"为了让填充货拿到 1 箱而牺牲承诺货"的
 * 倒挂（实测水泵3 被从 336 压到 254）。故择优口径为：
 *
 * | 场景 | 硬约束 | 比较顺序 |
 * |---|---|---|
 * | 全部填数量 | 全部种类（旧口径，**逐位不变**） | 种类数 → 装载率 |
 * | 全部留空 | 全部种类（旧口径，**逐位不变**） | 种类数 → 装载率 |
 * | 有填有留 | 仅填了数量的那些 | 点名种类数 → 装载率 → 填充种类数 |
 *
 * 前两种是本次改动**必须保证零行为变化**的场景（966 箱 / 95.96% 的基准就在其中）。
 */
function loadOneStrategy(params: LoadParams): PackResult {
  const active = params.boxes.filter((b) => b.quantity > 0);

  /**
   * 单货物（含无货物）也要多起点 —— 历史行为是直接返回第①条腿
   *
   * ## 为什么"只有一种货物，多起点没用"是错的
   *
   * sortKey 确实无效（`cargo.sort(sortKey)` 对一种货物是恒等）。但 `placeOnce` 里
   * `maxBlockVolumeRatio: multiCargo ? blockRatio : 0`（footprint 同理），
   * 而单货物时 `peers.length === 1` ⇒ `multiCargo = false` ⇒ **两个上限都被强制置 0**。
   * 于是整条腿只剩 `(preferCleanResidual, residualWeight)` 起作用 —— 这两组偏偏是有用的。
   *
   * 实测（策略 3，跑遍候选表 vs 只跑①）：
   * | 场景 | ① | 多起点 | 差 |
   * |---|---|---|---|
   * | 40HQ 1200×800×800 ×120 | 58.66% | **71.01%** | **+12.35 点**（57→69 箱）|
   * | 40HQ 600×400×400 ×3000 | 75.64% | **81.81%** | **+6.17 点**（588→636 箱）|
   * | 其余 6 个单货物场景 | — | 持平 | 0.00 |
   *
   * 按 `(preferCleanResidual, residualWeight)` **去重**后 18 条腿只对应 5 种组合，
   * 所以多跑 4 次贪心即可覆盖（每次约 1~5ms）。
   *
   * ## 为什么直接比装载率（而不是像多货物那样先比种类数）
   *
   * 只有一种货物 ⇒ `kindsSplit` 的 hard 非 0 即 1，退化为"有没有装上"；
   * 而单货物下**装得越多装载率越高**（同一种箱），两个目标不冲突。
   * 两条锁死箱数的测试（20ft 装 580×380×320 = 432、200³ = 957）实测逐位不变。
   */
  if (active.length <= 1) {
    let best: PackResult | null = null;
    for (const axis of SPACE_TAIL_AXES) {
      const tried = new Set<string>();
      for (const c of CARGO_CONFIGS) {
        const key = `${c.preferCleanResidual}|${c.residualWeight}`;
        if (tried.has(key)) {
          continue;
        }
        tried.add(key);
        const r = runGreedy(params, c.sortKey, c.blockRatio, c.footprintRatio, c.preferCleanResidual, c.residualWeight, axis);
        if (best === null || r.loadRate > best.loadRate + 1e-9) {
          best = r;
        }
      }
    }
    return best!;
  }
  // 用户点名了要装的货物（填了数量）→ 只有它们算"漏掉即废单"
  const boundedIds = new Set(active.filter((b) => b.unlimited !== true).map((b) => b.id));
  // 一个都没点名（全留空）时退回旧口径：此时"种类数"本身就是硬约束
  const kindsAsHard = boundedIds.size === 0;

  let best: PackResult | null = null;
  let bestScore: { hard: number; soft: number; rate: number } | null = null;
  // 先跑 x（历史切法）再跑 y：打平时保留历史结果，避免无收益的放置变化
  for (const axis of SPACE_TAIL_AXES) {
    for (const c of CARGO_CONFIGS) {
      const r = runGreedy(params, c.sortKey, c.blockRatio, c.footprintRatio, c.preferCleanResidual, c.residualWeight, axis);
      const score = scoreOfResult(r, boundedIds);
      if (best === null || isBetterResult(score, bestScore!, kindsAsHard)) {
        best = r;
        bestScore = score;
      }
    }
  }
  return best!;
}

/**
 * 单柜主调度 load()
 *
 * 策略取 `STRATEGY_AUTO`（-1）时，依次跑 0~5 全部策略，按上面那套择优口径取最好的一次。
 * 返回值里的 `strategy` 是**实际胜出**的那个策略号 —— 报表与实测案例据此显示，
 * 所以输出里不会留下 -1 这种用户看不懂的值。
 *
 * ## 为什么是「可选项」而不是默认
 *
 * 实测 22 个多货物场景，自动择优相对固定策略 3 **平均只高 0.37 点**
 * （夺冠次数 S0..S5 = 5/2/0/13/1/1，策略 2 从未夺冠），代价是**跑 6 遍**。
 * 更要紧的是策略是用户**有意挑的**：有的场景就是要「承托分级分层」（策略 4）
 * 来保证物理可摆放，这时装载率更高的策略反而不能用。
 * 所以默认仍是用户所选策略，自动择优必须显式打开。
 */
export function load(params: LoadParams): PackResult {
  if ((params.strategy ?? 3) !== STRATEGY_AUTO) {
    return loadOneStrategy(params);
  }
  const active = params.boxes.filter((b) => b.quantity > 0);
  const boundedIds = new Set(active.filter((b) => b.unlimited !== true).map((b) => b.id));
  const kindsAsHard = boundedIds.size === 0;
  let best: PackResult | null = null;
  let bestScore: { hard: number; soft: number; rate: number } | null = null;
  for (const s of ALL_STRATEGIES) {
    const r = loadOneStrategy({ ...params, strategy: s });
    const score = scoreOfResult(r, boundedIds);
    if (best === null || isBetterResult(score, bestScore!, kindsAsHard)) {
      best = r;
      bestScore = score;
    }
  }
  return best!;
}

/** 按货物 ID 统计箱数 */
export function countByBox(result: PackResult): Map<string, number> {
  const map = new Map<string, number>();
  for (const p of result.placements) {
    map.set(p.boxId, (map.get(p.boxId) ?? 0) + p.count);
  }
  return map;
}

/** 方向枚举数量（透传常量） */
export const DIRECTION_COUNT = ORIENTATION_COUNT;

/* ───────────────────────── 多柜自动装载 ───────────────────────── */

export interface MultiLoadParams {
  /** 货物列表（quantity 为可用数量） */
  boxes: Box[];
  /** 柜型（同柜型循环装载） */
  container: Container;
  /** 候选块策略 0..5（默认 3） */
  strategy?: number;
  /** 计算高级设置 */
  options?: LoadOptions;
  /** 连续空装 N 柜后停止（默认 3） */
  maxEmptyRounds?: number;
}

/**
 * 顺序装满（历史行为，作为保底）：装满一柜 → 扣减剩余 → 再开一柜
 *
 * 缺陷：末柜常常几乎是空的（实测"三货物大规模"12 柜、末柜 5.1%），
 * 因为它是"把前面每一柜都装到极限"的副作用。planMultiContainer 拿它做保底，
 * 再尝试用「均衡分柜」换更少的柜数。
 *
 * 导出仅供**测试与诊断**比对"柜数只减不增"这条性质（同 runGreedy 的导出理由）。
 */
export function greedyMultiContainer(
  boxes: Box[],
  container: Container,
  strategy: number,
  options: LoadOptions | undefined,
  maxEmptyRounds: number,
): MultiPlanResult {
  const remaining: Array<{ box: Box; qty: number }> = boxes
    .filter((b) => b.quantity > 0)
    .map((b) => ({ box: b, qty: b.quantity }));

  const plans: PackResult[] = [];
  const singleVolume = containerVolume(container);

  let emptyRounds = 0;
  while (remaining.length > 0 && emptyRounds < maxEmptyRounds) {
    const current = remaining.map((r) => ({ ...r.box, quantity: r.qty }));
    const result = load({ boxes: current, container, strategy, options });
    const placedCount = result.placements.reduce((s, p) => s + p.count, 0);
    if (placedCount === 0) {
      // 连续空装：本柜一件未装入，剩余不变，计数递增
      emptyRounds++;
      continue;
    }
    emptyRounds = 0;
    plans.push(result);

    // 更新剩余：扣除本柜装入数
    const placedMap = new Map<string, number>();
    for (const p of result.placements) {
      placedMap.set(p.boxId, (placedMap.get(p.boxId) ?? 0) + p.count);
    }
    for (const r of remaining) {
      r.qty = Math.max(0, r.qty - (placedMap.get(r.box.id) ?? 0));
    }
    for (let i = remaining.length - 1; i >= 0; i--) {
      if (remaining[i].qty <= 0) {
        remaining.splice(i, 1);
      }
    }
  }

  const totalLoadedVolume = plans.reduce((s, p) => s + p.usedVolume, 0);
  const totalContainerVolume = plans.length * singleVolume;
  const overallRate = totalContainerVolume > 0 ? totalLoadedVolume / totalContainerVolume : 0;

  return {
    plans,
    totalContainers: plans.length,
    totalLoadedVolume,
    totalContainerVolume,
    overallRate,
    remaining: remaining.map((r) => ({ boxId: r.box.id, qty: r.qty })),
  };
}

/** 「货物 × 数量」的一张分配单 */
interface BoxQty {
  box: Box;
  qty: number;
}

/**
 * 把货物按**体积 LPT** 均分到 n 个柜：每件分给当前累计体积最小的柜
 *
 * 大件先分（单件体积降序）⇒ 均衡效果更好，这就是 LPT（longest processing time）
 * 的经典写法。同一货物内部件件相同，故等价于在"当前最空的柜"之间轮转。
 * 这是**只看体积、不看几何**的粗分配 —— 能否真装下由后面的可行性判定说了算。
 */
function balanceByVolume(boxes: Box[], n: number): BoxQty[][] {
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const acc = new Array<number>(n).fill(0);
  const buckets: Array<Map<string, number>> = Array.from({ length: n }, () => new Map());
  const units: Box[] = [];
  for (const b of boxes) {
    for (let i = 0; i < b.quantity; i++) {
      units.push(b);
    }
  }
  units.sort((x, y) => boxVolume(y) - boxVolume(x));
  for (const b of units) {
    let k = 0;
    for (let i = 1; i < n; i++) {
      if (acc[i] < acc[k]) {
        k = i;
      }
    }
    acc[k] += boxVolume(b);
    const m = buckets[k];
    m.set(b.id, (m.get(b.id) ?? 0) + 1);
  }
  return buckets.map((m) => [...m.entries()].map(([id, qty]) => ({ box: byId.get(id)!, qty })));
}

/**
 * 装一柜，取**装得最多**的那条腿
 *
 * 与 `load()` 口径不同：`load()` 按 (种类数 → 装载率) 择优，因为"漏掉一个品项"是废单。
 * 但多柜可行性判定要的是**装下的件数最多** —— 否则某条腿少装两件就会被误判成"柜数不够"。
 */
function fillContainerMax(
  boxes: Box[],
  container: Container,
  strategy: number,
  options: LoadOptions | undefined,
): PackResult {
  let best: PackResult | null = null;
  let bestCount = -1;
  let bestKinds = -1;
  // 自动策略：和 load() 一样跑遍 0~5（这里按「装得最多」择优，见上面的口径说明）
  const strategies: readonly number[] = strategy === STRATEGY_AUTO ? ALL_STRATEGIES : [strategy];
  for (const s of strategies) {
    const params = { boxes, container, strategy: s, options };
    for (const axis of SPACE_TAIL_AXES) {
      for (const c of CARGO_CONFIGS) {
        const r = runGreedy(params, c.sortKey, c.blockRatio, c.footprintRatio, c.preferCleanResidual, c.residualWeight, axis);
        const count = r.placements.reduce((sum, p) => sum + p.count, 0);
        const kinds = new Set(r.placements.filter((p) => p.count > 0).map((p) => p.boxId)).size;
        if (count > bestCount || (count === bestCount && kinds > bestKinds)
          || (count === bestCount && kinds === bestKinds && best !== null && r.loadRate > best.loadRate + 1e-9)) {
          best = r;
          bestCount = count;
          bestKinds = kinds;
        }
      }
    }
  }
  return best!;
}

/**
 * 试「均衡分柜到 n 个柜」是否装得完：全部装完返回各柜结果，任一柜装不完返回 null
 *
 * 这是**可行性判定**，不是优化 —— 装不完就说明 n 个柜不够，往上加柜。
 */
function tryBalancedContainers(
  boxes: Box[],
  container: Container,
  strategy: number,
  options: LoadOptions | undefined,
  n: number,
): PackResult[] | null {
  const plans: PackResult[] = [];
  for (const bucket of balanceByVolume(boxes, n)) {
    if (bucket.length === 0) {
      continue;
    }
    const want = bucket.reduce((s, x) => s + x.qty, 0);
    const r = fillContainerMax(bucket.map((x) => ({ ...x.box, quantity: x.qty })), container, strategy, options);
    const got = r.placements.reduce((s, p) => s + p.count, 0);
    if (got < want) {
      return null;
    }
    plans.push(r);
  }
  return plans.length > 0 ? plans : null;
}

/** 由各柜结果汇总出 MultiPlanResult（均衡分柜成功时全部货都已装完，故 remaining 为空） */
function summarizePlans(plans: PackResult[], singleVolume: number): MultiPlanResult {
  const totalLoadedVolume = plans.reduce((s, p) => s + p.usedVolume, 0);
  const totalContainerVolume = plans.length * singleVolume;
  return {
    plans,
    totalContainers: plans.length,
    totalLoadedVolume,
    totalContainerVolume,
    overallRate: totalContainerVolume > 0 ? totalLoadedVolume / totalContainerVolume : 0,
    remaining: [],
  };
}

/**
 * 多柜自动装载调度：同柜型循环装载
 *
 * ## 两种排法，取柜数少者
 *
 * ① **顺序装满**（历史行为）：装满一柜 → 扣减剩余 → 再开一柜。
 *    末柜常常几乎是空的 —— 实测"三货物大规模"12 柜、**末柜只有 5.1%**。
 * ② **均衡分柜**：先把每种货按体积 LPT 均分到 N 个柜，再逐柜装。
 *    只要 N 个柜都能把分配到的货装完，就说明 **N 柜够用**。
 *    从**体积下限** `ceil(需求体积 / 柜容)` 起向上试，取最小的可行 N。
 *
 * ## 为什么是「追加」而不是「替换」
 *
 * 只有 ② 成功**且柜数更少**时才采用它，否则原样返回 ①。
 * 所以柜数只可能持平或减少，"货必须装完"这条也不会被破坏
 * （② 的可行性判定就是"每柜分配到的货全部装上"）。
 *
 * ## 实测（10 个批量场景，策略 3）
 *
 * | 场景 | 体积下限 | 顺序装满 | 均衡分柜 | 末柜装载率(顺序) |
 * |---|---|---|---|---|
 * | 两货物中等规模 | 5 | 6 | **5** | 12.4% |
 * | 其余 9 个 | — | = 下限 或 下限+1/+2 | 省不下 | 2.3% ~ 70.5% |
 *
 * 注意"单向货 600×400×400 ×5000"原来 9 柜、现在 8 柜 —— 那一柜是
 * **①（单货物多起点）** 带来的，不是 ③；③ 只在"两货物中等规模"上另外省了 1 柜。
 * 也就是说 ① 已经吃掉了 ③ 的大部分收益，③ 的增量很小但方向正确（只赚不赔）。
 */
export function planMultiContainer(params: MultiLoadParams): MultiPlanResult {
  const { boxes, container, strategy = 3, options, maxEmptyRounds = 3 } = params;
  const greedy = greedyMultiContainer(boxes, container, strategy, options, maxEmptyRounds);

  // 体积下限：即使每柜装到 100% 也至少需要这么多柜，低于它不必试
  const singleVolume = containerVolume(container);
  const demandVolume = boxes.reduce((s, b) => s + (b.quantity > 0 ? boxVolume(b) * b.quantity : 0), 0);
  const lowerBound = Math.max(1, Math.ceil(demandVolume / singleVolume - 1e-9));

  for (let n = lowerBound; n < greedy.totalContainers; n++) {
    const plans = tryBalancedContainers(boxes, container, strategy, options, n);
    if (plans) {
      return summarizePlans(plans, singleVolume);
    }
  }
  return greedy;
}