/**
 * 静态版冒烟验证页（配合 dev-static-check.html 使用）
 *
 * ## 它补的是什么验证空缺
 *
 * 三层验证各管一段，缺一不可：
 *
 * | 层 | 手段 | 能证明什么 | 不能证明什么 |
 * |---|---|---|---|
 * | 单元测试 | `createLocalApi(memStore)` | 业务逻辑与算法正确 | 没碰过真 IndexedDB，没在浏览器跑过 |
 * | 产物扫描 | `check-static-bundle.mjs` | 包里没有 Node 代码、算法没被摇掉 | 代码在包里 ≠ 跑得起来 |
 * | **本页** | 真实浏览器 + 真 IndexedDB | 端到端真的算得出数 | — |
 *
 * 前面两层之间有个真实的空档：包都在、测试都过，但**浏览器里一算就报错**。
 * 这类故障的特征恰恰是最难在部署前发现的 —— 页面打得开、柜型列表有数据（种子照写），
 * 只在用户点「开始计算」时才炸。
 *
 * 用法（必须带 --mode static，否则验的是服务端版）：
 * ```bash
 * npm run dev:static
 * # 打开 http://localhost:5173/dev-static-check.html
 * ```
 *
 * ## 它会往 IndexedDB 里写临时数据
 *
 * 写完**必定清掉**（try/finally）。但如果你在生产域名上打开过它，
 * 会短暂占用 3 个 id —— 无害，但别在正式使用时开着这个页。
 */
import { createLocalApi } from './api/localClient';
import { IS_STATIC_BUILD } from './api/buildEnv';

const lines: string[] = [];
function p(s: string): void {
  lines.push(s);
  const el = document.getElementById('out');
  if (el) el.textContent = lines.join('\n');
}

async function run(): Promise<void> {
  p(`IS_STATIC_BUILD = ${IS_STATIC_BUILD}  （必须为 true，否则这页验的不是静态版）`);
  p(`typeof indexedDB = ${typeof indexedDB}`);
  if (!IS_STATIC_BUILD) {
    p('!!! 用了 vite 默认 mode，请在启动时加 --mode static');
    return;
  }

  // 用**真实 IndexedDB**（不是内存替身），这样读写路径也一起验了
  const api = createLocalApi();
  p(`api.isLocal = ${api.isLocal}   api.baseURL = ${api.baseURL}`);
  p(`柜型种子数 = ${(await api.listContainers()).length}`);

  // 参考场景：40HQ 实际柜 11900×2340×2680，水泵2 ×630 + 水泵3 ×336 → 966 箱 / 95.96%
  const c = await api.createContainer({
    name: '__冒烟验证柜__',
    innerLength: 11900,
    innerWidth: 2340,
    innerHeight: 2680,
    weightCapacity: 26800,
  });
  const b1 = await api.createBox({
    name: '__水泵2__',
    length: 480, width: 380, height: 380, weight: 20, stackClass: 8,
    supportClasses: [8, 8, 4, 4, 4, 4],
    allowDirections: [true, true, false, false, false, false],
  });
  const b2 = await api.createBox({
    name: '__水泵3__',
    length: 515, width: 380, height: 425, weight: 22, stackClass: 8,
    supportClasses: [8, 8, 0, 0, 0, 0],
    allowDirections: [true, true, false, false, false, false],
  });
  p(`写入成功：柜型 id=${c.id}，货物 id=${b1.id} / ${b2.id}（能拿到自增 id 说明 put 正常）`);

  try {
    const r = await api.calculate({
      containerId: c.id,
      items: [
        { boxId: b1.id, qty: 630 },
        { boxId: b2.id, qty: 336 },
      ],
      strategy: 3,
    });
    const pct = (r.loadRate * 100).toFixed(2);
    p(`计算结果：${r.pieces} 箱 / 装载率 ${pct}% / 策略 ${r.strategy} / 未装 ${r.unplaced?.length ?? 0} 项`);
    p(r.pieces === 966 && Math.abs(r.loadRate - 0.9596) < 0.0001
      ? '=== 通过：与现场核对的目标值（966 箱 / 95.96%）一致 ==='
      : '=== 失败：与目标 966 / 95.96% 不符 ===');

    // 多柜计算也走一遍（另一条算法入口）
    const m = await api.calculateMulti({
      containerId: c.id,
      items: [{ boxId: b1.id, qty: 3000 }],
      strategy: 3,
    });
    p(`多柜循环：${m.plans.length} 个柜，总体装载率 ${(m.overallRate * 100).toFixed(2)}%`);

    // 方案落库 → 读回（验证 JSON 序列化往返）
    const saved = await api.createPlan({ name: '__冒烟验证方案__', containerId: c.id, boxes: [b1, b2], result: r });
    const back = await api.getPlan(saved.id);
    p(`方案往返：id=${back.id} 件数=${back.result.pieces}（应为 ${r.pieces}） 名称=${back.name}`);
    await api.deletePlan(saved.id);

    // ⚠️ 柜型尺寸编辑（用户曾在 GitHub Pages 上报障：保存提示成功但数值不变）
    // 这条必须在**真实浏览器**里跑，因为它是"表单载荷字段名对不对"的问题，
    // 而 Node 侧测的是同一段逻辑；两处都覆盖才不留缺口。
    p(`建柜型：内长 ${c.innerLength}（应为 11900）`);
    const changed = await api.updateContainer(c.id, { innerLength: 12000 });
    p(`改内长为 12000 -> ${changed.innerLength}（应为 12000）`);
    const reread = await api.listContainers();
    p(`列表复查：${reread.find((x) => x.id === c.id)?.innerLength}（应为 12000）`);
    p(
      changed.innerLength === 12000 && reread.find((x) => x.id === c.id)?.innerLength === 12000
        ? '=== 通过：柜型尺寸可修改并已持久化 ==='
        : '=== 失败：柜型尺寸改不动（表单载荷字段名问题）===',
    );

    // 实测案例：IndexedDB 从 v1 升到 v2 新增了 cases 表，这一步同时验两件事 ——
    // 升级没把已有数据搞坏，以及案例的增/改/查在真浏览器里正常
    const before = (await api.listCases()).length;
    const cse = await api.createCase({
      name: '__冒烟验证案例__',
      container: c,
      boxes: [b1],
      strategy: 3,
      computed: { pieces: r.pieces, loadRate: r.loadRate, containers: 1, totalWeight: r.totalWeight, usedVolume: r.usedVolume, allPacked: true, remaining: [] },
      actual: {},
    });
    const withActual = await api.updateCaseActual(cse.id, { pieces: 900, note: '__冒烟__' });
    const after = await api.listCases();
    p(`案例往返：新增后共 ${after.length} 条（改前 ${before}），补录实测 ${withActual.actual.pieces} 箱`);
    p(`算法输出未被改动：${withActual.computed.pieces}（应为 ${r.pieces}）`);
    p(
      after.some((x) => x.id === cse.id) && withActual.computed.pieces === r.pieces
        ? '=== 通过：实测案例可增改查，且 computed 不可变 ==='
        : '=== 失败：实测案例异常 ===',
    );
    await api.deleteCase(cse.id);
    p(`清理后剩 ${(await api.listCases()).length} 条`);
  } finally {
    // 无论成败都清掉，避免污染冒烟验证用户的 IndexedDB
    await api.deleteBox(b1.id);
    await api.deleteBox(b2.id);
    await api.deleteContainer(c.id);
    p('已清理临时数据');
  }
}

run().catch((e: unknown) => p(`!!! 异常：${e instanceof Error ? e.message : String(e)}`));