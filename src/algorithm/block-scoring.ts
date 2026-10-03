/**
 * 块评分（对齐逆向 0x4c2f44）
 *
 * 评分公式：4 个子块体积之和，选最大者。
 * 候选块 0x44 字节 = 4 子块 {x,y,z,flag}（0x10/子块）+ 件数，评分即各子块 x*y*z 累计。
 * 子块不足 4 个时以实际子块计数（原程序固定 4 槽位，空槽尺寸为 0，体积贡献为 0）。
 */
import type { CandidateBlock } from '../types/index.js';

/** 计算候选块评分（子块体积和） */
export function scoreBlock(block: CandidateBlock): number {
  let volume = 0;
  for (const sb of block.subBlocks) {
    volume += sb.x * sb.y * sb.z;
  }
  return volume;
}

/** 计算候选块总体积（与 scoreBlock 等价，别名供调用方语义化使用） */
export function blockVolume(block: CandidateBlock): number {
  return scoreBlock(block);
}

/** 计算候选块总重量 */
export function blockWeight(block: CandidateBlock, unitWeight: number): number {
  return unitWeight * block.pieceCount;
}

/** 在候选块列表中挑选评分最高者（评分相同取先出现的） */
export function pickBestBlock(blocks: CandidateBlock[]): CandidateBlock | null {
  let best: CandidateBlock | null = null;
  let bestScore = -1;
  for (const b of blocks) {
    const s = scoreBlock(b);
    if (s > bestScore) {
      bestScore = s;
      best = b;
    }
  }
  return best;
}
