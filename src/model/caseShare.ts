/**
 * 实测案例的对外分享文本
 *
 * ## 为什么要分两档
 *
 * 案例里混着隐私成分差别很大的字段。想让用户**主动**提供算法偏差数据，
 * 又不能替他决定暴露多少，所以按"暴露什么"分成两档，由他点哪个按钮决定：
 *
 * | 档位 | 含货物清单？ | 含货物名称？ |
 * |---|---|---|
 * | 偏差摘要 | 否 | 否 |
 * | 完整案例 | 是（尺寸/重量/摆放限制全保留） | 否，全部替换为序号 |
 *
 * 分界线是**"有没有货物清单"**，而不是"有没有字符串"——
 * 因为尺寸才是算法改进的原料，只给箱数我没法复现。
 *
 * ## 脱敏的具体做法
 *
 * **不输出** `name` / `sku` / `batch` / `groupName` / `unitPrice` / `description`
 * 任何一个字段，货物一律用 `#1` `#2` 序号指代。
 *
 * 刻意**连 `id` 也不输出**：虽然当前表单不给改 id，但保不准哪天允许改了、
 * 或者有人拿名称当 id 存（测试夹具里就是 `水泵2` 这种）。
 * 少一个字段就少一处泄露可能，不差这点可读性。
 *
 * 保留的是算法真正吃进去的东西：尺寸、重量、件数、堆码级别、六向允许摆放、
 * 六向承托级别、承托比例、承托面、最大堆放数、**型变系数/公差**（软包装压缩，
 * 恰恰是现场装不到的最常见原因）。
 *
 * ## 关于"案例名"和"备注"
 *
 * 这两个字段**是用户自己写的**，两档都原样带上（备注是"为什么有偏差"的关键信息）。
 * 但它们**可能**含客户信息，所以由用户自己看到、自己决定发不发 ——
 * 界面上如实说明这一点，不假装"完全无业务信息"。
 *
 * ## 纯函数
 *
 * 本文件不碰剪贴板、不碰 DOM、不读环境。`meta` 由调用方注入，
 * 所以时间与版本号在测试里是确定的，输出可以逐字断言。
 */
import { STRATEGY_NAMES } from '../algorithm/candidate-blocks.js';
import { analyzeCase, type LoadCase } from './case.js';

export interface ShareMeta {
  appVersion: string;
  /** ISO 时间戳 */
  at: string;
}

/** 分隔线用 ASCII —— 制表符/制表线字符在微信、Excel、部分输入法里会被改写 */
const RULE = '------------------------------';

// ---------------------------------------------------------------------------
// 数值格式
// ---------------------------------------------------------------------------

/** 体积：入参 mm³，出参按量级选单位（算法内部一律 mm³，写出来要人能读） */
export function volumeText(mm3: number | undefined): string {
  if (mm3 === undefined || !Number.isFinite(mm3)) return '（未知）';
  if (Math.abs(mm3) >= 1e9) return `${(mm3 / 1e9).toFixed(2)} m³`;
  if (Math.abs(mm3) >= 1e6) return `${(mm3 / 1e6).toFixed(2)} L`;
  return `${Math.round(mm3)} mm³`;
}

/** 重量：超过半吨用吨，读起来更快 */
export function weightText(kg: number | undefined): string {
  if (kg === undefined || !Number.isFinite(kg)) return '（未知）';
  if (Math.abs(kg) >= 1000) return `${(kg / 1000).toFixed(2)} 吨`;
  return `${Math.round(kg * 10) / 10} kg`;
}

/** 装载率等百分比，入参已是 0~1 */
export function pctText(v: number | undefined, digits = 2): string {
  if (v === undefined || !Number.isFinite(v)) return '（未知）';
  return `${(v * 100).toFixed(digits)}%`;
}

function strategyText(n: number): string {
  return `${n} ${STRATEGY_NAMES[n] ?? '（未知策略）'}`;
}

/** 六向布尔数组 → `是/是/否/否/否/否`；未设置视为不限 */
function flagsText(a: readonly boolean[] | undefined): string {
  if (!a || a.length === 0) return '不限';
  return a.map((x) => (x ? '是' : '否')).join('/');
}

/** 六向数值数组 → 紧凑形式；全为 0 时返回"不限"（0 = 不限） */
function sixText(a: readonly number[] | undefined): string {
  if (!a || a.length === 0) return '未设置';
  if (a.every((x) => !x)) return '不限';
  return a.join('/');
}

/** 偏差的带符号写法 */
function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

/** 保留两位小数（去掉 7.300000000000001 这种浮点尾巴） */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// 偏差摘要（无货物清单）
// ---------------------------------------------------------------------------

/** 摘要里用得到的一行"算出 vs 实际 vs 偏差"，单条与批量共用，避免两处写法漂移 */
function deltaLines(c: LoadCase): string[] {
  const d = analyzeCase(c);
  const out: string[] = [];
  const computed = `${d.computedPieces} 箱 / ${d.computedContainers} 柜`;
  const actualBits: string[] = [];
  if (c.actual.pieces !== undefined) actualBits.push(`${c.actual.pieces} 箱`);
  if (c.actual.containers !== undefined) actualBits.push(`${c.actual.containers} 柜`);

  out.push(`  算出    ${computed}   装载率 ${pctText(c.computed.loadRate)}`);
  out.push(`  实际    ${actualBits.length ? actualBits.join(' / ') : '（未填）'}`);

  if (d.piecesDelta === undefined) {
    out.push('  偏差    （未填实测，算不出偏差）');
  } else {
    // piecesDeltaPct 已经是百分数（如 7.33），不是 0~1，别再乘 100
    const pct = d.piecesDeltaPct === undefined ? '' : `  ${signed(round2(d.piecesDeltaPct))}%`;
    out.push(`  偏差    ${signed(d.piecesDelta)} 箱${pct}`);
  }
  if (d.containersDelta !== undefined && d.containersDelta !== 0) {
    out.push(`  柜差    ${signed(d.containersDelta)} 柜`);
  }
  if (!d.allPacked) {
    out.push(`  注意    未能全部装完（未装 ${c.computed.remaining.length} 项）`);
  }
  if (c.actual.note) out.push(`  备注    ${c.actual.note.replace(/\s*\n\s*/g, ' ')}`);
  return out;
}

function caseHeader(c: LoadCase): string[] {
  const ct = c.container;
  return [
    `  柜型    ${ct.label || ct.name}  ${ct.innerLength}x${ct.innerWidth}x${ct.innerHeight} mm  载重 ${weightText(ct.weightCapacity)}`,
    `  策略    ${strategyText(c.strategy)}`,
    `  记录    ${c.createdAt}   案例「${c.name}」`,
  ];
}

/** 单条偏差摘要。**不含任何货物信息** */
export function formatSummary(c: LoadCase, _meta?: ShareMeta): string {
  return [
    '案例偏差记录（不含货物名称与尺寸）',
    RULE,
    ...caseHeader(c),
    ...deltaLines(c),
  ].join('\n');
}

/** 多条偏差摘要拼成一份，供一次性发送 */
export function formatSummaryBatch(list: LoadCase[], meta?: ShareMeta): string {
  if (list.length === 0) return '（没有可发送的偏差记录）';
  const head = [
    '装柜专家 - 偏差记录汇总',
    `共 ${list.length} 条${meta ? `   应用 ${meta.appVersion}   生成于 ${meta.at}` : ''}`,
    '本汇总只有柜型、策略与箱数数字，不含任何货物名称或尺寸。',
    RULE,
  ];
  const body = list.map((c, i) => `[${i + 1}/${list.length}]\n${formatSummary(c)}`);
  return [...head, ...body].join('\n\n');
}

// ---------------------------------------------------------------------------
// 完整案例（去标识）
// ---------------------------------------------------------------------------

/** 单条货物的技术描述。**不输出 name / sku / batch / groupName / id** */
function boxText(b: LoadCase['boxes'][number], idx: number): string[] {
  const unit = b.dimensionUnit && b.dimensionUnit !== 'mm' ? ` ${b.dimensionUnit}` : '';
  const L: string[] = [];
  L.push(
    `  #${idx}  ${b.length}x${b.width}x${b.height}${unit}   ${weightText(b.weight)}   数量 ${b.quantity}`,
  );
  const extra: string[] = [];
  if (b.pcsCount && b.pcsCount !== 1) extra.push(`每箱 ${b.pcsCount} 件`);
  extra.push(`堆码级别 ${b.stackClass}`);
  if (b.supportPct) extra.push(`承托比例 ${b.supportPct.join('/')}`);
  L.push(`       ${extra.join('   ')}`);
  L.push(`       可摆放 ${flagsText(b.allowDirections)}   承托级 ${sixText(b.supportClasses)}`);
  if (b.supportFaces) L.push(`       承重面 ${flagsText(b.supportFaces)}`);
  if (b.maxPlaceDepth && b.maxPlaceDepth.some((x) => x)) {
    L.push(`       最大堆放 ${sixText(b.maxPlaceDepth)}`);
  }
  // 型变系数是"现场装不到"最常见的技术原因（软包装压缩），有就一定要带上
  if (b.deformFactor !== undefined && b.deformFactor !== 1) {
    L.push(`       型变系数 ${b.deformFactor}${b.deformTolerance !== undefined ? `   公差 ${b.deformTolerance}` : ''}`);
  }
  return L;
}

/** 单条完整案例，货物清单已去标识 */
export function formatFull(c: LoadCase, meta?: ShareMeta): string {
  const lines: string[] = [
    '完整案例（货物名称已去除）',
    RULE,
    ...caseHeader(c),
  ];
  if (c.options) {
    const o: string[] = [];
    if (c.options.allowRotation === false) o.push('禁止旋转');
    if (c.options.stackRulesEnabled === false) o.push('无堆码约束');
    if (c.options.supportRulesEnabled === false) o.push('无承托约束');
    if (c.options.candidateLimit) o.push(`候选块上限 ${c.options.candidateLimit}`);
    if (c.options.lpEnabled) o.push('启用体积配比');
    lines.push(`  选项    ${o.length ? o.join('   ') : '默认（可旋转 + 堆码/承托约束）'}`);
  }
  lines.push(...deltaLines(c));
  lines.push(`  占用    体积 ${volumeText(c.computed.usedVolume)}   总重 ${weightText(c.computed.totalWeight)}`);
  lines.push(RULE);
  lines.push(`货物清单（${c.boxes.length} 种，名称已全部替换为序号）`);
  c.boxes.forEach((b, i) => lines.push(...boxText(b, i + 1)));
  lines.push(RULE);
  lines.push(
    meta
      ? `本记录由装柜专家 ${meta.appVersion} 自动生成，用于改进装柜算法。`
      : '本记录由装柜专家自动生成，用于改进装柜算法。',
  );
  return lines.join('\n');
}

/** 多条完整案例拼成一份 */
export function formatFullBatch(list: LoadCase[], meta?: ShareMeta): string {
  if (list.length === 0) return '（没有可发送的案例）';
  const head = [
    '装柜专家 - 完整案例汇总（货物名称已去除）',
    `共 ${list.length} 条${meta ? `   应用 ${meta.appVersion}   生成于 ${meta.at}` : ''}`,
    '保留了货物尺寸、重量与摆放限制（算法改进所需），名称 / SKU / 批次 / 单价已全部去除。',
    RULE,
  ];
  const body = list.map((c, i) => `[${i + 1}/${list.length}]\n${formatFull(c, meta)}`);
  return [...head, ...body].join('\n\n');
}
