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
import { SpaceManager } from './space-manager.js';
import { checkConstraints } from './constraints.js';
import { solveVolumeMix } from './simplex.js';
import { summarizeLayers } from './expand.js';
import { boxVolume, containerVolume, generateCandidateBlock, resolveOrientationPolicy, MULTI_CARGO_FOOTPRINT_RATIO } from './candidate-blocks.js';

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
 */
export function runGreedy(
  params: LoadParams,
  sortKey: CargoSortKey,
  blockRatio: number,
  footprintRatio: number,
  preferCleanResidual = false,
  residualWeight = 0,
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

  if (opts.lpEnabled && cargo.length > 1) {
    const mix = solveVolumeMix(
      cargo.map((c) => boxVolume(c.box)),
      cargo.map((c) => c.remaining),
      cargo.map((c) => c.box.weight),
      containerVol,
      container.weightCapacity,
    );
    if (mix.ok) {
      cargo.forEach((c, i) => {
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
  const pickSpaceFor = (c: CargoState): number => {
    if (cargo.length <= 1) {
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
      const others = cargo.filter((x) => x !== c && x.remaining > 0);
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

  while (spaces.count > 0 && guard < guardLimit) {
    guard++;
    iterations.value++;
    if (iterations.value > opts.maxIterations) {
      break;
    }
    let progressed = false;

    for (const c of cargo) {
      if (c.remaining <= 0 || c.exhausted) {
        continue;
      }
      // 块大小上限只在「仍有货物一件未装」时生效：
      // 先让每种货物都拿到入场券（避免先到者吃满整柜），
      // 一旦所有货物都已参与，就解除限制、自由填充以最大化装载率。
      // 一直限着会导致装载率大幅下降（实测策略1 从 80% 掉到 27%）。
      const needFairness = cargo.some((x) => x.placed === 0 && x.remaining > 0);
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
        pickSpaceFor(c),
        cargo.length > 1 && needFairness,
        blockRatio,
        footprintRatio,
        preferCleanResidual,
        residualWeight,
        // 残余前瞻需要知道"这块之外还有谁没装完"
        cargo.filter((x) => x.remaining > 0).map((x) => x.box),
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
    for (const c of cargo) {
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
];

/** 参与装载的货物种类数（至少装入 1 箱的 boxId 个数） */
function loadedKinds(r: PackResult): number {
  return new Set(r.placements.filter((p) => p.count > 0).map((p) => p.boxId)).size;
}

/**
 * 主调度 load()：输入货物列表 + 柜型 + 策略参数，输出 PackResult
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
 */
export function load(params: LoadParams): PackResult {
  const active = params.boxes.filter((b) => b.quantity > 0);
  const first = CARGO_CONFIGS[0];
  if (active.length <= 1) {
    return runGreedy(params, first.sortKey, first.blockRatio, first.footprintRatio, first.preferCleanResidual, first.residualWeight);
  }
  let best = runGreedy(params, first.sortKey, first.blockRatio, first.footprintRatio, first.preferCleanResidual, first.residualWeight);
  let bestKinds = loadedKinds(best);
  let bestRate = best.loadRate;
  for (let i = 1; i < CARGO_CONFIGS.length; i++) {
    const c = CARGO_CONFIGS[i];
    const r = runGreedy(params, c.sortKey, c.blockRatio, c.footprintRatio, c.preferCleanResidual, c.residualWeight);
    const kinds = loadedKinds(r);
    // ① 种类数优先；② 同等种类数下比装载率（用相对比较避免浮点误差导致来回抖动）
    if (kinds > bestKinds || (kinds === bestKinds && r.loadRate > bestRate + 1e-9)) {
      best = r;
      bestKinds = kinds;
      bestRate = r.loadRate;
    }
  }
  return best;
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
 * 多柜自动装载调度：同柜型循环装载
 * 每次以「剩余货物列表 + 柜型」调用 load() 装一柜，更新剩余数量，
 * 直到全部装完或连续 maxEmptyRounds 柜一件都装不进为止。
 * plans 仅收录至少装入一件的有效柜；remaining 为最终未装完的剩余数量。
 */
export function planMultiContainer(params: MultiLoadParams): MultiPlanResult {
  const { boxes, container, strategy = 3, options, maxEmptyRounds = 3 } = params;
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