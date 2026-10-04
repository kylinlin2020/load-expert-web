/**
 * 静态版数据层测试（IndexedDB 换成内存适配器，逻辑代码完全相同）
 *
 * 覆盖：CRUD 语义、与服务端版对齐的映射与归一化、种子规则、
 * 浏览器内跑算法的结果、以及一个真实踩过的 IndexedDB 坑。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemStore } from './helpers/memAdapter.js';
import { createLocalApi } from '../src/web/api/localClient.js';
import { LocalStore, numId } from '../src/web/api/localStore.js';
import { parseBoolArr, SEED_CONTAINERS } from '../src/model/rowMapping.js';

function api() {
  return createLocalApi(createMemStore());
}

test('种子：首次运行写入三个标准柜型，且与服务端版共用同一份定义', async () => {
  const a = api();
  const cs = await a.listContainers();
  assert.equal(cs.length, SEED_CONTAINERS.length);
  const labels = cs.map((c) => c.label);
  assert.deepEqual(labels, SEED_CONTAINERS.map((s) => s.label));
  // 具体数值也要一致（避免两个版本初始柜型不同）。
  // 三个柜型逐个断言，不只抽查一个 —— 种子是用户实测值，
  // 容易被无意改回 ISO 名义值（5898/12032/13556），三个都要盯着。
  const expect: Record<string, [number, number, number, number]> = {
    '20GP': [5800, 2340, 2380, 21770],
    '40GP': [11900, 2340, 2380, 26800],
    '40HQ': [11900, 2340, 2680, 26800],
  };
  for (const [label, [l, w, h, cap]] of Object.entries(expect)) {
    const c = cs.find((x) => x.label === label);
    assert.ok(c, `种子应包含 ${label}`);
    assert.deepEqual(
      [c.innerLength, c.innerWidth, c.innerHeight, c.weightCapacity],
      [l, w, h, cap],
      `${label} 的种子尺寸/载重应与 SEED_CONTAINERS 一致`,
    );
  }
});

test('种子：柜型表非空就不再写种子（用户删掉后不会被塞回来）', async () => {
  const a = api();
  await a.listContainers();
  for (const c of await a.listContainers()) {
    await a.deleteContainer(c.id);
  }
  assert.equal((await a.listContainers()).length, 0);
  await a.listContainers();
  assert.equal((await a.listContainers()).length, 0, '删光后不应被重新写回种子');
});

test('货物 CRUD：新增 / 读取 / 局部更新 / 删除', async () => {
  const a = api();
  const created = await a.createBox({ name: '测试货', length: 480, width: 380, height: 380, weight: 20, stackClass: 8 });
  assert.ok(created.id);
  assert.equal(created.name, '测试货');

  const list = await a.listBoxes();
  assert.equal(list.length, 1);

  // 只传部分字段：未提供的数值字段不得被清零
  const updated = await a.updateBox(created.id, { color: '#ff0000' });
  assert.equal(updated.color, '#ff0000');
  assert.equal(updated.length, 480, '未提供的 length 应保持原值，不得归零');
  assert.equal(updated.weight, 20);
  assert.equal(updated.name, '测试货');

  await a.deleteBox(created.id);
  assert.equal((await a.listBoxes()).length, 0);
});

test('六向布尔数组：混进数字的脏数据被归一化（与 SQLite 版同一份规则）', async () => {
  const six = [true, true, true, true, true, true];
  // 规则：**只有显式的 false / 0 / null / '' 才算"禁止"**，其余一律算允许。
  // 库里真正的坑是 `0`：方向判定原本用 `=== false`，`0 !== false` → 该方向被误当成"未禁止"，
  // 装载率被静默算错且无任何报错。
  assert.deepEqual(parseBoolArr('[true,true,0,0,0,0]', six), [true, true, false, false, false, false]);
  assert.deepEqual(parseBoolArr('[false,0,null,"",1,1]', six), [false, false, false, false, true, true]);
  // `1` 不是"禁止"，按允许处理（这也是为什么上面的 `[.., 1]` 仍是 true）
  assert.deepEqual(parseBoolArr('[true,true,1,1,1,1]', six), six);
  // 长度不符 / 非法 JSON 一律退回缺省值，不猜
  assert.deepEqual(parseBoolArr('[1,2]', [true, true]), [true, true]);
  assert.deepEqual(parseBoolArr('not json', [false, false]), [false, false]);

  // 端到端：直接往存储塞一条带 0 的脏数据，读出来应是归一化后的
  const store = new LocalStore(createMemStore());
  await store.seedIfEmpty();
  await store.raw().put('boxes', {
    name: '脏数据',
    length: 500, width: 400, height: 300, weight: 10, stack_class: 3,
    allow_directions: '[true,true,0,0,0,0]',
    max_place_depth: '[0,0,0,0,0,0]',
    support_faces: '[true,true,true,true,true,true]',
    support_stack_class: '[5,5,5,5,5,5]',
    support_pct: '[1,1,1]',
    pcs_count: 1, sku: null, batch: null, unit_price: null, unit: null,
    group_name: null, description: null, net_weight: null, color: null,
    dimension_unit: 'mm', weight_unit: 'kg',
    deform_factor: 1, deform_tolerance: 0, created_at: '2026-01-01 00:00:00',
  } as never);
  const box = (await store.listBoxes())[0];
  assert.deepEqual(box.allowDirections, [true, true, false, false, false, false]);
});

test('⚠️ IndexedDB 坑：id 键存在且为 undefined 会被判非法键', async () => {
  // 内存适配器刻意复现了真实 IndexedDB 的这条语义，
  // 因此这个断言能真正挡住"新增时写 id: undefined"这个 bug
  const db = createMemStore();
  await assert.rejects(
    () => db.put('boxes', { id: undefined, name: 'x' } as never),
    /not a valid key/,
  );
  // 业务层必须不写 id 键
  const a = createLocalApi(db);
  const ok = await a.createBox({ name: '正常新增' });
  assert.ok(Number(ok.id) > 0, '领域对象的 id 是字符串形式');
});

test('numId：字符串 id 也能解析（前端 el-select 给的是字符串）', () => {
  assert.equal(numId('3'), 3);
  assert.equal(numId(3), 3);
  assert.equal(numId(undefined), 0);
  assert.equal(numId('abc'), 0);
});

test('方案：按 id 倒序（最近在前），与 SQLite ORDER BY id DESC 一致', async () => {
  const a = api();
  const c = (await a.listContainers())[0];
  const fakeResult = { placements: [], pieces: 0, usedVolume: 0, totalWeight: 0, loadRate: 0 } as never;
  await a.createPlan({ name: '方案A', containerId: c.id, boxes: [], result: fakeResult });
  await a.createPlan({ name: '方案B', containerId: c.id, boxes: [], result: fakeResult });
  const plans = await a.listPlans();
  assert.equal(plans.length, 2);
  assert.equal(plans[0].name, '方案B', '后建的应排在前');
});

test('计算：算法在「浏览器侧」跑通，参考口径 966 箱 / 95.96%', async () => {
  const a = api();
  // 用与服务端测试相同的输入（40HQ + 水泵2 630 + 水泵3 336）
  const hq = await a.createContainer({
    name: '40HQ 实际柜', innerLength: 11900, innerWidth: 2340, innerHeight: 2680, weightCapacity: 26800,
  });
  const wp20 = await a.createBox({
    name: '水泵2', length: 480, width: 380, height: 380, weight: 20, stackClass: 8,
    supportClasses: [8, 8, 4, 4, 4, 4], allowDirections: [true, true, false, false, false, false],
  });
  const wp30 = await a.createBox({
    name: '水泵3', length: 515, width: 380, height: 425, weight: 22, stackClass: 8,
    supportClasses: [8, 8, 0, 0, 0, 0], allowDirections: [true, true, false, false, false, false],
  });

  const r = await a.calculate({
    containerId: hq.id,
    items: [{ boxId: wp20.id, qty: 630 }, { boxId: wp30.id, qty: 336 }],
    strategy: 3,
  });
  assert.equal(r.pieces, 966, '与原软件参考方案一致');
  assert.ok(Math.abs(r.loadRate - 0.9596) < 0.0001, `装载率应约 95.96%，实际 ${(r.loadRate * 100).toFixed(2)}%`);
});

test('计算：校验与错误文案与服务端版一致', async () => {
  const a = api();
  const c = (await a.listContainers())[0];
  await assert.rejects(() => a.calculate({ containerId: 999999, items: [{ boxId: '1', qty: 1 }] }), /container not found/);
  await assert.rejects(() => a.calculate({ containerId: c.id, items: [] }), /items are required/);
  const box = await a.createBox({ name: 'x', length: 1, width: 1, height: 1 });
  await assert.rejects(
    () => a.calculate({ containerId: c.id, items: [{ boxId: box.id, qty: 0 }] }),
    /invalid qty/,
  );
  await assert.rejects(
    () => a.calculate({ containerId: c.id, items: [{ boxId: '888888', qty: 1 }] }),
    /box not found/,
  );
});

test('计算：默认策略为 3（与服务端一致）', async () => {
  const a = api();
  const c = (await a.listContainers())[0];
  const b = await a.createBox({ name: '小箱', length: 200, width: 200, height: 200, weight: 5 });
  const r1 = await a.calculate({ containerId: c.id, items: [{ boxId: b.id, qty: 100 }] });
  const r3 = await a.calculate({ containerId: c.id, items: [{ boxId: b.id, qty: 100 }], strategy: 3 });
  assert.equal(r1.strategy, 3);
  assert.deepEqual(r1.pieces, r3.pieces);
});

test('多柜计算：结果结构与服务端版一致', async () => {
  const a = api();
  const c = (await a.listContainers())[0];
  const b = await a.createBox({ name: '小箱', length: 500, width: 400, height: 300, weight: 10 });
  const m = await a.calculateMulti({ containerId: c.id, items: [{ boxId: b.id, qty: 1200 }], strategy: 3 });
  assert.ok(m.plans.length >= 1);
  assert.equal(m.totalContainers, m.plans.length);
  assert.ok(m.overallRate > 0 && m.overallRate <= 1);
  assert.ok(Array.isArray(m.remaining));
});