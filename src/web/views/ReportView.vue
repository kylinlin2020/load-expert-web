<template>
  <div class="report-page">
    <!-- 屏幕工具条：打印时隐藏 -->
    <div class="report-toolbar no-print">
      <el-radio-group v-model="docKind" size="small">
        <el-radio-button value="report">装柜报表</el-radio-button>
        <el-radio-button value="steps">装柜步骤单</el-radio-button>
        <el-radio-button value="all">报表 + 步骤</el-radio-button>
      </el-radio-group>
      <div class="toolbar-spacer"></div>
      <el-checkbox v-model="autoPrint">打开即打印</el-checkbox>
      <el-button size="small" @click="goBack">返回计算</el-button>
      <el-button size="small" type="primary" :loading="printing" @click="doPrint">
        打印 / 另存为 PDF
      </el-button>
    </div>

    <el-alert
      v-if="!payload"
      class="no-print"
      type="warning"
      show-icon
      :closable="false"
      title="没有可打印的装柜结果"
      description="请先在「装柜计算」页完成一次计算，或从「方案列表」加载一个历史方案。"
    />

    <template v-else>
      <!-- ========== 装柜报表 ========== -->
      <section v-if="docKind !== 'steps'" class="sheet">
        <header class="sheet-head">
          <div class="sheet-title">装柜报表</div>
          <div class="sheet-sub">{{ payload.planName }}<template v-if="payload.multi && (payload.containerTotal ?? 1) > 1"> · 第 {{ (payload.containerIndex ?? 0) + 1 }} / {{ payload.containerTotal }} 柜</template></div>
        </header>

        <h2 class="sec">一、基本信息</h2>
        <table class="kv">
          <tbody>
            <tr><th>方案名称</th><td>{{ payload.planName }}</td><th>柜型</th><td>{{ containerText }}</td></tr>
            <tr><th>柜内尺寸(mm)</th><td>{{ dimsText }}</td><th>载重上限(kg)</th><td>{{ fmt(c?.weightCapacity) }}</td></tr>
            <tr><th>装柜顺序</th><td colspan="3">自下而上；同层{{ payload.doorAtMaxX ? '由柜内深处向门口推进' : '由门口向柜内推进' }}</td></tr>
            <tr><th>计算策略</th><td>策略 {{ r.strategy }} · {{ strategyName(r.strategy) }}</td><th>LP 配比</th><td>{{ r.lpEnabled ? '开启' : '关闭' }}</td></tr>
            <tr><th>门位置约定</th><td colspan="3">{{ payload.doorAtMaxX ? 'x = 最大值的一端' : 'x = 0 的一端' }}（容器模型未记录门位，此为显式约定）</td></tr>
          </tbody>
        </table>

        <h2 class="sec">二、汇总指标</h2>
        <table class="kv">
          <tbody>
            <tr><th>装载率</th><td class="strong">{{ rateText }}</td><th>装入箱数</th><td class="strong">{{ fmt(totalCount) }}</td></tr>
            <tr><th>占用体积(m³)</th><td>{{ (r.usedVolume / 1e9).toFixed(3) }}</td><th>总重量(kg)</th><td>{{ fmt(r.totalWeight, 1) }}</td></tr>
            <tr><th>总件数</th><td>{{ fmt(r.pieces) }}</td><th>实际分层</th><td>{{ layerRows.length }} 层</td></tr>
            <tr><th>柜内容积(m³)</th><td>{{ (containerVol / 1e9).toFixed(3) }}</td><th>剩余容积(m³)</th><td>{{ ((containerVol - r.usedVolume) / 1e9).toFixed(3) }}</td></tr>
          </tbody>
        </table>

        <h2 class="sec">三、装入清单</h2>
        <table class="grid">
          <thead>
            <tr><th>货物名称</th><th>SKU</th><th>单箱尺寸 L×W×H(mm)</th><th class="num">申请数量</th><th class="num">装入箱数</th><th class="num">体积(m³)</th><th class="num">重量(kg)</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in loadSummary" :key="row.boxId">
              <td>{{ row.name }}</td>
              <td>{{ row.sku || '-' }}</td>
              <td>{{ dimsOf(row.boxId) }}</td>
              <td class="num">{{ requestedText(row.boxId) }}</td>
              <td class="num strong">{{ fmt(row.count) }}</td>
              <td class="num">{{ (row.volume / 1e9).toFixed(3) }}</td>
              <td class="num">{{ fmt(row.weight, 1) }}</td>
            </tr>
            <tr class="total">
              <td colspan="4">合计</td>
              <td class="num strong">{{ fmt(totalCount) }}</td>
              <td class="num">{{ (r.usedVolume / 1e9).toFixed(3) }}</td>
              <td class="num">{{ fmt(r.totalWeight, 1) }}</td>
            </tr>
          </tbody>
        </table>

        <section class="shot-sec" :class="{ 'has-shot': !!shot }">
          <h2 class="sec">四、3D 示意图</h2>
          <!--
            3D 示意图：屏幕上放一个**活的** Packing3D（可旋转，选个好角度），
            打印时换成**定格成图片**的那一张。
            不能直接把 WebGL canvas 塞进打印件 —— 各浏览器/显卡驱动对"打印时取 canvas"
            的时序处理不一致，实测会印出空白帧；先定格成 dataURL 存进 <img> 才可靠。
          -->
          <div class="shot-block">
            <div class="shot-live no-print">
              <Packing3D v-if="payload" ref="pack3d" :result="r" :boxes="payload.boxes" />
            </div>
            <div class="shot-print">
              <img v-if="shot" :src="shot" alt="3D 示意图" />
              <div v-else class="shot-empty no-print">3D 尚未生成，点上方「生成 3D 示意图」</div>
            </div>
            <div class="shot-actions no-print">
              <el-button size="small" @click="grabShot">生成 3D 示意图</el-button>
              <!--
                把定格结果也显示在屏幕上：打印走的是"打印时使用的示意图"这张图，
                用户必须能在屏幕上确认它不是空白/不是被切片截断的，
                否则要到 PDF 里才发现问题就晚了。
              -->
              <div v-if="shot" class="shot-preview">
                <div class="shot-preview-label">打印时使用的示意图</div>
                <img :src="shot" alt="示意图预览" />
              </div>
              <span v-else class="shot-hint">在左边转到一个合适的角度，再点「生成」，图片就会更新</span>
            </div>
          </div>
        </section>

        <h2 v-if="layerRows.length" class="sec">五、分层明细</h2>
        <table v-if="layerRows.length" class="grid">
          <thead>
            <tr><th class="num">层</th><th class="num">Z 起(mm)</th><th class="num">Z 止(mm)</th><th class="num">层高(mm)</th><th>各货物箱数</th><th class="num">层箱数</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in layerRows" :key="row.level">
              <td class="num">{{ row.level }}</td>
              <td class="num">{{ fmt(row.zMin) }}</td>
              <td class="num">{{ fmt(row.zMax) }}</td>
              <td class="num">{{ fmt(row.zMax - row.zMin) }}</td>
              <td>{{ row.items.map((i) => `${i.name} ×${i.count}`).join('，') || '-' }}</td>
              <td class="num">{{ fmt(row.totalCount) }}</td>
            </tr>
          </tbody>
        </table>

        <h2 v-if="rejected.length" class="sec">六、未装清单</h2>
        <table v-if="rejected.length" class="grid">
          <thead>
            <tr><th>货物名称</th><th>申请数量</th><th class="num">装入箱数</th><th class="num">未装数量</th><th>原因</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in rejected" :key="row.boxId">
              <td>{{ nameOf(row.boxId) }}</td>
              <td>{{ requestedText(row.boxId) }}</td>
              <td class="num">{{ fmt(loadedOf(row.boxId)) }}</td>
              <td class="num strong">
                <!-- 申请量为「不限」时，"未装数量"没有意义（不装满就是没装完） -->
                <template v-if="requestedOf(row.boxId) === null">—</template>
                <template v-else>{{ fmt(Math.max(0, (requestedOf(row.boxId) as number) - loadedOf(row.boxId))) }}</template>
              </td>
              <td>{{ reasonText(row.reason) }}</td>
            </tr>
          </tbody>
        </table>

        <p class="foot-note">
          说明：装柜顺序的排序规则与姿态命名由本项目自拟（没有权威规范可依）；
          柜门位置在数据模型中未记录，此处为显式可切换的约定。
        </p>
      </section>

      <!-- ========== 装柜步骤单 ========== -->
      <section v-if="docKind !== 'report'" class="sheet">
        <header class="sheet-head">
          <div class="sheet-title">装柜步骤单</div>
          <div class="sheet-sub">{{ payload.planName }}<template v-if="payload.multi && (payload.containerTotal ?? 1) > 1"> · 第 {{ (payload.containerIndex ?? 0) + 1 }} / {{ payload.containerTotal }} 柜</template> · {{ containerText }}</div>
        </header>

        <div class="steps-note">
          按下列顺序逐条摆放：<strong>自下而上</strong>，同层<strong>{{
            payload.doorAtMaxX ? '由柜内深处向门口推进' : '由门口向柜内推进'
          }}</strong>。坐标单位 mm，原点在柜内左后下角（X 沿柜长、Y 沿柜宽、Z 为高度）。
        </div>

        <table class="grid steps">
          <thead>
            <tr>
              <th class="num">步骤</th>
              <th>货物名称</th><th>SKU</th><th>摆放姿态</th>
              <th class="num">单箱占位 X×Y×Z</th><th class="num">件数</th>
              <th class="num">X 起</th><th class="num">X 止</th>
              <th class="num">Y 起</th><th class="num">Y 止</th>
              <th class="num">Z 起</th><th class="num">Z 止</th>
              <th class="num">累计箱数</th><th class="num">累计装载率</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in stepRows" :key="row.step">
              <td class="num strong">{{ row.step }}</td>
              <td>{{ row.name }}</td>
              <td>{{ row.sku || '-' }}</td>
              <td>{{ orientationText(row.orientation) }}</td>
              <td class="num">{{ row.dims.join(' × ') }}</td>
              <td class="num strong">{{ fmt(row.count) }}</td>
              <td class="num">{{ fmt(row.xMin) }}</td>
              <td class="num">{{ fmt(row.xMax) }}</td>
              <td class="num">{{ fmt(row.yMin) }}</td>
              <td class="num">{{ fmt(row.yMax) }}</td>
              <td class="num">{{ fmt(row.zMin) }}</td>
              <td class="num">{{ fmt(row.zMax) }}</td>
              <td class="num">{{ fmt(row.cumCount) }}</td>
              <td class="num">{{ (row.cumRate * 100).toFixed(1) }}%</td>
            </tr>
          </tbody>
        </table>

        <div class="sign-row">
          <span>装柜员：____________</span>
          <span>复核：____________</span>
          <span>日期：____________</span>
        </div>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * 装柜报表 / 装柜步骤单 —— **打印与「另存为 PDF」页面**
 *
 * ## 为什么显式命名
 *
 * App.vue 的 `<KeepAlive :exclude="['ReportView']">` 按**组件名**排除，
 * 而 `<script setup>` 的组件默认是文件推导名、不保证稳定。
 * 这里 `defineOptions` 显式声明，KeepAlive 的排除规则才不会失效
 * （失效的后果是：本页用完返回后，3D 场景与截图一直被缓存占着显存）。
 *
 * ## 为什么用「打印 → 另存为 PDF」而不是前端 PDF 库
 *
 * 试过 jsPDF：PDF 规范没有内置中文字体，jsPDF 要显示中文必须**内嵌一份 CJK 字体**
 * （微软雅黑 TTF 约 19MB，base64 后进 bundle 约 25MB），为一个打印功能付出这种体积不划算。
 * pdfmake / html2canvas 同理：前者同样要内嵌字体，后者只能把页面**栅格化成图片**
 * （文字不可选、文件更大），且都需要新增依赖。
 *
 * 浏览器的「打印 → 另存为 PDF」反而是最优解：
 * - **真矢量文字**，中文用系统字体，天然正确、可选中、可搜索
 * - 表格**跨页自动重复表头**、行不会被拦腰截断（见下方 print CSS）
 * - 零新增依赖，离线可用
 *
 * 代价是：需要用户在打印对话框里选「另存为 PDF」这一档，而不是点一下直接下载。
 * 若后续确实需要"点一下就下载 .pdf"，可以再加 html2canvas + 手写最小 PDF 的栅格化方案，
 * 代价是文字不可选。
 */
import { computed, defineOptions, nextTick, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import Packing3D from '../components/Packing3D.vue';
import { planDoc, containerLabel, clearPlanDoc } from '../store/planDoc';
import { STRATEGY_NAMES } from '../../algorithm/candidate-blocks';
import {
  buildCartons,
  buildLayerRows,
  buildLoadSummary,
  buildStepRows,
  boxMetaOf,
  ORIENTATION_NAMES,
  REASON_LABEL,
} from '../lib/packRows';
import { containerVolume } from '../../algorithm/candidate-blocks';

const router = useRouter();

type DocKind = 'report' | 'steps' | 'all';
const docKind = ref<DocKind>('all');
const autoPrint = ref(false);
const printing = ref(false);

/** 3D 示意图的 Packing3D 实例（用来定格截图） */
const pack3d = ref<InstanceType<typeof Packing3D> | null>(null);
/** 定格后的 PNG dataURL，打印时用它 */
const shot = ref('');

const payload = computed(() => planDoc.current);
const r = computed(() => payload.value?.result ?? null);

const cartons = computed(() => buildCartons(r.value, payload.value?.boxes ?? []));
const loadSummary = computed(() => buildLoadSummary(r.value, payload.value?.boxes ?? []));
const layerRows = computed(() => buildLayerRows(cartons.value, r.value, payload.value?.boxes ?? []));
const stepRows = computed(() =>
  buildStepRows(cartons.value, payload.value?.boxes ?? [], payload.value?.doorAtMaxX ?? true, containerVol.value),
);
const containerVol = computed(() => (r.value ? containerVolume(r.value.container) : 0));

const rejected = computed(() => r.value?.rejected ?? []);

const c = computed(() => r.value?.container);
const containerText = computed(() => (r.value ? containerLabel(r.value) : '-'));
const dimsText = computed(() =>
  c.value ? `${c.value.innerLength} × ${c.value.innerWidth} × ${c.value.innerHeight}` : '-',
);
const rateText = computed(() => `${((r.value?.loadRate ?? 0) * 100).toFixed(2)}%`);
const totalCount = computed(() => (r.value?.placements ?? []).reduce((a, p) => a + p.count, 0));

function fmt(n: number | undefined, digits = 0): string {
  if (n === undefined || !Number.isFinite(n)) return '-';
  return n.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function strategyName(i: number): string {
  return STRATEGY_NAMES[i] ?? '未知策略';
}
function orientationText(o: number): string {
  return ORIENTATION_NAMES[o] ?? `dir${o}`;
}
function reasonText(reason: string): string {
  const known = REASON_LABEL[reason];
  return known ? `${known}（${reason}）` : `${reason}（推断）`;
}
function nameOf(boxId: string): string {
  return boxMetaOf(payload.value?.boxes ?? [], boxId)?.name ?? `货物 ${boxId}`;
}
function dimsOf(boxId: string): string {
  const b = boxMetaOf(payload.value?.boxes ?? [], boxId);
  return b ? `${b.length} × ${b.width} × ${b.height}` : '-';
}
function requestedOf(boxId: string): number | null {
  // 用本次单据携带的"申请数量"，而不是货物主档的 quantity（实测库里是 1）
  // null = 用户留空 = 不限（塞满柜子为止）
  const v = payload.value?.requested?.[boxId];
  return typeof v === 'number' ? v : null;
}
/** 申请数量的表格显示值：不限 vs 具体件数 */
function requestedText(boxId: string): string {
  const v = requestedOf(boxId);
  return v === null ? '不限' : fmt(v);
}
function loadedOf(boxId: string): number {
  return (r.value?.placements ?? []).filter((p) => p.boxId === boxId).reduce((a, p) => a + p.count, 0);
}

function goBack() {
  // 返回时清掉单据：否则下次从菜单直接进 /report 会看到上一次的旧方案
  clearPlanDoc();
  router.push('/calculate');
}

// KeepAlive 按组件名排除本页（见文件头说明），必须显式声明名字
defineOptions({ name: 'ReportView' });

/**
 * 从屏幕上的 3D 面板抓一张图存进 `shot`（打印时用）
 *
 * 要等两帧：Packing3D 的场景构建发生在 onMounted，第一帧可能还没画完箱子。
 * 抓不到就提示而不是静默留空 —— 空白示意图比没有示意图更容易误导现场。
 */
async function grabShot() {
  await nextTick();
  const inst = pack3d.value;
  if (!inst) {
    ElMessage.warning('3D 面板尚未就绪，请稍后再试');
    return;
  }
  // 连等两帧，确保 InstancedMesh 已经提交过一次绘制
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
  const url = inst.capturePNG();
  if (!url || url.length < 200) {
    ElMessage.warning('3D 示意图抓取失败（可能是容器为空或 WebGL 不可用）');
    return;
  }
  shot.value = url;
}

async function doPrint() {
  if (!payload.value) {
    ElMessage.warning('没有可打印的装柜结果');
    return;
  }
  printing.value = true;
  try {
    // 打印前重新抓一次 3D 示意图：用户可能刚在屏幕上转了个角度
    await grabShot();
    // 让首屏内容先渲染出来，再唤起打印（否则部分浏览器会打印到空白页）
    await new Promise((r2) => requestAnimationFrame(() => r2(null)));
    // 打印对话框默认取文档标题作为 PDF 文件名，故临时改成可识别的名字
    const prevTitle = document.title;
    const stamp = new Date().toISOString().slice(0, 10);
    const kindName = docKind.value === 'report' ? '装柜报表' : docKind.value === 'steps' ? '装柜步骤单' : '装柜报表与步骤单';
    document.title = `${kindName}_${payload.value.planName}_${stamp}`;
    // 等一帧让标题生效后再打印
    await new Promise((r2) => setTimeout(r2, 60));
    window.print();
    document.title = prevTitle;
  } finally {
    printing.value = false;
  }
}

onMounted(async () => {
  // 先把 3D 示意图抓好，再（可选）唤起打印 —— 否则打印出来是空的示意图
  if (payload.value) {
    await grabShot();
  }
  if (payload.value && autoPrint.value) {
    void doPrint();
  }
});

// 支持通过 URL query 指定初始内容：?doc=report|steps|all
watch(
  () => router.currentRoute.value.query.doc,
  (q) => {
    if (q === 'report' || q === 'steps' || q === 'all') {
      docKind.value = q;
    }
  },
  { immediate: true },
);
</script>

<style scoped>
.report-page {
  max-width: 1180px;
  margin: 0 auto;
  padding: 12px;
}

/* ── 屏幕工具条 ── */
.report-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  background: #fff;
  border: 1px solid #e6e6e6;
  border-radius: 6px;
  padding: 8px 12px;
  margin-bottom: 12px;
  position: sticky;
  top: 0;
  z-index: 10;
}
.toolbar-spacer {
  flex: 1;
}

/* ── 单据（屏幕上就是一张纸）── */
.sheet {
  background: #fff;
  border: 1px solid #e6e6e6;
  border-radius: 6px;
  padding: 24px 28px;
  margin-bottom: 16px;
}
.sheet-head {
  text-align: center;
  border-bottom: 2px solid #303133;
  padding-bottom: 10px;
  margin-bottom: 14px;
}
.sheet-title {
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 4px;
}
.sheet-sub {
  font-size: 12px;
  color: #606266;
  margin-top: 4px;
}
.sec {
  font-size: 14px;
  font-weight: 600;
  margin: 16px 0 8px;
  padding-left: 8px;
  border-left: 3px solid #409eff;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
th,
td {
  border: 1px solid #dcdfe6;
  padding: 5px 7px;
  text-align: left;
  vertical-align: top;
}
thead th {
  background: #f5f7fa;
  font-weight: 600;
  white-space: nowrap;
}
.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.strong {
  font-weight: 700;
}
tr.total td {
  background: #fafafa;
  font-weight: 600;
}
.steps-note {
  font-size: 12px;
  color: #303133;
  background: #f5f7fa;
  border: 1px solid #e6e6e6;
  border-radius: 4px;
  padding: 8px 10px;
  margin-bottom: 10px;
  line-height: 1.7;
}
.sign-row {
  display: flex;
  gap: 40px;
  margin-top: 18px;
  font-size: 12px;
  color: #303133;
}

/* ── 3D 示意图 ── */
.shot-block {
  border: 1px solid #dcdfe6;
  border-radius: 4px;
  padding: 8px;
}
.shot-live {
  /* 不设固定高度：Packing3D 的 .packing3d-wrap 自带 height:520px，
     这里再压一个 420px 会让它溢出并盖住下面的「生成示意图」那一行。 */
  min-height: 0;
}
.shot-print {
  display: none;
}
.shot-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 6px;
  flex-wrap: wrap;
}
.shot-hint {
  font-size: 11px;
  color: #909399;
}
.shot-preview {
  display: flex;
  align-items: center;
  gap: 8px;
  border-left: 1px solid #e6e6e6;
  padding-left: 12px;
}
.shot-preview-label {
  font-size: 11px;
  color: #909399;
  writing-mode: vertical-rl;
  /* 必须 nowrap：竖排 + 固定 height 会把长标签折成两列，读起来像"图/打印时使用的示意" */
  white-space: nowrap;
  letter-spacing: 1px;
  line-height: 1.1;
}
.shot-preview img {
  height: 100px;
  border: 1px solid #dcdfe6;
  background: #fff;
}
.shot-empty {
  padding: 30px;
  text-align: center;
  color: #909399;
  font-size: 12px;
  background: #f5f7fa;
}
.foot-note {
  margin-top: 14px;
  font-size: 11px;
  color: #909399;
  line-height: 1.7;
  border-top: 1px dashed #dcdfe6;
  padding-top: 8px;
}

/* ───────────── 打印样式 ─────────────
 * 目标：拿到一张 A4、表格跨页自动重复表头、行不被截断的 PDF。
 * 这些是浏览器打印到 PDF 的标准能力，jsPDF 栅格化方案反而做不到。
 */
@page {
  size: A4 portrait;
  margin: 12mm 10mm;
}

@media print {
  .no-print {
    display: none !important;
  }
  .report-page {
    max-width: none;
    margin: 0;
    padding: 0;
  }
  .sheet {
    border: none;
    border-radius: 0;
    padding: 0;
    margin: 0;
    /* 报表与步骤单之间不额外分页，靠 sheet 自身的分页控制 */
    break-inside: auto;
  }
  /* 第二个 sheet（步骤单）另起一页 */
  .sheet + .sheet {
    break-before: page;
  }
  .sheet-head {
    /* 页眉在每页顶部重复不了，但标题块避免被分页切开 */
    break-after: avoid;
  }
  .sec {
    /* 小标题不落在页尾 */
    break-after: avoid;
    page-break-after: avoid;
  }
  thead {
    /* 关键：表头在每一页顶部重复 —— 几十页的步骤单没有表头根本没法看 */
    display: table-header-group;
  }
  tfoot {
    display: table-footer-group;
  }
  tr {
    /* 关键：一行不被拦腰截断到两页 */
    break-inside: avoid;
    page-break-inside: avoid;
  }
  .grid {
    font-size: 10px;
  }
  th,
  td {
    padding: 3px 5px;
  }
  .steps-note,
  .sign-row,
  .foot-note,
  .shot-block {
    break-inside: avoid;
  }
  /* 3D 示意图：屏幕上用活的 canvas，打印时换成定格图 */
  .shot-sec:not(.has-shot) {
    /* 还没抓到图就整节都不印，免得留一个空框 */
    display: none;
  }
  .shot-live {
    display: none;
  }
  .shot-print {
    display: block;
    text-align: center;
  }
  .shot-print img {
    max-width: 100%;
    max-height: 150mm;
    /* 打印默认会省略图片底色，这张图的背景是深色，必须显式保留 */
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  /* 打印时强制显示底色（浏览器默认会省略背景） */
  thead th,
  tr.total td {
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
}
</style>