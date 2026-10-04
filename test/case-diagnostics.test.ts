/**
 * 实测案例 + 诊断采集 的测试
 *
 * ## 案例模块测什么
 *
 * 核心是**偏差分析**：算法算出多少 vs 现场实际多少，差多少、偏了几个百分点。
 * 这套算法是纯函数，所以能完整单测 —— 而它恰恰是最该被测的部分：
 * 算错偏差方向会让维护者把"算法高估"当成"算法保守"，改进方向整个搞反。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeCase,
  casePriority,
  computedFromResult,
  rowToCase,
  summarizeCases,
  type LoadCase,
} from '../src/model/case.js';
import { openDatabase, listCases, insertCase, updateCaseActual, deleteCase, getCase } from '../src/db/db.js';
import { exportBackupSqlite, sqliteBackupAdapter } from '../src/db/backup.js';
import { exportBackup, importBackup } from '../src/model/backupApply.js';
import { parseBackup, buildBackup } from '../src/model/backup.js';
import { LocalStore } from '../src/web/api/localStore.js';
import { createMemStore } from './helpers/memAdapter.js';
import { RingBuffer } from '../src/web/lib/diagnostics.js';
import type { Container, Box, PackResult } from '../src/types/index.js';

// ---------------------------------------------------------------------------
// 样本
// ---------------------------------------------------------------------------

const CONTAINER: Container = {
  id: '3',
  name: '40HQ',
  innerLength: 11900,
  innerWidth: 2340,
  innerHeight: 2680,
  weightCapacity: 26800,
  label: '40HQ',
};

function box(id: string, name: string, qty: number): Box {
  return {
    id,
    name,
    length: 480, width: 380, height: 380, weight: 20,
    stackClass: 8,
    allowDirections: [true, true, false, false, false, false],
    maxPlaceDepth: [0, 0, 0, 0, 0, 0],
    supportFaces: [true, true, true, true, true, true],
    supportClasses: [8, 8, 4, 4, 4, 4],
    supportPct: [1, 1, 1],
    pcsCount: 1,
    quantity: qty,
  };
}

function makeResult(pieces: number, loadRate: number, rejected: number = 0): PackResult {
  return {
    placements: [],
    usedVolume: 8_000_000_000,
    loadRate,
    totalWeight: pieces * 20,
    pieces,
    layers: [],
    strategy: 3,
    lpEnabled: false,
    rejected: Array.from({ length: rejected }, (_, i) => ({ boxId: String(i + 1), reason: 'space-exhausted' })),
    iterations: 2,
  } as unknown as PackResult;
}

function makeCase(over: Partial<LoadCase> = {}): LoadCase {
  return {
    id: 1,
    name: '案例',
    createdAt: '2026-10-04 10:00:00',
    container: CONTAINER,
    boxes: [box('1', '水泵2', 966)],
    strategy: 3,
    computed: {
      pieces: 966,
      loadRate: 0.9596,
      containers: 1,
      totalWeight: 19320,
      usedVolume: 8e9,
      allPacked: true,
      remaining: [],
    },
    actual: {},
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 偏差分析
// ---------------------------------------------------------------------------

test('偏差：算法高估（算出比现场多）—— 最需要警惕的方向', () => {
  const d = analyzeCase(makeCase({ actual: { pieces: 900 } }));
  assert.equal(d.computedPieces, 966);
  assert.equal(d.actualPieces, 900);
  assert.equal(d.piecesDelta, 66, '正数 = 高估');
  assert.ok(Math.abs(d.piecesDeltaPct! - 7.33) < 0.1, `偏差百分比应约 7.33%，实际 ${d.piecesDeltaPct?.toFixed(2)}`);
});

test('偏差：算法保守（算出比现场少）', () => {
  const d = analyzeCase(makeCase({ actual: { pieces: 1000 } }));
  assert.equal(d.piecesDelta, -34, '负数 = 保守');
  assert.ok(d.piecesDeltaPct! < 0);
});

test('偏差：完全吻合时 delta 为 0，hasActual 仍为 true', () => {
  const d = analyzeCase(makeCase({ actual: { pieces: 966 } }));
  assert.equal(d.piecesDelta, 0);
  assert.equal(d.hasActual, true, '填了实测就算 hasActual，即便恰好吻合');
});

test('偏差：只填备注也算 hasActual（用户至少表达了判断）', () => {
  assert.equal(analyzeCase(makeCase({ actual: { note: '货物有压缩' } })).hasActual, true);
  assert.equal(analyzeCase(makeCase({ actual: {} })).hasActual, false);
});

test('偏差：柜数差单独统计（多柜循环场景下箱数对但柜数错也要能发现）', () => {
  const c = makeCase({
    computed: { ...makeCase().computed, containers: 3, pieces: 966 },
    actual: { containers: 4 },
  });
  const d = analyzeCase(c);
  assert.equal(d.containersDelta, -1);
  assert.equal(d.piecesDelta, undefined, '没填实际箱数时箱数差应为空，不能拿柜数差冒充');
});

test('实际箱数为 0 时不算百分比（除零）', () => {
  const d = analyzeCase(makeCase({ actual: { pieces: 0 } }));
  assert.equal(d.piecesDelta, 966);
  assert.equal(d.piecesDeltaPct, undefined, '不能对 0 求百分比');
});

test('computedFromResult：从算法结果填出案例的算法侧', () => {
  const c = computedFromResult(makeResult(966, 0.9596, 0), 1);
  assert.equal(c.pieces, 966);
  assert.equal(c.allPacked, true);
  assert.equal(c.containers, 1);

  const withReject = computedFromResult(makeResult(900, 0.9, 3), 2);
  assert.equal(withReject.allPacked, false, '有未装就不是 allPacked');
  assert.equal(withReject.containers, 2);
  assert.equal(withReject.remaining.length, 3);
});

// ---------------------------------------------------------------------------
// 排序与汇总
// ---------------------------------------------------------------------------

test('优先级：有偏差的排最前，吻合的排最后，未填实测的居中', () => {
  const off = makeCase({ id: 1, actual: { pieces: 900 } });      // 偏差 66
  const none = makeCase({ id: 2 });                                // 未填
  const exact = makeCase({ id: 3, actual: { pieces: 966 } });      // 吻合
  assert.equal(casePriority(off), 0);
  assert.equal(casePriority(none), 1);
  assert.equal(casePriority(exact), 2);
});

test('汇总：高估数 / 保守数 / 平均偏差 / 最差案例', () => {
  const list = [
    makeCase({ id: 1, actual: { pieces: 900 } }),   // +66 高估
    makeCase({ id: 2, actual: { pieces: 1000 } }),  // -34 保守
    makeCase({ id: 3, actual: { pieces: 966 } }),   // 0
    makeCase({ id: 4 }),                             // 未填
  ];
  const s = summarizeCases(list);
  assert.equal(s.total, 4);
  assert.equal(s.withActual, 3);
  assert.equal(s.overestimated, 1);
  assert.equal(s.underestimated, 1);
  assert.equal(s.worst?.id, 1, '最差应是偏差最大的那个');
  // 平均偏差把**三条已填实测的都算进去**（含吻合的那条 0%）：
  //   (66/900 + (-34/1000) + 0/966) / 3 = (0.07333 - 0.034 + 0) / 3 = 1.3111%
  // 我第一版写成除以 2（漏了吻合那条），是期望值算错，不是实现错。
  assert.ok(Math.abs(s.avgDeltaPct! - 1.31111) < 0.001, `实际 ${s.avgDeltaPct}`);
});

test('汇总：一条实测都没有时 avgDeltaPct 为 undefined（而不是 0）', () => {
  const s = summarizeCases([makeCase()]);
  assert.equal(s.withActual, 0);
  assert.equal(s.avgDeltaPct, undefined, '0 会被误读成"平均没偏差"');
});

// ---------------------------------------------------------------------------
// 行映射的容错
// ---------------------------------------------------------------------------

test('行映射：JSON 损坏时不抛异常（一条脏数据不该毁掉整个列表）', () => {
  const c = rowToCase({
    id: 1,
    name: '脏案例',
    created_at: '2026-10-04',
    container_json: '{不是合法 JSON',
    boxes_json: '也是坏的',
    strategy: 3,
    options_json: null,
    computed_json: '坏的',
    actual_json: '坏的',
  });
  assert.equal(c.name, '脏案例');
  assert.deepEqual(c.boxes, [], '坏掉的清单退化为空数组');
  assert.equal(c.computed.pieces, 0);
  assert.deepEqual(c.actual, {});
  assert.ok(c.container, '必须给一个占位柜型，否则渲染时会炸');
});

// ---------------------------------------------------------------------------
// 存储：SQLite
// ---------------------------------------------------------------------------

test('SQLite：案例增删改查，且 computed 不可变', () => {
  const db = openDatabase(':memory:');
  const created = insertCase(db, {
    name: '现场案例 A',
    container: CONTAINER,
    boxes: [box('1', '水泵2', 966)],
    strategy: 3,
    computed: {
      pieces: 966, loadRate: 0.9596, containers: 1,
      totalWeight: 19320, usedVolume: 8e9, allPacked: true, remaining: [],
    },
  });
  assert.ok(created.id > 0);
  assert.equal(listCases(db).length, 1);

  // 补录实测
  const updated = updateCaseActual(db, created.id, { pieces: 900, note: '有软包' });
  assert.equal(updated?.actual.pieces, 900);
  assert.equal(updated?.actual.note, '有软包');
  // 关键：算法侧不能被改动
  assert.equal(updated?.computed.pieces, 966, '补录实测不得改动算法输出');
  assert.deepEqual(updated?.container, CONTAINER, '柜型快照应原样保留');

  assert.ok(getCase(db, created.id));
  assert.equal(deleteCase(db, created.id), true);
  assert.equal(deleteCase(db, created.id), false, '重复删除应返回 false');
  assert.equal(listCases(db).length, 0);
});

test('SQLite：updateCaseActual 对不存在的 id 返回 null（不静默新建）', () => {
  const db = openDatabase(':memory:');
  assert.equal(updateCaseActual(db, 999, { pieces: 1 }), null);
});

// ---------------------------------------------------------------------------
// 备份往返：案例必须跟着走
// ---------------------------------------------------------------------------

test('备份往返：案例随备份导出与恢复（丢了等于把实测数据扔了）', async () => {
  const db = openDatabase(':memory:');
  insertCase(db, {
    name: '案例A',
    container: CONTAINER,
    boxes: [box('1', '水泵2', 966)],
    strategy: 3,
    computed: {
      pieces: 966, loadRate: 0.9596, containers: 1,
      totalWeight: 19320, usedVolume: 8e9, allPacked: true, remaining: [],
    },
    actual: { pieces: 900, note: '有软包' },
  });

  const file = await exportBackupSqlite(db, 'test');
  assert.equal(file.data.cases?.length, 1);
  assert.equal(file.data.cases?.[0].actual.pieces, 900);

  const parsed = parseBackup(JSON.stringify(JSON.parse(JSON.stringify(file))));
  assert.equal(parsed.data.cases?.length, 1, '解析后仍在');

  const fresh = openDatabase(':memory:');
  await importBackup(sqliteBackupAdapter(fresh), parsed, 'replace');
  const back = listCases(fresh);
  assert.equal(back.length, 1);
  assert.equal(back[0].name, '案例A');
  assert.equal(back[0].actual.pieces, 900);
  assert.equal(back[0].computed.pieces, 966);
  assert.equal(back[0].container.innerLength, 11900, '柜型快照必须往返保持');
});

test('备份：老备份（没有 cases 字段）仍能导入 —— 刻意不为案例升格式版本', () => {
  // 模拟 v1 早期导出的文件：data 里只有 boxes/containers/plans
  const old = {
    format: 'load-expert-backup',
    version: 1,
    exportedAt: '2026-01-01T00:00:00.000Z',
    appVersion: '0.1.0',
    data: { boxes: [], containers: [], plans: [] },
  };
  const parsed = parseBackup(JSON.stringify(old));
  assert.deepEqual(parsed.data.cases, [], '缺失的 cases 按空数组处理，不报错');
});

test('备份：cases 为可选字段，不升版本（升版本会让所有旧备份无法导入）', () => {
  const withCases = buildBackup({
    boxes: [], containers: [], plans: [],
    cases: [makeCase()],
    appVersion: 'test',
  });
  assert.equal(withCases.version, 1, '仍是版本 1');
  assert.equal(withCases.data.cases?.length, 1);

  const without = buildBackup({ boxes: [], containers: [], plans: [], appVersion: 'test' });
  assert.equal('cases' in without.data, false, '没传就不写这个键，与老备份结构一致');
});

// ---------------------------------------------------------------------------
// 两种存储的案例行为必须一致
// ---------------------------------------------------------------------------

test('两种存储对同一份案例给出一致结果（否则跨版本搬数据会看到差异）', async () => {
  const db = openDatabase(':memory:');
  const computed = {
    pieces: 966, loadRate: 0.9596, containers: 1,
    totalWeight: 19320, usedVolume: 8e9, allPacked: true, remaining: [],
  };
  insertCase(db, { name: 'X', container: CONTAINER, boxes: [box('1', 'P', 966)], strategy: 3, computed });
  const store = new LocalStore(createMemStore());
  await store.insertCase({ name: 'X', container: CONTAINER, boxes: [box('1', 'P', 966)], strategy: 3, computed });

  const fromServer = (await exportBackupSqlite(db, 't', false)).data.cases![0];
  const fromLocal = (await exportBackup(store.asBackupAdapter(), 't', false)).data.cases![0];

  const strip = (c: Record<string, unknown>) => {
    const { id: _i, createdAt: _c, ...rest } = c;
    void _i; void _c;
    return JSON.stringify(rest);
  };
  assert.equal(strip(fromServer as never), strip(fromLocal as never));
});

test('IndexedDB：案例补录实测后 computed 不变', async () => {
  const api = new LocalStore(createMemStore());
  const c = await api.insertCase({
    name: 'Y',
    container: CONTAINER,
    boxes: [box('1', 'P', 966)],
    strategy: 3,
    computed: { pieces: 966, loadRate: 0.96, containers: 1, totalWeight: 1, usedVolume: 1, allPacked: true, remaining: [] },
  });
  const updated = await api.updateCaseActual(c.id, { pieces: 880 });
  assert.equal(updated?.actual.pieces, 880);
  assert.equal(updated?.computed.pieces, 966);
});

// ---------------------------------------------------------------------------
// 诊断：环形缓冲
// ---------------------------------------------------------------------------

test('诊断缓冲：超出上限时丢最旧的', () => {
  const b = new RingBuffer(3);
  for (let i = 0; i < 5; i++) b.push({ at: new Date().toISOString(), kind: 'error', message: `e${i}` });
  assert.equal(b.size, 3);
  assert.deepEqual(b.list().map((x) => x.message), ['e2', 'e3', 'e4']);
});

test('诊断缓冲：5 秒内重复的同一错误只更新时间，不占新条目', () => {
  const b = new RingBuffer(10);
  const t0 = Date.parse('2026-10-04T10:00:00Z');
  b.push({ at: new Date(t0).toISOString(), kind: 'error', message: '同一个错' });
  b.push({ at: new Date(t0 + 1000).toISOString(), kind: 'error', message: '同一个错' });
  assert.equal(b.size, 1, '重复错误不该把缓冲挤满');

  // 超过 5 秒则算新条目
  b.push({ at: new Date(t0 + 6000).toISOString(), kind: 'error', message: '同一个错' });
  assert.equal(b.size, 2);
});

test('诊断缓冲：不同 kind 的同名条目不算重复', () => {
  const b = new RingBuffer(10);
  b.push({ at: new Date().toISOString(), kind: 'error', message: 'x' });
  b.push({ at: new Date().toISOString(), kind: 'warn', message: 'x' });
  assert.equal(b.size, 2);
});

test('诊断缓冲：countOf 与 clear', () => {
  const b = new RingBuffer(10);
  b.push({ at: new Date().toISOString(), kind: 'error', message: 'a' });
  b.push({ at: new Date().toISOString(), kind: 'nav', message: 'b' });
  assert.equal(b.countOf('error'), 1);
  b.clear();
  assert.equal(b.size, 0);
});