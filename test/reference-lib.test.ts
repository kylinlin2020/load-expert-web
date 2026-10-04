/**
 * 共享资料库的合并逻辑测试
 *
 * ## 这里最该守住的是什么
 *
 * **本地数据永远不被共享库影响。** 万一这条破了，用户辛辛苦苦录的东西
 * 会被一个网盘上的文件覆盖掉 —— 而那个文件可能是旧的、传错的、甚至空的。
 *
 * 所以本文件里**有一条专门的测试**：用一个"空库"和一个"只剩一条的库"
 * 去合并，断言本地条目一条不少、id 不变、内容不变。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFromLib, mergeAll, mergeWithLib, type ReferencePayload } from '../src/model/referenceLib.js';
import type { Box, Container } from '../src/types/index.js';

interface Item {
  id: string;
  v: string;
}
const localItem = (id: string, v = 'local'): Item => ({ id, v });
const libItem = (id: string, v = 'lib'): Item => ({ id, v });

// ---------------------------------------------------------------------------
// 合并基本行为
// ---------------------------------------------------------------------------

test('库里多出来的条目会追加在本地之后，并被标记', () => {
  const r = mergeWithLib([localItem('1'), localItem('2')], [libItem('9'), libItem('8')], new Set());
  assert.deepEqual(r.items.map((x) => x.id), ['1', '2', '9', '8'], '本地在前、库条目在后');
  assert.deepEqual([...r.libIds].sort(), ['8', '9']);
  assert.equal(isFromLib('9', r.libIds), true);
  assert.equal(isFromLib('1', r.libIds), false);
});

test('同 id 时本地优先（这是"编辑库条目即落到本地"的实现方式）', () => {
  const r = mergeWithLib([localItem('1', '我改过的')], [libItem('1', '库里的')], new Set());
  assert.equal(r.items.length, 1, '不该出现两条同 id');
  assert.equal(r.items[0].v, '我改过的', '本地的版本胜出');
  assert.equal(isFromLib('1', r.libIds), false, '同 id 时不算"来自库"');
});

test('墓碑：删过的库条目不再出现', () => {
  const r = mergeWithLib([localItem('1')], [libItem('9'), libItem('8')], new Set(['9']));
  assert.deepEqual(r.items.map((x) => x.id), ['1', '8']);
  assert.equal(isFromLib('9', r.libIds), false);
});

test('墓碑不影响本地条目（本地有 id=9 时不能被墓碑藏掉）', () => {
  const r = mergeWithLib([localItem('9')], [libItem('9'), libItem('8')], new Set(['9']));
  assert.deepEqual(r.items.map((x) => x.id), ['9', '8'], '本地那条必须还在');
});

test('库为空 / 本地为空都不报错', () => {
  assert.deepEqual(mergeWithLib([], [], new Set()).items, []);
  assert.equal(mergeWithLib([localItem('1')], [], new Set()).items.length, 1);
  assert.equal(mergeWithLib([], [libItem('9')], new Set()).items.length, 1);
});

test('本地顺序保持不变（库里有同 id 时也不能重排）', () => {
  const local = [localItem('3'), localItem('1'), localItem('2')];
  const r = mergeWithLib(local, [libItem('1'), libItem('2'), libItem('7')], new Set());
  assert.deepEqual(r.items.map((x) => x.id), ['3', '1', '2', '7'], '本地三条顺序不变');
});

// ---------------------------------------------------------------------------
// 最重要的一条：本地永不被破坏
// ---------------------------------------------------------------------------

test('最坏情况：库被清空 / 变旧，本地一条不少、内容不变', () => {
  const local = [localItem('1', 'A'), localItem('2', 'B'), localItem('3', 'C')];
  // 三种"坏库"依次尝试
  const badLibs: Item[][] = [
    [],                                   // 清空
    [libItem('2', '库的旧版本')],          // 同 id 但内容更旧
    [libItem('99', '不相关')],            // 完全不同的内容
  ];
  for (const lib of badLibs) {
    const r = mergeWithLib(local, lib, new Set());
    const kept = r.items.filter((x) => ['1', '2', '3'].includes(x.id));
    assert.equal(kept.length, 3, `本地条目被丢了：库=${JSON.stringify(lib)}`);
    assert.deepEqual(kept.map((x) => x.v), ['A', 'B', 'C'], `本地内容被改了：库=${JSON.stringify(lib)}`);
  }
});

test('墓碑名单异常（删掉了不该删的）也不影响本地', () => {
  const local = [localItem('1'), localItem('2')];
  const r = mergeWithLib(local, [libItem('9')], new Set(['1', '2', '9']));
  assert.deepEqual(r.items.map((x) => x.id), ['1', '2'], '本地全部保留，库里的被藏掉');
});

// ---------------------------------------------------------------------------
// mergeAll：柜型 + 货物两组一起算
// ---------------------------------------------------------------------------

const C = (id: string, name: string): Container => ({
  id, name, innerLength: 11900, innerWidth: 2340, innerHeight: 2680, weightCapacity: 26800,
});
const B = (id: string, name: string): Box => ({
  id, name, length: 480, width: 380, height: 380, weight: 20,
  stackClass: 8, supportClasses: [8, 8, 4, 4, 4, 4], supportPct: [1, 1, 1], pcsCount: 1, quantity: 1,
});

test('mergeAll：两组独立标记，互不串', () => {
  const lib: ReferencePayload = {
    boxes: [B('100', '库货物')],
    containers: [C('200', '库柜型')],
    exportedAt: '2026-10-04T00:00:00.000Z',
  };
  const r = mergeAll(
    { boxes: [B('1', '本货物')], containers: [C('2', '本柜型')] },
    lib,
    { boxIds: new Set(), containerIds: new Set() },
  );
  assert.deepEqual(r.boxes.map((x) => x.id), ['1', '100']);
  assert.deepEqual(r.containers.map((x) => x.id), ['2', '200']);
  assert.equal(isFromLib('100', r.marks.boxIds), true);
  assert.equal(isFromLib('200', r.marks.containerIds), true);
  // 关键：id 空间独立，货物标记不能污染柜型标记
  assert.equal(isFromLib('100', r.marks.containerIds), false);
  assert.equal(isFromLib('200', r.marks.boxIds), false);
});

test('mergeAll：墓碑分两组生效', () => {
  const lib: ReferencePayload = { boxes: [B('100', 'x')], containers: [C('200', 'y')] };
  const r = mergeAll(
    { boxes: [], containers: [] },
    lib,
    { boxIds: new Set(['100']), containerIds: new Set() },
  );
  assert.deepEqual(r.boxes.map((x) => x.id), [], '货物被墓碑藏掉');
  assert.deepEqual(r.containers.map((x) => x.id), ['200'], '柜型不受影响');
});

test('mergeAll：本地缺 boxes/containers 字段时按空处理，不抛异常', () => {
  // 远端文件被人手改坏是常态，不能让整页白屏
  const r = mergeAll(
    { boxes: [B('1', 'a')], containers: [] },
    { boxes: undefined as never, containers: undefined as never },
    { boxIds: new Set(), containerIds: new Set() },
  );
  assert.deepEqual(r.boxes.map((x) => x.id), ['1']);
  assert.deepEqual(r.containers, []);
});
