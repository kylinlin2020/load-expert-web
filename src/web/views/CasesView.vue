<template>
  <div class="cases-page">
    <!-- ══════════ 总览 ══════════ -->
    <el-card shadow="never">
      <template #header>实测反馈总览</template>
      <p class="lead">
        这里记录的是<strong>「算法算出来多少」与「现场实际装了多少」的对照</strong>。
        界面上点哪里不舒服，改改就有；但这类数据能直接改进算法 ——
        而算法是这个软件的核心。所以现场装柜有偏差时，请顺手记一条。
      </p>
      <div class="stat-row">
        <div class="stat">
          <div class="stat-num">{{ sum.total }}</div>
          <div class="stat-label">案例总数</div>
        </div>
        <div class="stat">
          <div class="stat-num">{{ sum.withActual }}</div>
          <div class="stat-label">已填实测</div>
        </div>
        <div class="stat">
          <div class="stat-num" :class="{ bad: sum.overestimated > 0 }">{{ sum.overestimated }}</div>
          <div class="stat-label">算法高估</div>
        </div>
        <div class="stat">
          <div class="stat-num good">{{ sum.underestimated }}</div>
          <div class="stat-label">算法保守</div>
        </div>
        <div class="stat">
          <div class="stat-num">{{ sum.avgDeltaPct === undefined ? '—' : pct(sum.avgDeltaPct) }}</div>
          <div class="stat-label">平均偏差</div>
        </div>
      </div>
      <el-alert
        v-if="sum.overestimated > 0"
        class="mt12"
        type="warning"
        show-icon
        :closable="false"
        title="存在算法高估装柜能力的案例"
        description="算出比现场实际多的意思是：程序给出的方案在现场装不下。这是**最需要警惕**的方向 —— 高估的方案发出去是要出事的。请优先核对这类案例的货物尺寸与摆放限制是否录入正确。"
      />
    </el-card>

    <!-- ══════════ 列表 ══════════ -->
    <el-card shadow="never" class="mt16">
      <template #header>案例列表</template>
      <div class="tbl-scroll">
        <table class="grid">
          <thead>
            <tr>
              <th>案例</th>
              <th>柜型</th>
              <th class="num">算出</th>
              <th class="num">现场</th>
              <th class="num">偏差</th>
              <th>备注</th>
              <th style="width: 130px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="cases.length === 0">
              <td colspan="7" class="empty">还没有记录。到「装柜计算」页算一次，点「记录为实测案例」。</td>
            </tr>
            <tr v-for="c in sorted" :key="c.id">
              <td>
                <div class="c-name">{{ c.name }}</div>
                <div class="c-sub">{{ c.createdAt }} · 策略 {{ c.strategy }}</div>
              </td>
              <td class="nowrap">
                {{ c.container.label || c.container.name }}
                <div class="c-sub">{{ c.container.innerLength }}×{{ c.container.innerWidth }}×{{ c.container.innerHeight }}</div>
              </td>
              <td class="num">
                {{ c.computed.pieces }} 箱
                <div class="c-sub">{{ c.computed.containers }} 柜 / {{ pct(c.computed.loadRate * 100) }}</div>
              </td>
              <td class="num">
                <template v-if="analyze(c).actualPieces !== undefined">
                  {{ c.actual.pieces }} 箱
                  <div class="c-sub" v-if="c.actual.containers !== undefined">{{ c.actual.containers }} 柜</div>
                </template>
                <span v-else class="c-todo">未填</span>
              </td>
              <td class="num">
                <span v-if="deltaOf(c) === undefined" class="c-todo">—</span>
                <span
                  v-else
                  :class="deltaOf(c)! > 0 ? 'bad' : deltaOf(c)! < 0 ? 'good' : 'zero'"
                >{{ signed(deltaOf(c)!) }} 箱</span>
              </td>
              <td class="c-note">{{ c.actual.note || '—' }}</td>
              <td>
                <el-button size="small" @click="openEdit(c)">补录实测</el-button>
                <el-button size="small" type="danger" plain @click="remove(c)">删除</el-button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </el-card>

    <!-- ══════════ 补录 ══════════ -->
    <el-dialog v-model="editVisible" title="补录现场实测" width="520px">
      <el-alert class="mb12" type="info" :closable="false" title="为什么要填这个">
        程序算出 {{ editing?.computed.pieces }} 箱 / {{ editing?.computed.containers }} 柜。
        现场实际装了多少？两者的差就是算法需要改进的地方。
      </el-alert>
      <el-form label-width="88px">
        <el-form-item label="实际箱数">
          <el-input-number v-model="form.pieces" :min="0" :step="10" style="width: 100%" />
        </el-form-item>
        <el-form-item label="实际柜数">
          <el-input-number v-model="form.containers" :min="0" style="width: 100%" />
        </el-form-item>
        <el-form-item label="原因备注">
          <el-input
            v-model="form.note"
            type="textarea"
            :rows="3"
            placeholder="比如：货物有软包，实际压得比标称矮；或现场发现某箱不能倒放。"
          />
        </el-form-item>
      </el-form>
      <el-alert v-if="previewDelta !== undefined" :type="previewDelta > 0 ? 'warning' : 'success'" :closable="false" show-icon>
        偏差：{{ signed(previewDelta) }} 箱（{{ previewDelta > 0 ? '算法高估' : previewDelta < 0 ? '算法保守' : '完全一致' }}）
      </el-alert>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>

    <div class="foot">LoadExpert Web · 实测案例</div>
  </div>
</template>

<script setup lang="ts">
/**
 * 实测案例
 *
 * ## 这个页面存在的理由
 *
 * 之前用户的算法反馈只能靠口头讲，讲完就丢。而"现场装不到程序说的那么多箱"
 * 是**最值钱的一类信息** —— 它直接指出算法在哪种货物/柜型组合下高估了能力。
 *
 * ## 排序按偏差而非时间
 *
 * 需要跟进的排前面：偏差大的最该先看。全对的排最后（说明这种组合算法没问题），
 * 没填实测的排中间（还没产生价值）。
 */
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import api from '../api/client';
import { analyzeCase, casePriority, summarizeCases, type LoadCase } from '../../model/case';

const cases = ref<LoadCase[]>([]);
const editVisible = ref(false);
const editing = ref<LoadCase | null>(null);
const form = ref<{ pieces?: number; containers?: number; note: string }>({ note: '' });

const sum = computed(() => summarizeCases(cases.value));

/** 排序：偏差大的在前；吻合的垫后；未填实测的居中 */
const sorted = computed(() =>
  [...cases.value].sort((a, b) => {
    const pa = casePriority(a);
    const pb = casePriority(b);
    if (pa !== pb) return pa - pb;
    const ma = Math.abs(analyzeCase(a).piecesDelta ?? 0);
    const mb = Math.abs(analyzeCase(b).piecesDelta ?? 0);
    if (ma !== mb) return mb - ma;
    return b.id - a.id;
  }),
);

function analyze(c: LoadCase) {
  return analyzeCase(c);
}
function deltaOf(c: LoadCase): number | undefined {
  return analyzeCase(c).piecesDelta;
}
function pct(v: number): string {
  return `${v.toFixed(1)}%`;
}
function signed(v: number): string {
  return v > 0 ? `+${v}` : String(v);
}

const previewDelta = computed(() => {
  const c = editing.value;
  if (!c || form.value.pieces === undefined) return undefined;
  return c.computed.pieces - form.value.pieces;
});

async function refresh(): Promise<void> {
  cases.value = await api.listCases();
}

function openEdit(c: LoadCase): void {
  editing.value = c;
  form.value = { pieces: c.actual.pieces, containers: c.actual.containers, note: c.actual.note ?? '' };
  editVisible.value = true;
}

async function save(): Promise<void> {
  const c = editing.value;
  if (!c) return;
  try {
    await api.updateCaseActual(c.id, {
      pieces: form.value.pieces,
      containers: form.value.containers,
      note: form.value.note.trim() || undefined,
    });
    ElMessage.success('已记录');
    editVisible.value = false;
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

async function remove(c: LoadCase): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删除案例「${c.name}」？`, '删除案例', { type: 'warning' });
  } catch {
    return;
  }
  await api.deleteCase(c.id);
  ElMessage.success('已删除');
  await refresh();
}

onMounted(refresh);
</script>

<style scoped>
.cases-page { max-width: 1100px; margin: 0 auto; padding: 12px; }
.mt12 { margin-top: 12px; }
.mt16 { margin-top: 16px; }
.mb12 { margin-bottom: 12px; }
.stat-row { display: flex; gap: 26px; flex-wrap: wrap; }
.stat-num { font-size: 26px; font-weight: 700; line-height: 1.2; font-variant-numeric: tabular-nums; }
.stat-num.bad { color: #f56c6c; }
.stat-num.good { color: #67c23a; }
.stat-label { font-size: 12px; color: #909399; }
.lead { font-size: 13px; line-height: 1.9; color: #303133; margin: 0; }
.c-name { font-weight: 600; }
.c-sub { font-size: 11.5px; color: #909399; margin-top: 2px; }
.c-todo { color: #c0c4cc; }
.c-note { font-size: 12px; color: #606266; max-width: 220px; }
.nowrap { white-space: nowrap; }
.empty { text-align: center; color: #909399; padding: 18px 0; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.bad { color: #f56c6c; font-weight: 600; }
.good { color: #67c23a; font-weight: 600; }
.zero { color: #67c23a; }
.foot { text-align: center; font-size: 11px; color: #909399; padding: 18px 0 6px; }

.tbl-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
table.grid { width: 100%; border-collapse: collapse; font-size: 12.5px; }
table.grid th, table.grid td { border: 1px solid #dcdfe6; padding: 6px 8px; text-align: left; vertical-align: top; line-height: 1.6; }
table.grid thead th { background: #f5f7fa; font-weight: 600; white-space: nowrap; }

@media (max-width: 991px) {
  .cases-page { padding: 12px; }
  .cases-page :deep(.el-card__body) { padding: 12px; }
  .stat-row { gap: 18px; }
  .stat-num { font-size: 22px; }
  .lead { font-size: 12.5px; }
  table.grid { min-width: 780px; font-size: 12px; }
}
</style>