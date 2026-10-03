/**
 * 后端 API 冒烟测试（node --test + Fastify inject 注入请求）
 *
 * 覆盖：健康检查、货物 CRUD、柜型 CRUD、装柜计算、方案保存与读取。
 * 使用 :memory: 数据库，避免污染项目数据文件。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.js';
import { openDatabase } from '../src/db/index.js';

let app: FastifyInstance;
let db: ReturnType<typeof openDatabase>;

before(async () => {
  db = openDatabase(':memory:');
  app = buildApp({ db });
  await app.ready();
});

after(async () => {
  await app.close();
  db.close();
});

interface InjectResp {
  statusCode: number;
  json(): any;
}

async function inject(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown): Promise<InjectResp> {
  const res: any = await app.inject({ method, url, payload: payload as any });
  return { statusCode: res.statusCode, json: () => res.json() };
}

test('GET /api/health 返回 ok', async () => {
  const res = await inject('GET', '/api/health');
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, 'ok');
});

// ---------------- 货物 CRUD ----------------
test('货物 CRUD 全链路', async () => {
  // 创建
  const created = await inject('POST', '/api/boxes', {
    name: '测试纸箱',
    length: 600,
    width: 400,
    height: 300,
    weight: 12.5,
    stackClass: 3,
    pcsCount: 4,
  });
  assert.equal(created.statusCode, 201);
  const box = created.json();
  assert.equal(box.name, '测试纸箱');
  assert.equal(box.pcsCount, 4);
  assert.ok(Array.isArray(box.supportClasses) && box.supportClasses.length === 6);
  const boxId = box.id;

  // 列表
  const list = await inject('GET', '/api/boxes');
  assert.equal(list.statusCode, 200);
  assert.ok(list.json().items.some((b: { id: string }) => String(b.id) === String(boxId)));

  // 更新
  const updated = await inject('PUT', `/api/boxes/${boxId}`, { name: '测试纸箱-改', weight: 15 });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().name, '测试纸箱-改');
  assert.equal(updated.json().weight, 15);

  // 删除
  const deleted = await inject('DELETE', `/api/boxes/${boxId}`);
  assert.equal(deleted.statusCode, 204);
  const after = await inject('GET', '/api/boxes');
  assert.ok(!after.json().items.some((b: { id: string }) => String(b.id) === String(boxId)));
});

test('POST /api/boxes 缺必填字段返回 400', async () => {
  const res = await inject('POST', '/api/boxes', { name: '缺尺寸' });
  assert.equal(res.statusCode, 400);
});

// ---------------- 部分更新回归（原缺陷） ----------------
test('PUT 只带部分字段时，未提供的数值字段不被清零', async () => {
  // 回归缺陷：numId(undefined) 返回 0，导致部分更新把缺省数值字段写成 0。
  // 症状：PUT /api/containers/4 {"cost":2800} 会把该柜型的内长/内宽/内高/载重全部清零。
  const created = await inject('POST', '/api/containers', {
    name: '部分更新回归柜',
    length: 13556,
    width: 2352,
    height: 2698,
    weightCapacity: 27600,
    label: 'REGRESS',
  });
  assert.equal(created.statusCode, 201);
  const cid = created.json().id;

  // 只更新 cost，尺寸/载重必须原样保留
  const partial = await inject('PUT', `/api/containers/${cid}`, { cost: 2600 });
  assert.equal(partial.statusCode, 200);
  const after = partial.json();
  assert.equal(after.cost, 2600, 'cost 应被更新');
  assert.equal(after.innerLength, 13556, 'innerLength 不应被清零');
  assert.equal(after.innerWidth, 2352, 'innerWidth 不应被清零');
  assert.equal(after.innerHeight, 2698, 'innerHeight 不应被清零');
  assert.equal(after.weightCapacity, 27600, 'weightCapacity 不应被清零');
  assert.equal(after.label, 'REGRESS', 'label 不应被清空');

  // 货物同理：只更新 weight，尺寸与型变参数必须保留
  const box = (await inject('POST', '/api/boxes', {
    name: '部分更新回归箱',
    length: 500,
    width: 400,
    height: 300,
    weight: 18,
    deformFactor: 0.95,
    deformTolerance: 0.05,
    color: '#5470c6',
    netWeight: 16.5,
    pcsCount: 4,
  })).json();
  const bPartial = await inject('PUT', `/api/boxes/${box.id}`, { weight: 19.5 });
  assert.equal(bPartial.statusCode, 200);
  const bAfter = bPartial.json();
  assert.equal(bAfter.weight, 19.5, 'weight 应被更新');
  assert.equal(bAfter.length, 500, 'length 不应被清零');
  assert.equal(bAfter.width, 400, 'width 不应被清零');
  assert.equal(bAfter.height, 300, 'height 不应被清零');
  assert.equal(bAfter.deformFactor, 0.95, 'deformFactor 不应被清零');
  assert.equal(bAfter.deformTolerance, 0.05, 'deformTolerance 不应被清零');
  assert.equal(bAfter.pcsCount, 4, 'pcsCount 不应被清零');
  assert.equal(bAfter.color, '#5470c6', 'color 不应被清空');
  assert.equal(bAfter.netWeight, 16.5, 'netWeight 不应被清零');
});

// ---------------- 新增字段（#2/#3/#4/#7 字段补齐） ----------------
test('货物六向与型变字段可写可读（数组原样往返）', async () => {
  const allow = [true, false, true, true, true, true];
  const faces = [true, true, false, true, true, true];
  const cls = [3, 0, 3, 3, 3, 3];
  const depth = [0, 3, 0, 0, 0, 0];
  const pct: [number, number, number] = [1, 0.8, 1];

  const created = await inject('POST', '/api/boxes', {
    name: '六向字段箱',
    length: 500,
    width: 400,
    height: 300,
    weight: 18,
    deformFactor: 0.95,
    deformTolerance: 0.05,
    allowDirections: allow,
    supportFaces: faces,
    supportClasses: cls,
    maxPlaceDepth: depth,
    supportPct: pct,
  });
  assert.equal(created.statusCode, 201);
  assert.deepEqual(created.json().allowDirections, allow, 'POST 应原样返回 allowDirections');
  assert.deepEqual(created.json().supportFaces, faces, 'POST 应原样返回 supportFaces');
  assert.deepEqual(created.json().supportClasses, cls, 'POST 应原样返回 supportClasses');
  assert.deepEqual(created.json().maxPlaceDepth, depth, 'POST 应原样返回 maxPlaceDepth');
  assert.deepEqual(created.json().supportPct, pct, 'POST 应原样返回 supportPct');

  const id = created.json().id;
  // 全量更新一次（模拟前端表单保存），数组不应错位或串值
  const saved = await inject('PUT', `/api/boxes/${id}`, {
    name: '六向字段箱-改',
    length: 500,
    width: 400,
    height: 300,
    weight: 18,
    deformFactor: 0.95,
    deformTolerance: 0.05,
    allowDirections: allow,
    supportFaces: faces,
    supportClasses: cls,
    maxPlaceDepth: depth,
    supportPct: pct,
  });
  assert.equal(saved.statusCode, 200);
  const s = saved.json();
  assert.deepEqual(s.allowDirections, allow, 'PUT 后 allowDirections 不应被改写');
  assert.deepEqual(s.supportFaces, faces, 'PUT 后 supportFaces 不应被改写');
  assert.deepEqual(s.supportClasses, cls, 'PUT 后 supportClasses 不应被改写');
  assert.deepEqual(s.maxPlaceDepth, depth, 'PUT 后 maxPlaceDepth 不应被改写');
  assert.deepEqual(s.supportPct, pct, 'PUT 后 supportPct 不应被改写');

  // 重新读库确认已落盘
  const listed = (await inject('GET', '/api/boxes')).json().items.find((b: { id: string }) => String(b.id) === String(id));
  assert.deepEqual(listed.allowDirections, allow, '落盘后 allowDirections 应一致');
  assert.deepEqual(listed.supportClasses, cls, '落盘后 supportClasses 应一致');
});

test('柜型结构与商务字段可写可读（角件/门/自重/成本/单位）', async () => {
  const created = await inject('POST', '/api/containers', {
    name: '结构字段柜',
    length: 13556,
    width: 2352,
    height: 2698,
    weightCapacity: 27600,
    label: '45HQ',
    description: '45 尺高柜',
    cornerDims: [178, 162, 118],
    doorDims: [2340, 2550],
    emptyWeight: 3900,
    cost: 2500,
    unit: '柜',
    dimensionUnit: 'mm',
    weightUnit: 'kg',
  });
  assert.equal(created.statusCode, 201);
  const c = created.json();
  assert.deepEqual(c.cornerDims, [178, 162, 118], 'cornerDims 应原样返回');
  assert.deepEqual(c.doorDims, [2340, 2550], 'doorDims 应原样返回');
  assert.equal(c.emptyWeight, 3900);
  assert.equal(c.cost, 2500);
  assert.equal(c.unit, '柜');

  // 部分更新：改 cost，其余结构字段必须保留
  const partial = await inject('PUT', `/api/containers/${c.id}`, { cost: 2800 });
  const p = partial.json();
  assert.equal(p.cost, 2800);
  assert.deepEqual(p.cornerDims, [178, 162, 118], '部分更新后 cornerDims 应保留');
  assert.deepEqual(p.doorDims, [2340, 2550], '部分更新后 doorDims 应保留');
  assert.equal(p.emptyWeight, 3900, '部分更新后 emptyWeight 应保留');
  assert.equal(p.description, '45 尺高柜', '部分更新后 description 应保留');
});

// ---------------- 柜型 CRUD ----------------
test('柜型种子数据存在 20GP/40GP/40HQ 且可 CRUD', async () => {
  const list = await inject('GET', '/api/containers');
  assert.equal(list.statusCode, 200);
  const items = list.json().items;
  const labels = items.map((c: { label?: string }) => c.label);
  assert.ok(labels.includes('20GP') && labels.includes('40GP') && labels.includes('40HQ'));

  const created = await inject('POST', '/api/containers', {
    name: '45 尺高柜',
    length: 13556,
    width: 2352,
    height: 2698,
    weightCapacity: 30000,
    label: '45HQ',
  });
  assert.equal(created.statusCode, 201);
  const cid = created.json().id;

  const updated = await inject('PUT', `/api/containers/${cid}`, { label: '45HC', weightCapacity: 32000 });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().label, '45HC');
  assert.equal(updated.json().weightCapacity, 32000);

  const deleted = await inject('DELETE', `/api/containers/${cid}`);
  assert.equal(deleted.statusCode, 204);
});

// ---------------- 脏数据防御 ----------------
test('布尔数组列混入数字/错误长度时归一化，不静默算错装载率', async () => {
  // 回归背景：库里出现过 allow_directions = [true,true,1,1,1,1]（布尔数组混进数字）。
  // JSON.parse 不报错，数字原样进算法；方向判定用 `=== false`，`0` 会被误当成"未禁止"，
  // 装载率被静默算错且无任何报错。
  const created = await inject('POST', '/api/boxes', {
    name: '脏数据箱',
    length: 500, width: 400, height: 300, weight: 20,
    stackClass: 3,
    supportClasses: [5, 0, 5, 5, 5, 5],
    allowDirections: [true, false, true, true, true, true],
  });
  const id = Number(created.json().id);
  assert.deepEqual(created.json().allowDirections, [true, false, true, true, true, true], '正常值应原样往返');

  // 绕过 API 直接写脏值，模拟历史上出现过的库损坏
  db.prepare('UPDATE boxes SET allow_directions=?, support_faces=?, support_stack_class=? WHERE id=?').run(
    JSON.stringify([true, true, 1, 0, 1, 1]), // 布尔数组混进 1 和 0
    JSON.stringify([true, true]), // 长度不足
    JSON.stringify([5, 0, 5]), // 长度不足
    id,
  );

  const listed = (await inject('GET', '/api/boxes')).json().items.find((b: { id: string }) => String(b.id) === String(id));
  // 1 → true（允许）；0 → false（禁止）。若不归一化，0 会因 `!== false` 被误当成允许。
  assert.deepEqual(listed.allowDirections, [true, true, true, false, true, true], '布尔数组中的 0 必须归一化为 false');
  assert.equal(listed.allowDirections.every((v: unknown) => typeof v === 'boolean'), true, '归一化后必须是纯布尔');
  // 长度不符应整体回退默认，而不是截断
  assert.deepEqual(listed.supportFaces, [true, true, true, true, true, true], '长度不足应回退默认全允许');
  assert.deepEqual(listed.supportClasses, [5, 5, 5, 5, 5, 5], '长度不足应回退默认承托级别');

  // 归一化后的方向限制必须真的进算法
  const containers = (await inject('GET', '/api/containers')).json().items;
  const container = containers.find((c: { label: string }) => c.label === '40HQ');
  const calc = await inject('POST', '/api/plans/calculate', {
    containerId: container.id,
    items: [{ boxId: id, qty: 400 }],
    strategy: 5,
  });
  const dirs = new Set(calc.json().placements.map((p: { orientation: number }) => p.orientation));
  assert.ok(!dirs.has(3), '被归一化为「禁止」的 dir3 不应出现在结果中');

  await inject('DELETE', `/api/boxes/${id}`);
});

test('柜型内尺寸必须符合 ISO（40HQ 早期误抄 40GP 的长度）', async () => {
  const items = (await inject('GET', '/api/containers')).json().items;
  const byLabel = Object.fromEntries(items.map((c: { label: string }) => [c.label, c]));
  // ISO 内尺寸 mm
  const expect: Record<string, [number, number, number]> = {
    '20GP': [5898, 2352, 2393],
    '40GP': [12032, 2352, 2393],
    '40HQ': [13556, 2352, 2698],
  };
  for (const [label, [l, w, h]] of Object.entries(expect)) {
    const c = byLabel[label];
    assert.ok(c, `应有 ${label} 柜型`);
    assert.deepEqual(
      [c.innerLength, c.innerWidth, c.innerHeight],
      [l, w, h],
      `${label} 内尺寸应为 ${l}×${w}×${h}，实际 ${c.innerLength}×${c.innerWidth}×${c.innerHeight}`,
    );
  }
  // 高柜比标准柜长 1524mm，不只是加高
  assert.equal(
    byLabel['40HQ'].innerLength - byLabel['40GP'].innerLength,
    1524,
    '40HQ 内长应比 40GP 多 1524mm',
  );
});

// ---------------- 装柜计算 ----------------
test('POST /api/plans/calculate 返回合理结果', async () => {
  // 准备货物
  const b1 = (await inject('POST', '/api/boxes', { name: '标准纸箱', length: 600, width: 400, height: 300, weight: 15 })).json();
  const b2 = (await inject('POST', '/api/boxes', { name: '小木箱', length: 300, width: 300, height: 300, weight: 8 })).json();
  // 取 20GP 柜（种子第一条）
  const containers = (await inject('GET', '/api/containers')).json().items;
  const container = containers.find((c: { label: string }) => c.label === '20GP');

  const res = await inject('POST', '/api/plans/calculate', {
    containerId: container.id,
    items: [
      { boxId: b1.id, qty: 120 },
      { boxId: b2.id, qty: 60 },
    ],
    strategy: 3,
  });
  assert.equal(res.statusCode, 200);
  const result = res.json();

  // 装载率正常区间
  assert.ok(result.loadRate > 0 && result.loadRate <= 1, `loadRate=${result.loadRate}`);
  // 体积不超柜内容积
  const capacity = container.innerLength * container.innerWidth * container.innerHeight;
  assert.ok(result.usedVolume <= capacity, `usedVolume=${result.usedVolume} capacity=${capacity}`);
  // 重量不超载重
  assert.ok(result.totalWeight <= container.weightCapacity, `totalWeight=${result.totalWeight}`);
  // 放置数量不超过请求量，未装入的进入 rejected
  const placedCount = result.placements.reduce((s: number, p: { count: number }) => s + p.count, 0);
  const requested = 120 + 60;
  assert.ok(placedCount > 0 && placedCount <= requested, `placed=${placedCount} requested=${requested}`);
  assert.ok(Array.isArray(result.rejected), 'rejected 列表存在');
  // 结构完整
  assert.ok(Array.isArray(result.layers));
  assert.equal(typeof result.strategy, 'number');
});

test('POST /api/plans/calculate 柜型不存在返回 404', async () => {
  const res = await inject('POST', '/api/plans/calculate', {
    containerId: 999999,
    items: [{ boxId: 1, qty: 1 }],
  });
  assert.equal(res.statusCode, 404);
});

// ---------------- 方案保存与读取 ----------------
test('方案保存与读取', async () => {
  const b = (await inject('POST', '/api/boxes', { name: '方案货', length: 500, width: 400, height: 350, weight: 20 })).json();
  const containers = (await inject('GET', '/api/containers')).json().items;
  const container = containers.find((c: { label: string }) => c.label === '40HQ');

  const calc = await inject('POST', '/api/plans/calculate', {
    containerId: container.id,
    items: [{ boxId: b.id, qty: 80 }],
    strategy: 3,
  });
  assert.equal(calc.statusCode, 200);
  const result = calc.json();

  const saved = await inject('POST', '/api/plans', {
    name: '混合装柜方案-冒烟',
    containerId: container.id,
    boxes: [{ ...b, quantity: 80 }],
    result,
  });
  assert.equal(saved.statusCode, 201);
  const planId = saved.json().id;

  // 列表含该方案
  const list = await inject('GET', '/api/plans');
  assert.ok(list.json().items.some((p: { id: number }) => p.id === planId));

  // 详情可读且结果一致
  const detail = await inject('GET', `/api/plans/${planId}`);
  assert.equal(detail.statusCode, 200);
  const plan = detail.json();
  assert.equal(plan.name, '混合装柜方案-冒烟');
  assert.equal(plan.containerId, Number(container.id));
  assert.equal(plan.result.loadRate, result.loadRate);
  assert.equal(plan.result.placements.length, result.placements.length);

  // 删除
  const deleted = await inject('DELETE', `/api/plans/${planId}`);
  assert.equal(deleted.statusCode, 204);
  const gone = await inject('GET', `/api/plans/${planId}`);
  assert.equal(gone.statusCode, 404);
});

// ---------------- 统一错误处理 ----------------
test('未知路由返回 JSON 错误而非 HTML', async () => {
  const res = await inject('GET', '/api/nope');
  // Fastify 对未注册路由默认 404 Not Found（JSON）
  assert.ok(res.statusCode === 404);
});
