/**
 * 空间块管理 / 剩余空间切分（对齐逆向 0x4c6f9d 与空间列表容器）
 *
 * 原程序空间列表容器：+4 数据指针 / +8 count / +0xc capacity；
 * 扩容策略：newCapacity = count/8 + 4，下限 4，上限 0x400（1024）。
 * 空间块 0x20 字节/块（位置 + 尺寸）。
 *
 * 剩余空间三分割细节（方向顺序）未能完全还原，本实现采用
 * 常见 FillSpace 三分：先切 z 向顶部空间，再切 y 向侧边空间，最后切 x 向尾端空间；
 * 顺序标记 TODO/UNCERTAIN。
 */
import type { CandidateBlock, Placement, SpaceBlock } from '../types/index.js';

export const SPACE_SLOT_BYTES = 0x20;
export const SPACE_CAPACITY_MIN = 4;
export const SPACE_CAPACITY_MAX = 0x400;

export class SpaceManager {
  private list: SpaceBlock[] = [];
  private capacity: number;

  constructor(initialCapacity = SPACE_CAPACITY_MIN) {
    this.capacity = Math.max(SPACE_CAPACITY_MIN, initialCapacity);
  }

  get count(): number {
    return this.list.length;
  }

  get capacitySize(): number {
    return this.capacity;
  }

  /** 扩容策略：count/8 + 4，下限 4，上限 0x400 */
  private ensureCapacity(need: number): void {
    if (need <= this.capacity) {
      return;
    }
    let newCap = Math.floor(this.count / 8) + 4;
    if (newCap < SPACE_CAPACITY_MIN) {
      newCap = SPACE_CAPACITY_MIN;
    }
    while (newCap < need && newCap < SPACE_CAPACITY_MAX) {
      newCap = Math.floor(newCap / 8) + 4 > newCap ? newCap + 4 : newCap * 2;
      newCap = Math.min(newCap, SPACE_CAPACITY_MAX);
    }
    this.capacity = Math.min(newCap, SPACE_CAPACITY_MAX);
    if (this.capacity < need) {
      // 上限保护：超过 0x400 直接按需求分配（原程序此处可能报 OOM，TODO/UNCERTAIN）
      this.capacity = need;
    }
  }

  /** 添加空间（去重：完全相同空间跳过） */
  add(space: SpaceBlock): void {
    if (space.dx <= 0 || space.dy <= 0 || space.dz <= 0) {
      return;
    }
    if (this.list.some((s) => s.x === space.x && s.y === space.y && s.z === space.z && s.dx === space.dx && s.dy === space.dy && s.dz === space.dz)) {
      return;
    }
    this.ensureCapacity(this.list.length + 1);
    this.list.push(space);
  }

  /** 读取第 i 个空间 */
  get(index: number): SpaceBlock | undefined {
    return this.list[index];
  }

  /** 移除第 i 个空间 */
  removeAt(index: number): void {
    this.list.splice(index, 1);
  }

  /** 当前全部空间（拷贝） */
  all(): SpaceBlock[] {
    return [...this.list];
  }

  /** 清空 */
  clear(): void {
    this.list = [];
  }

  /**
   * 剩余空间切分：在 space 内放置 block（原点 bx,by,bz，尺寸 bdx,bdy,bdz），
   * 返回切出的剩余空间列表（互不重叠、均不超出 space）。
   *
   * 切分模型（非重叠 + 承托可行）：
   *   1) 块正上方：仅覆盖块自身 xy 足迹 → 该区域内任何块都被下方块 100% 承托；
   *   2) x 方向尾端条带：整高（沿 y 铺满 space 宽度）；
   *   3) y 方向侧边条带：整高，x 仅到块右边界（与 2 在 x=bx+bdx 处相接不重叠）。
   *
   * 修复：原实现把顶部空间开成 space.dx × space.dy 全宽（z 仅到块顶），
   * 导致后续落在该空间的块底面远大于下方块足迹，底部承托比例恒 < 1，
   * 承托约束一旦真正生效就会把混合货物全部判为不可装。
   *
   * @param baseBoxId 放置该块的货物 id：切出的「正上方」残余会带上它，
   *   让调度层能识别"这个空间压在谁的头上"，从而避免跨货物交错堆叠
   *   （见 load.ts 的 pickSpaceFor）。侧边/尾端条带底部落在柜底，不带标记。
   * TODO/UNCERTAIN：原程序 0x4c6f9d 的切分方向顺序与是否保整高未完全还原。
   */
  split(
    space: SpaceBlock,
    block: Pick<CandidateBlock | Placement, 'x' | 'y' | 'z'> & { dims?: readonly [number, number, number] },
    baseBoxId?: string,
  ): SpaceBlock[] {
    const bdx = 'dims' in block && block.dims ? block.dims[0] : 0;
    const bdy = 'dims' in block && block.dims ? block.dims[1] : 0;
    const bdz = 'dims' in block && block.dims ? block.dims[2] : 0;
    // CandidateBlock 无 dims 字段时按子块包围盒计算
    let cdx = bdx;
    let cdy = bdy;
    let cdz = bdz;
    if (!('dims' in block) || !block.dims) {
      const candidate = block as CandidateBlock;
      if (candidate.subBlocks && candidate.subBlocks.length > 0) {
        cdx = Math.max(...candidate.subBlocks.map((sb) => sb.x));
        cdy = Math.max(...candidate.subBlocks.map((sb) => sb.y));
        cdz = Math.max(...candidate.subBlocks.map((sb) => sb.z));
      }
    }
    const bx = block.x;
    const by = block.y;
    const bz = block.z;
    const sx = space.x;
    const sy = space.y;
    const sz = space.z;
    const result: SpaceBlock[] = [];

    // 1) 块正上方剩余：仅覆盖块自身 xy 足迹，保证 100% 承托
    //    标记下方块的归属货物，供调度层识别"压在谁头上"
    const topDz = sz + space.dz - (bz + cdz);
    if (topDz > 0) {
      result.push({ x: bx, y: by, z: bz + cdz, dx: cdx, dy: cdy, dz: topDz, baseBoxId });
    }
    // 2) x 方向尾端条带：整高，y 铺满 space 宽度
    const tailDx = sx + space.dx - (bx + cdx);
    if (tailDx > 0) {
      result.push({ x: bx + cdx, y: sy, z: sz, dx: tailDx, dy: space.dy, dz: space.dz });
    }
    // 3) y 方向侧边条带：整高，x 仅到块右边界（与 2 相接不重叠）
    const sideDy = sy + space.dy - (by + cdy);
    if (sideDy > 0) {
      result.push({ x: sx, y: by + cdy, z: sz, dx: cdx, dy: sideDy, dz: space.dz });
    }
    return result;
  }
}
