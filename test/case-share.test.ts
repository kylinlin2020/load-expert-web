/**
 * 实测案例分享文本的测试
 *
 * ## 为什么要单独一个文件
 *
 * `case-diagnostics.test.ts` 测的是**存得对不对**（偏差方向、不可变、往返一致），
 * 这里测的是**发出去会不会泄露**。两件事的风险性质完全不同：
 * 存错了一个数，算法改进用；发错了字段，客户的货名/尺寸就公开了。
 *
 * ## 最重要的一条
 *
 * `摘要里绝不出现货物信息` 与 `完整案例里绝不出现货物名称`。
 * 这两条要是破了，其余测试写得再漂亮也没意义 ——
 * 所以用**带唯一标记的假名**（`客户机密货物XYZ`）来断言，
 * 哪怕只泄露一次也能被抓住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatFull,
  formatFullBatch,
  formatSummary,
  formatSummaryBatch,
  volumeText,
  weightText,
  pctText,
} from '../src/model/caseShare.js';
import type { LoadCase } from '../src/model/case.js';
import type { Box, Container } from '../src/types/index.js';

const META = { appVersion: '0.1.99', at: '2026-10-04T12:00:00.000Z' };

const CONTAINER: Container = {
  id: '3',
  name: '40HQ',
  label: '40HQ',
  innerLength: 11900,
  innerWidth: 2340,
  innerHeight: 2680,
  weightCapacity: 26800,
};

/** 名称里带唯一标记：任何泄露都会被下面的断言抓住 */
const SECRET_NAME = '客户机密货物XYZ';
const SECRET_SKU = 'SKU-绝密-777';

function box(id: string, name: string, qty: number, over: Partial<Box> = {}): Box {
  return {
    id,
    name,
    sku: SECRET_SKU,
    batch: '批次-绝密-B9',
    groupName: '分组-绝密',
    length: 480,
    width: 380,
    height: 380,
    weight: 20,
    stackClass: 8,
    allowDirections: [true, true, false, false, false, false],
    supportClasses: [8, 8, 4, 4, 4, 4],
    supportPct: [1, 1, 1],
    supportFaces: [true, true, true, true, true, true],
    maxPlaceDepth: [0, 0, 0, 0, 0, 0],
    pcsCount: 1,
    quantity: qty,
    ...over,
  };
}

function makeCase(over: Partial<LoadCase> = {}): LoadCase {
  return {
    id: 1,
    name: '10月第一单',
    createdAt: '2026-10-04 09:30:00',
    container: CONTAINER,
    boxes: [box('1', SECRET_NAME, 630), box('2', SECRET_NAME + '二号', 336)],
    strategy: 3,
    computed: {
      pieces: 966,
      loadRate: 0.9596,
      containers: 1,
      totalWeight: 19320,
      usedVolume: 8.0e9,
      allPacked: true,
      remaining: [],
    },
    actual: { pieces: 900, containers: 1, note: '有软包，实际压得比标称矮' },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 隐私：最重要的一组
// ---------------------------------------------------------------------------

test('偏差摘要里不出现任何货物信息（名称/SKU/批次/分组/尺寸/数量）', () => {
  const t = formatSummary(makeCase(), META);
  assert.ok(!t.includes(SECRET_NAME), '泄露了货物名称');
  assert.ok(!t.includes('客户机密货物XYZ二号'), '泄露了第二条货物名称');
  assert.ok(!t.includes(SECRET_SKU), '泄露了 SKU');
  assert.ok(!t.includes('批次-绝密-B9'), '泄露了批次');
  assert.ok(!t.includes('分组-绝密'), '泄露了分组名');
  assert.ok(!t.includes('480'), '泄露了货物尺寸（长 480）');
  assert.ok(!t.includes('630'), '泄露了货物数量');
  assert.ok(!t.includes('水泵'), '不应出现任何货物相关字样');
});

test('完整案例保留了尺寸但去掉了全部标识字段', () => {
  const t = formatFull(makeCase(), META);
  // 尺寸必须留 —— 算法改进的原料就是它
  assert.ok(t.includes('480x380x380'), '完整案例必须保留货物尺寸');
  assert.ok(t.includes('630'), '完整案例必须保留数量');
  assert.ok(t.includes('8'), '应包含堆码级别');
  // 标识字段一个都不能有
  assert.ok(!t.includes(SECRET_NAME), '泄露了货物名称');
  assert.ok(!t.includes(SECRET_SKU), '泄露了 SKU');
  assert.ok(!t.includes('批次-绝密-B9'), '泄露了批次');
  assert.ok(!t.includes('分组-绝密'), '泄露了分组名');
});

test('完整案例连货物 id 都不输出（保不准哪天 id 里塞了名称）', () => {
  // 故意让 id 就是名称，模拟"有人拿名字当 id"
  const c = makeCase({ boxes: [box(SECRET_NAME, SECRET_NAME, 630)] });
  const t = formatFull(c, META);
  assert.ok(!t.includes(SECRET_NAME), 'id 里带名称时泄露了');
  assert.ok(t.includes('#1'), '应改用序号指代');
});

test('案例名与备注是用户自己写的，两档都原样保留', () => {
  const c = makeCase({ name: '10月第一单', actual: { pieces: 900, note: '有软包，实际压得比标称矮' } });
  for (const t of [formatSummary(c, META), formatFull(c, META)]) {
    assert.ok(t.includes('10月第一单'), '案例名应保留（用户自己填的）');
    assert.ok(t.includes('有软包'), '备注应保留 —— 它解释了偏差原因，是最有价值的信息');
  }
});

test('文本自己声明了去标识范围（对方不必猜）', () => {
  // 单条也要声明：用户很可能只发一条，那一刻没有批量头部可依赖
  assert.ok(formatSummary(makeCase(), META).includes('不含货物名称与尺寸'));
  assert.ok(formatFull(makeCase(), META).includes('货物名称已去除'));
  // 批量头部再声明一次（多份拼在一起时容易被当成一个文件）
  assert.ok(formatSummaryBatch([makeCase()], META).includes('不含任何货物名称或尺寸'));
});

// ---------------------------------------------------------------------------
// 偏差表达
// ---------------------------------------------------------------------------

test('摘要：高估为正、保守为负、吻合为 0', () => {
  const over = formatSummary(makeCase({ actual: { pieces: 900 } }), META);
  assert.ok(over.includes('+66 箱'), '高估应为 +66');
  assert.ok(over.includes('7.33%'), '偏差百分比应为 7.33%');

  const under = formatSummary(makeCase({ actual: { pieces: 1000 } }), META);
  assert.ok(under.includes('-34 箱'), '保守应为 -34');

  const exact = formatSummary(makeCase({ actual: { pieces: 966 } }), META);
  assert.ok(exact.includes('偏差    0 箱'), `吻合应显示 0，实际输出：\n${exact}`);
  assert.ok(!exact.includes('+0'), '不应出现 +0 这种别扭写法');
});

test('摘要：百分比没有浮点尾巴', () => {
  const t = formatSummary(makeCase({ actual: { pieces: 900 } }), META);
  assert.ok(!/\d\.\d{4,}/.test(t), `出现多余小数位：\n${t}`);
});

test('柜数差单独成行，且只在不等时出现', () => {
  // 算法算 1 柜、现场实际用了 2 柜 → 算法**少算**，与箱数同用 computed - actual 的口径，故为负。
  // 我第一版断言成 +1，是期望值写错（想成"现场多用了"），不是实现错。
  const diff = formatSummary(makeCase({ actual: { pieces: 900, containers: 2 } }), META);
  assert.ok(diff.includes('柜差    -1 柜'), '算法少用 1 个柜应写 -1');
  const same = formatSummary(makeCase({ actual: { pieces: 900, containers: 1 } }), META);
  assert.ok(!same.includes('柜差'), '柜数相同就不该出现这一行');
});

test('未填实测时明说"算不出偏差"，不静默省略', () => {
  const t = formatSummary(makeCase({ actual: {} }), META);
  assert.ok(t.includes('（未填）'), '应标注实测未填');
  assert.ok(t.includes('算不出偏差'), '应明说偏差不可算');
  assert.ok(!t.includes('偏差    +'), '不该凭空造一个偏差');
});

test('未能全部装完要提示（这是偏差的常见原因）', () => {
  const c = makeCase({
    computed: { ...makeCase().computed, allPacked: false, remaining: [{ boxId: 'x', qty: 0 }, { boxId: 'y', qty: 0 }] },
  });
  assert.ok(formatSummary(c, META).includes('未能全部装完'), '应提示未装完');
  assert.ok(formatSummary(c, META).includes('未装 2 项'), '应给出未装项数');
});

test('备注里的换行被压成一行（否则粘贴后格式乱掉）', () => {
  const t = formatSummary(makeCase({ actual: { pieces: 900, note: '第一行\n第二行' } }), META);
  assert.ok(t.includes('第一行 第二行'), '换行应压成空格');
  assert.ok(!t.includes('第一行\n'), '不应残留换行');
});

// ---------------------------------------------------------------------------
// 批量（连续累积）
// ---------------------------------------------------------------------------

test('批量：头部含条数与版本，多条按序号分隔', () => {
  const list = [
    makeCase({ id: 1, name: 'A', actual: { pieces: 900 } }),
    makeCase({ id: 2, name: 'B', actual: { pieces: 1000 } }),
    makeCase({ id: 3, name: 'C', actual: { pieces: 966 } }),
  ];
  const t = formatSummaryBatch(list, META);
  assert.ok(t.includes('共 3 条'), '头部应写明条数');
  assert.ok(t.includes('应用 0.1.99'), '头部应带版本');
  assert.ok(t.includes('[1/3]') && t.includes('[3/3]'), '应按 n/N 编号');
  // 三条都在
  for (const n of ['A', 'B', 'C']) assert.ok(t.includes(`案例「${n}」`), `缺案例 ${n}`);
});

test('批量：隐私约束与单条一致（不能因为打包就放松）', () => {
  const t = formatFullBatch([makeCase({ id: 1 }), makeCase({ id: 2 })], META);
  assert.ok(!t.includes(SECRET_NAME), '批量完整案例泄露了名称');
  assert.ok(!t.includes(SECRET_SKU), '批量完整案例泄露了 SKU');
  assert.ok(t.includes('480x380x380'), '批量仍应保留尺寸');
});

test('批量：空列表给出明确说明而不是空白', () => {
  assert.ok(formatSummaryBatch([], META).includes('没有可发送'));
  assert.ok(formatFullBatch([], META).includes('没有可发送'));
});

test('批量：条数很多时体积线性增长（没有把同一条重复拼进去）', () => {
  const one = formatSummary(makeCase(), META);
  const ten = formatSummaryBatch(Array.from({ length: 10 }, () => makeCase()), META);
  // 10 条应约等于 10 倍单条 + 一点头部开销；明显小于 10 倍说明漏了，明显大于说明重复了
  assert.ok(ten.length > one.length * 9, '批量内容偏少，可能漏条目');
  assert.ok(ten.length < one.length * 11, '批量内容偏多，可能重复拼接');
});

// ---------------------------------------------------------------------------
// 数值格式
// ---------------------------------------------------------------------------

test('体积按量级选单位（算法内部是 mm³，直接印出来没人读得懂）', () => {
  assert.equal(volumeText(8.0e9), '8.00 m³');
  assert.equal(volumeText(2.5e6), '2.50 L');
  assert.equal(volumeText(1234), '1234 mm³');
  assert.equal(volumeText(undefined), '（未知）');
});

test('重量超过半吨用吨', () => {
  assert.equal(weightText(19320), '19.32 吨');
  assert.equal(weightText(20), '20 kg');
  assert.equal(weightText(undefined), '（未知）');
});

test('百分比入参是 0~1', () => {
  assert.equal(pctText(0.9596), '95.96%');
  assert.equal(pctText(1), '100.00%');
  assert.equal(pctText(undefined), '（未知）');
});

// ---------------------------------------------------------------------------
// 货物技术字段
// ---------------------------------------------------------------------------

test('型变系数必须带上 —— 软包装压缩是现场装不到的头号原因', () => {
  const c = makeCase({ boxes: [box('1', SECRET_NAME, 630, { deformFactor: 0.85, deformTolerance: 0.02 })] });
  const t = formatFull(c, META);
  assert.ok(t.includes('型变系数 0.85'), '应输出型变系数');
  assert.ok(t.includes('公差 0.02'), '应输出公差');
});

test('型变系数为 1（无变形）时不输出那一行', () => {
  const c = makeCase({ boxes: [box('1', SECRET_NAME, 630, { deformFactor: 1 })] });
  assert.ok(!formatFull(c, META).includes('型变系数'), '默认值不该占一行');
});

test('未设置摆放限制时写"不限"而不是空白（空白会被误读成没数据）', () => {
  const c = makeCase({ boxes: [box('1', SECRET_NAME, 630, { allowDirections: undefined })] });
  assert.ok(formatFull(c, META).includes('可摆放 不限'), '缺省应写"不限"');
});

test('最大堆放全为 0 时写"不限"（0 的语义就是不限）', () => {
  const c = makeCase({ boxes: [box('1', SECRET_NAME, 630, { maxPlaceDepth: [0, 0, 0, 0, 0, 0] })] });
  assert.ok(!formatFull(c, META).includes('最大堆放'), '全 0 时不必输出该行');
});

test('每箱多件时标出件数', () => {
  const c = makeCase({ boxes: [box('1', SECRET_NAME, 630, { pcsCount: 6 })] });
  assert.ok(formatFull(c, META).includes('每箱 6 件'));
});

test('策略名从算法常量取，不手写（避免与实现漂移）', () => {
  const t = formatSummary(makeCase({ strategy: 4 }), META);
  assert.ok(t.includes('承托分级分层'), '应显示策略名而非纯数字');
  const unknown = formatSummary(makeCase({ strategy: 99 }), META);
  assert.ok(unknown.includes('未知策略'), '越界策略要显式标注，不能显示成 undefined');
});

test('非 mm 的尺寸单位要带上单位（否则 480 到底是 cm 还是 mm？）', () => {
  const c = makeCase({ boxes: [box('1', SECRET_NAME, 10, { dimensionUnit: 'cm' })] });
  assert.ok(formatFull(c, META).includes('cm'), '应标出单位');
  const mm = makeCase({ boxes: [box('1', SECRET_NAME, 10, { dimensionUnit: 'mm' })] });
  assert.ok(!/480x380x380 mm/.test(formatFull(mm, META)), '默认 mm 不必重复标单位');
});

test('自定义柜型名会带上（柜型名通常是 20GP 这类通用名，不是客户信息）', () => {
  const c = makeCase({ container: { ...CONTAINER, name: '45HQ', label: '' } });
  const t = formatSummary(c, META);
  assert.ok(t.includes('45HQ'), '柜型名应出现');
  assert.ok(t.includes('13500x') || t.includes('11900x'), '内尺寸必须出现');
});
