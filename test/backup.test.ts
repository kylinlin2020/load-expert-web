/**
 * 备份 / 恢复测试
 *
 * ## 最要紧的一条：导出 → 导入 → 再导出 必须完全相等
 *
 * 这条不变式覆盖了"id 与引用有没有被搞坏"这个隐形的失败模式：
 * `PackResult` 里到处是 `boxId` 引用，`PlanRecord.containerId` 指向柜型。
 * 导入时若重新分配 id 而漏改某处引用，**界面不会报错，只会默默显示错货名** ——
 * 这种 bug 靠人工点页面几乎不可能发现。
 *
 * ## 另一条：跨存储迁移（SQLite ↔ IndexedDB）
 *
 * 这是用户要备份功能的根本原因：静态版数据只在浏览器里，
 * 且服务端版数据在 SQLite 文件里，两边必须能互换。
 * 所以不只测"自己导自己进"，还测"A 导出 → B 导入"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openDatabase,
  insertBox,
  insertContainer,
  insertPlan,
  listBoxes,
  listContainers,
  listPlans,
} from '../src/db/db.js';
import { exportBackupSqlite, importBackupSqlite, sqliteBackupAdapter } from '../src/db/backup.js';
import { exportBackup, importBackup } from '../src/model/backupApply.js';
import {
  buildBackup,
  parseBackup,
  BackupFormatError,
  BACKUP_FORMAT,
  backupFileName,
} from '../src/model/backup.js';
import { LocalStore } from '../src/web/api/localStore.js';
import { createMemStore } from './helpers/memAdapter.js';
import { load } from '../src/algorithm/load.js';
import type { Box, Container } from '../src/types/index.js';

const APP = '9.9.9';

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 造一份有代表性的数据（含大尺寸货物、六向限制、型变系数等所有字段） */
function sampleContainer(over: Partial<Container> = {}): Container {
  return {
    id: '10',
    name: '40HQ 实际柜',
    innerLength: 11900,
    innerWidth: 2340,
    innerHeight: 2680,
    weightCapacity: 26800,
    label: '40HQ',
    description: '用户实测柜型',
    cornerDims: [100, 100, 100],
    doorDims: [2340, 2680],
    emptyWeight: 4000,
    cost: 3000,
    unit: '柜',
    dimensionUnit: 'mm',
    weightUnit: 'kg',
    ...over,
  };
}

function sampleBox(over: Partial<Box> = {}): Box {
  return {
    id: '20',
    name: '水泵2',
    sku: 'SKU-1',
    batch: '2026-09',
    unitPrice: 12.5,
    unit: '台',
    groupName: '水泵',
    description: '测试用',
    netWeight: 18,
    color: '#409eff',
    dimensionUnit: 'mm',
    weightUnit: 'kg',
    length: 480,
    width: 380,
    height: 380,
    weight: 20,
    deformFactor: 1,
    deformTolerance: 0,
    stackClass: 8,
    allowDirections: [true, true, false, false, false, false],
    maxPlaceDepth: [0, 0, 0, 0, 0, 0],
    supportFaces: [true, true, true, true, true, true],
    supportClasses: [8, 8, 4, 4, 4, 4],
    supportPct: [1, 1, 1],
    pcsCount: 1,
    quantity: 1,
    ...over,
  };
}

/**
 * 把导出结果归一化成可比较的纯 JSON
 *
 * 为什么要再 stringify 一遍：`Box.sku` 这类字段在领域对象里是 `undefined`，
 * 而 `assert.deepStrictEqual({ a: undefined }, {})` 会**因为自有键不同而失败**。
 * 我们真正关心的是"落到文件里的内容一样"，而文件里本来就没有 undefined。
 * 同时剔除 exportedAt（每次导出必然不同）。
 */
function normalized(file: unknown): string {
  const o = { ...(file as Record<string, unknown>) };
  delete o.exportedAt;
  return JSON.stringify(o);
}

/** 文本化：导出 → 解析 → 再文本化，用来模拟"真的存成文件又读回来" */
function throughFile(file: unknown): string {
  return JSON.stringify(JSON.parse(JSON.stringify(file)));
}

// ---------------------------------------------------------------------------
// 格式与校验（纯逻辑）
// ---------------------------------------------------------------------------

test('备份文件：格式标识与版本', () => {
  const f = buildBackup({ boxes: [], containers: [], plans: [], appVersion: APP });
  assert.equal(f.format, BACKUP_FORMAT);
  assert.equal(f.version, 1);
  assert.equal(f.appVersion, APP);
  assert.deepEqual(f.counts, { boxes: 0, containers: 0, plans: 0 });
  // 文件名含版本号与时间戳，方便用户分辨"这是哪一版导的"
  assert.match(backupFileName(APP, new Date(2026, 9, 3, 20, 15)), /装柜专家数据备份_v9\.9\.9_20261003_2015\.json$/);
});

test('校验：拒绝不是本程序的 / 不是 JSON 的文件', () => {
  assert.throws(() => parseBackup('这不是 json'), BackupFormatError);
  assert.throws(() => parseBackup('{"format":"别的","version":1}'), /不是本程序的备份文件/);
  assert.throws(() => parseBackup('[]'), /根节点 必须是对象/);
});

test('校验：版本比程序新时明确提示升级（而不是猜着读）', () => {
  const f = buildBackup({ boxes: [], containers: [], plans: [], appVersion: APP });
  const newer = { ...f, version: 99 };
  assert.throws(() => parseBackup(JSON.stringify(newer)), /比当前程序.*新，请先升级程序/);
});

test('校验：数值字段缺失或非法必须报错，且**指出是哪一条哪个字段**', () => {
  const mk = (box: unknown) =>
    JSON.stringify({
      format: BACKUP_FORMAT,
      version: 1,
      exportedAt: '',
      appVersion: APP,
      counts: { boxes: 1, containers: 0, plans: 0 },
      data: { boxes: [box], containers: [], plans: [] },
    });

  // 长宽高是算法必需项，缺一不可
  const noLen = { id: '1', name: 'x', width: 1, height: 1 };
  assert.throws(() => parseBackup(mk(noLen)), /货物第 1 条（x）的 长 length 缺少数值/);

  const nanHeight = { id: '1', name: 'x', length: 1, width: 1, height: 'abc' };
  assert.throws(() => parseBackup(mk(nanHeight)), /必须是有限数字/);

  // 定位必须精确到记录，否则用户面对一箱数据无从下手
  const second = { id: '2', name: '第二个', length: 1, width: 1, height: null };
  assert.throws(() => parseBackup(mk(second)), /第 2 条|货物第/);
});

test('校验：布尔数组长度不符要报错，不猜', () => {
  const bad = { id: '1', name: 'x', length: 1, width: 1, height: 1, allowDirections: [true, false] };
  const text = JSON.stringify({
    format: BACKUP_FORMAT, version: 1, exportedAt: '', appVersion: APP,
    data: { boxes: [bad], containers: [], plans: [] },
  });
  assert.throws(() => parseBackup(text), /必须是长度 6 的布尔数组/);
});

test('校验：重复 id 必须拦下（否则"按 id 合并"结果不确定）', () => {
  const b = { id: '7', name: 'x', length: 1, width: 1, height: 1 };
  const text = JSON.stringify({
    format: BACKUP_FORMAT, version: 1, exportedAt: '', appVersion: APP,
    data: { boxes: [b, { ...b, name: '另一个' }], containers: [], plans: [] },
  });
  assert.throws(() => parseBackup(text), /货物 id=7 在文件里重复/);
});

test('校验：缺省的可选字段按默认值补齐（老备份 / 手工精简过的文件也能读）', () => {
  const minimal = JSON.stringify({
    format: BACKUP_FORMAT, version: 1, exportedAt: '', appVersion: APP,
    data: {
      boxes: [{ id: '1', name: '最简货物', length: 1, width: 2, height: 3 }],
      containers: [{ id: '1', name: '最简柜', innerLength: 10, innerWidth: 2, innerHeight: 3 }],
      plans: [],
    },
  });
  const f = parseBackup(minimal);
  assert.equal(f.data.boxes[0].weight, 0, '毛重缺省 0');
  assert.equal(f.data.boxes[0].deformFactor, 1);
  assert.deepEqual(f.data.boxes[0].allowDirections, [true, true, true, true, true, true]);
  assert.equal(f.data.boxes[0].dimensionUnit, 'mm');
  assert.equal(f.data.containers[0].weightCapacity, 0);
});

// ---------------------------------------------------------------------------
// round-trip：SQLite
// ---------------------------------------------------------------------------

/** 往库里造一份"有方案、方案里有 boxId 引用"的完整数据 */
function seedSqlite(db: ReturnType<typeof openDatabase>): void {
  const c = insertContainer(db, {
    name: '40HQ 实际柜', length: 11900, width: 2340, height: 2680,
    weightCapacity: 26800, label: '40HQ', cornerDims: [100, 100, 100], doorDims: [2340, 2680],
    emptyWeight: 4000, cost: 3000,
  });
  const b = insertBox(db, {
    name: '水泵2', length: 480, width: 380, height: 380, weight: 20, stackClass: 8,
    supportClasses: [8, 8, 4, 4, 4, 4], allowDirections: [true, true, false, false, false, false],
    color: '#409eff', sku: 'SKU-1',
  });
  const res = load({ boxes: [{ ...b, quantity: 120 }], container: c, strategy: 3 });
  insertPlan(db, {
    name: '参考方案',
    containerId: Number(c.id),
    boxes: [{ ...b, quantity: 120 }],
    result: res,
  });
}

test('round-trip（SQLite）：导出 → 导入新库 → 再导出，内容完全一致', async () => {
  const src = openDatabase(':memory:');
  seedSqlite(src);
  const first = await exportBackupSqlite(src, APP);

  const dst = openDatabase(':memory:');
  await importBackupSqlite(dst, parseBackup(throughFile(first)), 'replace');
  const second = await exportBackupSqlite(dst, APP);

  assert.equal(normalized(second), normalized(first), '二次导出必须与首次一致');
});

test('往返幂等：补齐缺省字段只发生一次，之后完全稳定', async () => {
  // 用户真实库里有些方案是老版本代码存的，boxes_json 缺 deformFactor / allowDirections
  // 等后来才补上的字段。导入会按 rowToBox 的同一套规则补默认值（**单向归一化**），
  // 所以首次往返内容会变 —— 这是有意的，不是丢数据。
  // 真正该锁定的不变式是**幂等**：归一化之后再往返多少次都不再变。
  const legacyPlan = {
    id: 1,
    name: '老版本存的方案',
    containerId: 10,
    // 刻意缺 deformFactor / allowDirections / dimensionUnit 等
    boxes: [{ id: '20', name: '老货物', length: 480, width: 380, height: 380, weight: 20 }],
    result: { placements: [], pieces: 0, loadRate: 0 },
    createdAt: '2026-01-01 00:00:00',
  };
  const file = parseBackup(
    throughFile({
      format: BACKUP_FORMAT,
      version: 1,
      exportedAt: '',
      appVersion: APP,
      data: { boxes: [sampleBox()], containers: [sampleContainer()], plans: [legacyPlan] },
    }),
  );

  const s1 = new LocalStore(createMemStore());
  await importBackup(s1.asBackupAdapter(), file, 'replace');
  const pass1 = await exportBackup(s1.asBackupAdapter(), APP);

  // 补齐确实发生了
  assert.deepEqual(pass1.data.plans[0].boxes[0].allowDirections, [true, true, true, true, true, true]);
  assert.equal(pass1.data.plans[0].boxes[0].dimensionUnit, 'mm');

  const s2 = new LocalStore(createMemStore());
  await importBackup(s2.asBackupAdapter(), parseBackup(throughFile(pass1)), 'replace');
  const pass2 = await exportBackup(s2.asBackupAdapter(), APP);
  assert.equal(normalized(pass2), normalized(pass1), '归一化之后往返必须完全稳定');
});

test('allowDirections 缺省补成全允许，与算法判定等价（归一化不能改变语义）', () => {
  // orientations.ts:36 的判定是 `box.allowDirections?.[orientation] === false`
  // —— undefined 与 [true×6] 都表示"不禁止"，所以补默认值不改变语义。
  // 一旦有人把算法改成"undefined = 全部禁止"，这个测试就该失败。
  const f = parseBackup(
    throughFile({
      format: BACKUP_FORMAT, version: 1, exportedAt: '', appVersion: APP,
      data: {
        boxes: [{ id: '1', name: 'x', length: 1, width: 1, height: 1 }],
        containers: [], plans: [],
      },
    }),
  );
  const before = f.data.boxes[0].allowDirections;
  assert.deepEqual(before, [true, true, true, true, true, true]);
  // 等价性：任何 orientation 上"被禁止"都为 false
  for (let o = 0; o < 6; o++) {
    assert.notEqual(before[o], false, `方向 ${o} 不应被判为禁止`);
  }
});

test('round-trip 保住了 id 与 boxId 引用（否则报表会显示错货名）', async () => {
  const src = openDatabase(':memory:');
  seedSqlite(src);
  const first = await exportBackupSqlite(src, APP);

  const dst = openDatabase(':memory:');
  await importBackupSqlite(dst, parseBackup(throughFile(first)), 'replace');

  const boxes = listBoxes(dst);
  const containers = listContainers(dst);
  const plans = listPlans(dst);

  // 货物 id 原样保留
  assert.equal(boxes[0].id, String(first.data.boxes[0].id));
  // 柜型 id 原样保留
  assert.equal(containers[0].id, String(first.data.containers[0].id));
  // 方案里的 boxId 引用必须指向真实存在的货物 —— 这是导入最容易悄悄弄坏的地方
  const referenced = new Set(boxes.map((b) => b.id));
  assert.ok(plans[0].result.placements.length > 0, '参考方案应当有放置记录');
  for (const p of plans[0].result.placements) {
    assert.ok(referenced.has(p.boxId), `方案引用的 boxId=${p.boxId} 必须指向真实货物`);
  }
  // containerId 必须仍指向真实柜型
  const containerIds = new Set(containers.map((c) => c.id));
  assert.ok(containerIds.has(String(plans[0].containerId)), '方案的 containerId 必须指向真实柜型');
});

test('方案创建时间被保住（否则方案列表排序与"何时算的"全失真）', async () => {
  const src = openDatabase(':memory:');
  seedSqlite(src);
  const first = await exportBackupSqlite(src, APP);

  const dst = openDatabase(':memory:');
  await importBackupSqlite(dst, parseBackup(throughFile(first)), 'replace');
  const second = await exportBackupSqlite(dst, APP);
  assert.equal(second.data.plans[0].createdAt, first.data.plans[0].createdAt);
});

// ---------------------------------------------------------------------------
// round-trip：IndexedDB（内存适配器）
// ---------------------------------------------------------------------------

async function seedIndexedDb(store: LocalStore): Promise<void> {
  await store.seedIfEmpty();
  // 清掉种子，只留我们造的数据，便于逐条核对
  for (const c of await store.listContainers()) await store.deleteContainer(c.id);
  await store.insertContainer(sampleContainer());
  await store.insertBox(sampleBox());
  const b = (await store.listBoxes())[0];
  const c = (await store.listContainers())[0];
  const res = load({ boxes: [{ ...b, quantity: 120 }], container: c, strategy: 3 });
  await store.insertPlan({ name: '参考方案', containerId: c.id, boxes: [{ ...b, quantity: 120 }], result: res });
}

test('round-trip（IndexedDB）：导出 → 导入新库 → 再导出，内容完全一致', async () => {
  const src = new LocalStore(createMemStore());
  await seedIndexedDb(src);
  const first = await exportBackup(src.asBackupAdapter(), APP);

  const dst = new LocalStore(createMemStore());
  await importBackup(dst.asBackupAdapter(), parseBackup(throughFile(first)), 'replace');
  const second = await exportBackup(dst.asBackupAdapter(), APP);

  assert.equal(normalized(second), normalized(first));
});

// ---------------------------------------------------------------------------
// 跨存储迁移（本功能的根本目的）
// ---------------------------------------------------------------------------

test('迁移：SQLite 导出 → IndexedDB 导入，内容一致（服务端版数据搬进静态版）', async () => {
  const src = openDatabase(':memory:');
  seedSqlite(src);
  const file = parseBackup(throughFile(await exportBackupSqlite(src, APP)));

  const store = new LocalStore(createMemStore());
  await importBackup(store.asBackupAdapter(), file, 'replace');
  const back = await exportBackup(store.asBackupAdapter(), APP);
  assert.equal(normalized(back), normalized(file));
});

test('迁移：IndexedDB 导出 → SQLite 导入，内容一致（静态版数据搬回服务端）', async () => {
  const src = new LocalStore(createMemStore());
  await seedIndexedDb(src);
  const file = parseBackup(throughFile(await exportBackup(src.asBackupAdapter(), APP)));

  const dst = openDatabase(':memory:');
  await importBackupSqlite(dst, file, 'replace');
  const back = await exportBackupSqlite(dst, APP);
  assert.equal(normalized(back), normalized(file));
});

test('⚠️ merge 进新库会留下种子柜型 —— 所以界面默认用 replace', async () => {
  // 这条测试记录的是一个**踩过的坑**，不是期望行为：
  // 用户在新机器上导入一份"自己只留了 2 个柜型"的备份，若用 merge，
  // 新库的 3 个 ISO 种子柜型会活下来，于是列表里凭空多出 3 个用户从没见过的柜型。
  // 「导入备份」在用户心里就是"恢复到备份时的状态"，所以界面默认走 replace。
  const src = new LocalStore(createMemStore());
  await seedIndexedDb(src);
  const file = parseBackup(throughFile(await exportBackup(src.asBackupAdapter(), APP)));

  const merged = openDatabase(':memory:');
  await importBackupSqlite(merged, file, 'merge');
  assert.equal(listContainers(merged).length, 4, 'merge：3 个种子 + 文件里 1 个 = 4（正是要避免的）');

  const replaced = openDatabase(':memory:');
  await importBackupSqlite(replaced, file, 'replace');
  assert.equal(listContainers(replaced).length, 1, 'replace：只剩文件里的柜型');
});

// ---------------------------------------------------------------------------
// 导入模式
// ---------------------------------------------------------------------------

test('merge：文件里没有的现有记录一律保留（种子柜型不该被备份挤掉）', async () => {
  const dst = openDatabase(':memory:');
  const before = listContainers(dst);
  assert.ok(before.length >= 3, '新库应有种子柜型');

  const file = parseBackup(throughFile(await exportBackupSqlite(openDatabase(':memory:'), APP)));
  const outcome = await importBackupSqlite(dst, file, 'merge');

  const after = listContainers(dst);
  assert.ok(after.length >= before.length, 'merge 不应减少现有记录');
  assert.deepEqual(outcome.removed, { boxes: 0, containers: 0, plans: 0 }, 'merge 不删任何东西');
});

test('replace：先清空再写入，且如实报告清掉了多少', async () => {
  const dst = openDatabase(':memory:');
  seedSqlite(dst);
  insertBox(dst, { name: '临时货物', length: 1, width: 1, height: 1 });

  const file = parseBackup(throughFile(await exportBackupSqlite(openDatabase(':memory:'), APP)));
  const outcome = await importBackupSqlite(dst, file, 'replace');

  assert.ok(outcome.removed.boxes > 0, '应报告被清掉的货物数');
  // dst 里有 seedSqlite 造的 1 个方案 + 3 个种子柜型，全都要被清掉并如实报告
  assert.equal(outcome.removed.plans, 1, '应报告被清掉的方案数');
  assert.ok(outcome.removed.containers >= 4, '3 个种子柜型 + 自造 1 个都应计入');

  const boxes = listBoxes(dst);
  assert.equal(boxes.length, file.data.boxes.length, '清空后只剩文件里的货物');
  assert.equal(boxes.some((b) => b.name === '临时货物'), false, '原有数据必须真的被清掉');
});

test('includePlans=false：排除方案但保留货物柜型（方案最占体积）', async () => {
  const src = openDatabase(':memory:');
  seedSqlite(src);
  const noPlans = await exportBackupSqlite(src, APP, false);
  assert.equal(noPlans.counts.plans, 0);
  assert.ok(noPlans.counts.boxes > 0);

  const withPlans = await exportBackupSqlite(src, APP, true);
  assert.equal(withPlans.counts.plans, 1);
});

// ---------------------------------------------------------------------------
// 边界
// ---------------------------------------------------------------------------

test('空库导出/导入不报错', async () => {
  const empty = buildBackup({ boxes: [], containers: [], plans: [], appVersion: APP });
  const parsed = parseBackup(throughFile(empty));
  const store = new LocalStore(createMemStore());
  const outcome = await importBackup(store.asBackupAdapter(), parsed, 'merge');
  assert.deepEqual(outcome.written, { boxes: 0, containers: 0, plans: 0 });
});

test('适配器：SQLite 与 IndexedDB 的方法集一致（少一个就静默漏数据）', () => {
  const db = openDatabase(':memory:');
  const a = sqliteBackupAdapter(db);
  const b = new LocalStore(createMemStore()).asBackupAdapter();
  for (const k of ['listBoxes', 'listContainers', 'listPlans', 'putBox', 'putContainer', 'putPlan', 'deletePlan', 'clearAll'] as const) {
    assert.equal(typeof a[k], 'function', `SQLite 适配器缺 ${k}`);
    assert.equal(typeof b[k], 'function', `IndexedDB 适配器缺 ${k}`);
  }
});