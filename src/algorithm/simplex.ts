/**
 * 简单线性规划求解器（单纯形法，替代 lp_solve）
 *
 * 对齐逆向文档 lp_solve 封装层（0x4a512e 求解入口、0x4a866e 模型行构建、
 * 0x4afd28 solve 包装），用于主调度"体积配比/数量分配"阶段。
 *
 * 实现标准单纯形法（单阶段，适用于 A x <= b、b >= 0 的规范型）：
 *   maximize   c^T x
 *   subject to A x <= b
 *              x >= 0
 * 约束矩阵 A（m×n）、右侧 b（m）、目标系数 c（n）。
 * 规范化时若 b_i < 0 则将该行取反（等价变换）。
 *
 * 数值鲁棒性：采用小量 eps 判定基变量与最优性，设置迭代上限防止退化死循环。
 */
export interface SimplexResult {
  ok: boolean;
  /** 目标函数值 */
  value: number;
  /** 原变量解（长度 n） */
  solution: number[];
  /** 迭代次数 */
  iterations: number;
  /** 失败原因（ok=false 时） */
  error?: string;
}

const EPS = 1e-9;
const MAX_ITER = 10000;

/**
 * 求解规范型 LP（最大化）。
 * @param c 目标系数（长度 n）
 * @param A 约束矩阵（m×n），每个约束为 A_i·x <= b_i
 * @param b 右侧向量（长度 m，允许负值，内部自动取反规范化）
 * @returns SimplexResult
 */
export function solveMaximize(c: number[], A: number[][], b: number[]): SimplexResult {
  if (A.length === 0 || c.length === 0) {
    return { ok: false, value: 0, solution: [], iterations: 0, error: 'empty-problem' };
  }
  const m = A.length;
  const n = c.length;
  if (b.length !== m) {
    return { ok: false, value: 0, solution: [], iterations: 0, error: 'dim-mismatch' };
  }
  for (const row of A) {
    if (row.length !== n) {
      return { ok: false, value: 0, solution: [], iterations: 0, error: 'dim-mismatch' };
    }
  }

  // 规范化：右侧 b_i 必须 >= 0（负值行取反，目标不变）
  const AA: number[][] = A.map((row) => [...row]);
  const BB: number[] = [...b];
  for (let i = 0; i < m; i++) {
    if (BB[i] < 0) {
      BB[i] = -BB[i];
      for (let j = 0; j < n; j++) {
        AA[i][j] = -AA[i][j];
      }
    }
  }

  // 表格：[0..m) 约束行，[0..n+m) 变量列（原变量 n + 松弛 m），最后一列为 RHS
  const cols = n + m + 1;
  const table: number[][] = [];
  for (let i = 0; i < m; i++) {
    const row = new Array<number>(cols).fill(0);
    for (let j = 0; j < n; j++) {
      row[j] = AA[i][j];
    }
    row[n + i] = 1; // 松弛变量
    row[cols - 1] = BB[i]; // RHS
    table.push(row);
  }
  // 目标行：z - c^T x = 0，即系数 -c，RHS=0
  const objRow = new Array<number>(cols).fill(0);
  for (let j = 0; j < n; j++) {
    objRow[j] = -c[j];
  }
  table.push(objRow);

  // 初始基变量 = 各松弛变量（n+i）
  const basis: number[] = [];
  for (let i = 0; i < m; i++) {
    basis.push(n + i);
  }

  let iterations = 0;

  for (;;) {
    if (++iterations > MAX_ITER) {
      return { ok: false, value: 0, solution: [], iterations, error: 'iteration-limit' };
    }
    // 进入变量：目标行最负系数
    let enter = -1;
    let minVal = -EPS;
    for (let j = 0; j < cols - 1; j++) {
      if (table[m][j] < minVal) {
        minVal = table[m][j];
        enter = j;
      }
    }
    if (enter === -1) {
      break; // 达到最优
    }
    // 最小比值检验
    let leave = -1;
    let bestRatio = Number.POSITIVE_INFINITY;
    for (let i = 0; i < m; i++) {
      const a = table[i][enter];
      if (a > EPS) {
        const ratio = table[i][cols - 1] / a;
        if (ratio < bestRatio - EPS) {
          bestRatio = ratio;
          leave = i;
        }
      }
    }
    if (leave === -1) {
      return { ok: false, value: 0, solution: [], iterations, error: 'unbounded' };
    }
    // 高斯消元 pivot
    const pivotVal = table[leave][enter];
    for (let j = 0; j < cols; j++) {
      table[leave][j] /= pivotVal;
    }
    for (let i = 0; i <= m; i++) {
      if (i === leave) {
        continue;
      }
      const factor = table[i][enter];
      if (Math.abs(factor) < EPS) {
        continue;
      }
      for (let j = 0; j < cols; j++) {
        table[i][j] -= factor * table[leave][j];
      }
    }
    basis[leave] = enter;
  }

  const solution = new Array<number>(n).fill(0);
  for (let i = 0; i < m; i++) {
    const varIdx = basis[i];
    if (varIdx < n) {
      solution[varIdx] = table[i][cols - 1];
    }
  }
  const value = table[m][cols - 1];
  return { ok: true, value, solution, iterations };
}

/**
 * 便捷封装：体积配比求解（对应原程序 lp 配比阶段 0x4a512e，语义近似，TODO/UNCERTAIN）。
 * 给定每种货物的单位体积 v_i、数量上限 u_i、单位重量 w_i、柜内容积 V、载重 W，
 * 在 体积/重量/数量上限 三重约束下最大化装入总体积（线性近似）。
 */
export function solveVolumeMix(volumes: number[], maxCounts: number[], weights: number[], capacityVolume: number, capacityWeight: number): SimplexResult {
  const n = volumes.length;
  const c = [...volumes];
  const A: number[][] = [];
  const b: number[] = [];
  A.push([...volumes]);
  b.push(capacityVolume);
  if (weights.length === n) {
    A.push([...weights]);
    b.push(capacityWeight);
  }
  for (let j = 0; j < n; j++) {
    const row = new Array<number>(n).fill(0);
    row[j] = 1;
    A.push(row);
    b.push(maxCounts[j]);
  }
  return solveMaximize(c, A, b);
}
