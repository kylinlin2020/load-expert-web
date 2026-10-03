/**
 * 回归测试：视图层发给 API 的载荷形状，必须与 ApiShape 声明的一致
 *
 * ## 这个 bug 的性质
 *
 * `ApiShape` 声明的是 `createContainer(c: Partial<Container>)` ——
 * **领域字段名** `innerLength / innerWidth / innerHeight`。
 * 但视图的表单转换发的是 `length / width / height`（SQLite 列名）。
 *
 * 服务端版之所以看起来正常，是因为 `db.ts` 的 `updateContainer` 也恰好收列名 ——
 * **两个错误互相抵消了**。静态版按接口声明实现，于是暴露：
 *   - 改尺寸：`c.innerLength` 为 undefined → `?? cur.innerLength` → **静默改不动**
 *   - 新建柜型：`c.innerLength ?? 0` → **尺寸全是 0**
 *
 * 取消错误不会立刻暴露，这正是它能活到线上被用户发现的原因。
 *
 * ## 关键：测试直接 import 视图用的**真函数**
 *
 * 这段逻辑已抽到 `src/web/lib/containerForm.ts`（`containerFormToPayload`）。
 * 早先这里是**手抄**一份到测试文件里的 —— 那样测试挡不住回归：
 * 视图改了、抄的那份不会跟着改，测试就变成自证清白。
 * 现在 import 真函数，谁改坏谁红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemStore } from './helpers/memAdapter.js';
import { createLocalApi } from '../src/web/api/localClient.js';
import { LocalStore } from '../src/web/api/localStore.js';
import { openDatabase, insertContainer, updateContainer, listContainers } from '../src/db/db.js';
import { exportBackupSqlite } from '../src/db/backup.js';
import { exportBackup } from '../src/model/backupApply.js';
import {
  defaultContainerForm,
  containerFormToPayload,
  containerToForm,
  type ContainerForm,
} from '../src/web/lib/containerForm.js';

/** 用户在弹窗里填的一份表单（尺寸取用户的实测柜型） */
function form(over: Partial<ContainerForm> = {}): ContainerForm {
  return {
    ...defaultContainerForm(),
    name: '测试柜',
    label: 'TEST',
    length: 11900,
    width: 2340,
    height: 2680,
    weightCapacity: 26800,
    ...over,
  };
}

// ---------------------------------------------------------------------------

test('载荷形状：必须是领域名，不能是 SQLite 列名（这条是全部回归的根）', () => {
  const p = containerFormToPayload(form()) as Record<string, unknown>;

  // 领域名必须在
  assert.equal(p.innerLength, 11900);
  assert.equal(p.innerWidth, 2340);
  assert.equal(p.innerHeight, 2680);

  // 列名必须**不在** —— 它一旦出现，静态版就会静默失效（见文件头说明）
  for (const col of ['length', 'width', 'height']) {
    assert.equal(
      p[col],
      undefined,
      `载荷里出现了 SQLite 列名 "${col}"。视图与服务端数据层曾各用一套名字、` +
        `两个错误互相抵消，静态版因此失效。ApiShape 声明的是 Partial<Container>，应以领域名为准。`,
    );
  }
});

test('领域对象 → 表单 → 载荷 往返一次，尺寸必须不变（编辑弹窗打开时不能丢值）', () => {
  const original = {
    id: '7',
    name: '40HQ 实际柜',
    innerLength: 11900,
    innerWidth: 2340,
    innerHeight: 2680,
    weightCapacity: 26800,
    label: '40HQ',
    dimensionUnit: 'mm',
    weightUnit: 'kg',
  } as never;
  const roundTrip = containerFormToPayload(containerToForm(original));
  assert.equal((roundTrip as Record<string, unknown>).innerLength, 11900);
  assert.equal((roundTrip as Record<string, unknown>).innerWidth, 2340);
  assert.equal((roundTrip as Record<string, unknown>).innerHeight, 2680);
  assert.equal((roundTrip as Record<string, unknown>).weightCapacity, 26800);
  assert.equal((roundTrip as Record<string, unknown>).label, '40HQ');
});

test('静态版·新建柜型：视图载荷里的尺寸必须真的落库', async () => {
  const api = createLocalApi(createMemStore());
  const created = await api.createContainer(containerFormToPayload(form()) as never);

  assert.equal(created.innerLength, 11900, `内长应为 11900，实际 ${created.innerLength}`);
  assert.equal(created.innerWidth, 2340, `内宽应为 2340，实际 ${created.innerWidth}`);
  assert.equal(created.innerHeight, 2680, `内高应为 2680，实际 ${created.innerHeight}`);
  assert.equal(created.weightCapacity, 26800);
  assert.equal(created.label, 'TEST');

  // 再读一遍，确认不是只在返回值里对
  const list = await api.listContainers();
  const found = list.find((c) => c.id === created.id);
  assert.equal(found?.innerLength, 11900, '重新读取时内长必须仍是 11900');
});

test('静态版·修改柜型尺寸：保存后必须真的变了（用户报障的原始场景）', async () => {
  const api = createLocalApi(createMemStore());
  const created = await api.createContainer(containerFormToPayload(form()) as never);
  assert.equal(created.innerLength, 11900);

  // 用户在弹窗里把内长改成 12000，其余不动
  const updated = await api.updateContainer(
    created.id,
    containerFormToPayload(form({ name: created.name, label: 'TEST', length: 12000 })) as never,
  );
  assert.equal(updated.innerLength, 12000, `内长应变为 12000，实际 ${updated.innerLength}`);
  assert.equal(updated.innerWidth, 2340, '未修改的字段必须保持原值');
  assert.equal(updated.innerHeight, 2680, '未修改的字段必须保持原值');

  // 关键：列表里也要变（用户正是看列表发现没变的）
  const list = await api.listContainers();
  assert.equal(list.find((c) => c.id === created.id)?.innerLength, 12000, '列表里的值必须已更新');
});

test('静态版·修改载重与标签同样要生效', async () => {
  const api = createLocalApi(createMemStore());
  const created = await api.createContainer(containerFormToPayload(form()) as never);
  const updated = await api.updateContainer(
    created.id,
    containerFormToPayload(form({ weightCapacity: 30000, label: 'NEW', unit: '柜' })) as never,
  );
  assert.equal(updated.weightCapacity, 30000);
  assert.equal(updated.label, 'NEW');
  assert.equal(updated.unit, '柜');
});

test('两套实现对同一份视图载荷必须给出一致结果', async () => {
  const payload = containerFormToPayload(form()) as never;
  const db = openDatabase(':memory:');
  const local = createLocalApi(createMemStore());

  // 服务端侧走 insert/update 的真实实现（即 API 路由内部那条路径）
  const serverCreated = insertContainer(db, payload as never);
  const localCreated = await local.createContainer(payload);

  for (const f of ['innerLength', 'innerWidth', 'innerHeight', 'weightCapacity', 'label'] as const) {
    assert.equal(
      localCreated[f],
      serverCreated[f],
      `新建时两套实现对 ${f} 不一致：静态版 ${String(localCreated[f])} vs 服务端版 ${String(serverCreated[f])}`,
    );
  }

  const changed = containerFormToPayload(form({ name: serverCreated.name, label: 'TEST', length: 12000 })) as never;
  const serverUpdated = updateContainer(db, Number(serverCreated.id), changed as never);
  assert.ok(serverUpdated, '服务端侧 updateContainer 应返回更新后的记录');
  const localUpdated = await local.updateContainer(localCreated.id, changed);

  for (const f of ['innerLength', 'innerWidth', 'innerHeight'] as const) {
    assert.equal(
      localUpdated[f],
      serverUpdated[f],
      `修改时两套实现对 ${f} 不一致：静态版 ${String(localUpdated[f])} vs 服务端版 ${String(serverUpdated[f])}`,
    );
  }
});

test('同一份载荷写进两种存储，导出的柜型记录必须一致', async () => {
  const payload = containerFormToPayload(form()) as never;

  const db = openDatabase(':memory:');
  const created = insertContainer(db, payload as never);
  // 只留下刚插入的这一条。
  // 注意不能写 `id > 1` —— 种子占了 1~3，刚插入的是 4，那样会把目标也删掉。
  db.exec(`DELETE FROM containers WHERE id <> ${Number(created.id)}`);
  assert.equal(listContainers(db).length, 1, '服务端侧应只剩这一条');

  const store = new LocalStore(createMemStore());
  await store.insertContainer(payload as never);

  const fromServer = await exportBackupSqlite(db, 'test', false);
  const fromLocal = await exportBackup(store.asBackupAdapter(), 'test', false);

  // id 可能不同（存储分配不同），比内容不比 id
  const strip = (c: Record<string, unknown>) => {
    const { id: _id, ...rest } = c;
    void _id;
    return JSON.stringify(rest);
  };
  assert.equal(
    strip(fromServer.data.containers[0] as unknown as Record<string, unknown>),
    strip(fromLocal.data.containers[0] as unknown as Record<string, unknown>),
    '导出的柜型内容必须一致，否则用户在不同版本间搬数据会看到字段差异',
  );
});