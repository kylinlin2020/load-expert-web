<template>
  <div class="fb-page">
    <!-- ══════════ 现状 ══════════ -->
    <el-card shadow="never">
      <template #header>当前状态</template>
      <div class="stat-row">
        <div class="stat">
          <div class="stat-num" :class="{ bad: errCount > 0 }">{{ errCount }}</div>
          <div class="stat-label">已捕获错误</div>
        </div>
        <div class="stat">
          <div class="stat-num">{{ diagEntries.length }}</div>
          <div class="stat-label">诊断条目</div>
        </div>
        <div class="stat">
          <div class="stat-num">{{ counts.boxes }}/{{ counts.containers }}/{{ counts.plans }}</div>
          <div class="stat-label">货物/柜型/方案</div>
        </div>
      </div>
      <p class="tip mt12">
        错误与操作轨迹只存在<strong>当前页面的内存</strong>里，刷新或关页即消失 ——
        这是刻意的：静态版的数据本来就在浏览器里，不该再往磁盘上堆没人会看的东西。
        所以发现问题后请<strong>先别刷新</strong>，直接来这一页导出。
      </p>
      <div class="row mt8">
        <el-button size="small" @click="refresh">刷新</el-button>
        <el-button size="small" @click="clearLog">清空轨迹</el-button>
      </div>
    </el-card>

    <!-- ══════════ 方式一：复制 ══════════ -->
    <el-card shadow="never" class="mt16">
      <template #header>方式一：复制诊断信息</template>
      <p class="lead">粘贴到微信 / 邮件发给维护者。<strong>最可靠</strong> —— 不需要任何账号，离线也能用。</p>
      <div class="row">
        <el-button type="primary" @click="copyText">复制纯文本</el-button>
        <el-button @click="downloadJson">下载诊断包（.json）</el-button>
        <span class="hint">诊断包是无损的，含错误堆栈；纯文本便于直接粘贴</span>
      </div>
      <el-collapse class="mt12">
        <el-collapse-item title="预览将要复制的内容" name="preview">
          <pre class="preview">{{ textPreview }}</pre>
        </el-collapse-item>
      </el-collapse>
    </el-card>

    <!-- ══════════ 方式二：GitHub Issue ══════════ -->
    <el-card shadow="never" class="mt16">
      <template #header>方式二：提交 GitHub Issue</template>
      <p class="lead">
        会打开项目的 Issue 页面并<strong>自动填好标题与正文</strong>，你只需补充说明再提交。
        需要有 GitHub 账号；提交后有历史可查，方便跟进。
      </p>
      <el-form label-width="76px">
        <el-form-item label="问题类型">
          <el-select v-model="issueKind">
            <el-option label="功能异常（报错 / 结果不对）" value="bug" />
            <el-option label="界面问题（排版 / 交互）" value="ui" />
            <el-option label="功能建议" value="feature" />
            <el-option label="使用问题（不知道怎么用）" value="howto" />
            <el-option label="其他" value="other" />
          </el-select>
        </el-form-item>
        <el-form-item label="补充说明">
          <el-input
            v-model="issueNote"
            type="textarea"
            :rows="3"
            placeholder="发生了什么、原本以为是什么样。若涉及某个柜型/货物，只写名称即可，不要写客户的真实单号。"
          />
        </el-form-item>
      </el-form>
      <div class="row">
        <el-button type="primary" :disabled="!canOpenIssue" @click="openIssue">
          <el-icon class="mr4"><Link /></el-icon>打开 Issue 页面
        </el-button>
        <el-button link type="primary" @click="copyIssueBody">只复制 Issue 正文</el-button>
        <span class="hint">{{ ISSUE_URL ? '' : '未配置仓库地址，此方式不可用' }}</span>
      </div>
    </el-card>

    <!-- ══════════ 边界说明 ══════════ -->
    <el-card shadow="never" class="mt16">
      <template #header>这些信息里有什么、没有什么</template>
      <div class="tbl-scroll">
        <table class="grid">
          <thead>
            <tr><th style="width: 150px">类别</th><th>内容</th></tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>会包含</strong></td>
              <td>
                应用版本号、构建版本（静态版 / 服务端版）、后端地址、浏览器与系统、屏幕与视口尺寸、
                逻辑核心数、网络状态、<strong>数据条数</strong>（货物/柜型/方案各多少条）、最近的错误堆栈与操作轨迹
              </td>
            </tr>
            <tr>
              <td><strong>不会包含</strong></td>
              <td>
                任何货物名称、SKU、尺寸、重量、柜型尺寸、方案内容、客户单号 ——
                <strong>一个业务字段都没有</strong>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="tip mt12">
        如果问题涉及具体数据（例如某条货物算出来不对），请到「数据备份」页<strong>自己</strong>导出一份 JSON 一并发过来 ——
        那是你的数据，由你决定给不给。诊断包不会替你做这个决定。
      </p>
    </el-card>

    <!-- ══════════ 算法实测反馈 ══════════ -->
    <el-card shadow="never" class="mt16">
      <template #header>算法实测反馈（比界面问题值钱得多）</template>
      <p class="lead">
        如果是<strong>算出来不如预期</strong> —— 比如"同样的柜子和货物，现场实际只装到 N 箱，
        程序算出 M 箱" —— 请到「实测案例」页记录一条。那种数据能直接改进算法，
        而算法是这个软件的核心。界面上那点问题不会。
      </p>
      <div class="row">
        <el-button @click="$router.push('/cases')">去记录一条实测结果</el-button>
        <span class="hint">已有 {{ casesCount }} 条实测案例</span>
      </div>
    </el-card>

    <div class="foot">LoadExpert Web · 意见反馈</div>
  </div>
</template>

<script setup lang="ts">
/**
 * 意见反馈
 *
 * ## 为什么两条路都要
 *
 * 「复制」最可靠 —— 不需要账号、离线可用、不依赖任何外部服务；缺点是要人工转述。
 * 「GitHub Issue」结构化、可追踪，但需要账号。
 * 所以两条都给，让维护者那边收到什么就用什么。
 *
 * ## 刻意不做的
 *
 * - **不接第三方表单服务**：多一个外部依赖，还意味着把诊断信息发给第三方
 * - **不自动附带业务数据**：见页面下方说明。涉及数据时让用户自己去「数据备份」导出
 *
 * Issue 仓库地址走构建期注入（见 `issueRepo`）：不同部署可以指向各自的仓库，
 * 而不是把地址写死在代码里。
 */
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { Link } from '@element-plus/icons-vue';
import api from '../api/client';
import { appVersion } from '../../version';
import { diagLog } from '../lib/diagnostics';
import { buildDiagnosticFile, diagnosticFileName, downloadText } from '../lib/diagnosticFile';
import { ISSUE_URL } from '../lib/issueRepo';

const ISSUE_KIND: Record<string, string> = {
  bug: '功能异常',
  ui: '界面问题',
  feature: '功能建议',
  howto: '使用问题',
  other: '其他',
};

const counts = ref({ boxes: 0, containers: 0, plans: 0, cases: 0 });
const diagEntries = ref<diagLog.list extends never ? never : ReturnType<typeof diagLog.list>>([]);
const issueKind = ref('bug');
const issueNote = ref('');
const casesCount = ref(0);

const errCount = computed(() => diagEntries.value.filter((e) => e.kind === 'error').length);

const textPreview = computed(() =>
  buildDiagnosticFile({ 货物: counts.value.boxes, 柜型: counts.value.containers, 方案: counts.value.plans }).reportText,
);

const canOpenIssue = computed(() => Boolean(ISSUE_URL));

function issueTitle(): string {
  return `[${ISSUE_KIND[issueKind.value] ?? '反馈'}] ${appVersion.version} · ${issueNote.value.trim().split('\n')[0] || '（未填说明）'}`;
}

function issueBody(): string {
  const file = buildDiagnosticFile({
    货物: counts.value.boxes,
    柜型: counts.value.containers,
    方案: counts.value.plans,
    实测案例: casesCount.value,
  });
  const note = issueNote.value.trim() || '（未补充说明）';
  return [
    '## 补充说明',
    '',
    note,
    '',
    '## 诊断信息',
    '',
    '```text',
    file.reportText,
    '```',
    '',
    `> 本报告不含货物名称、尺寸等业务数据。`,
  ].join('\n');
}

function refresh(): void {
  diagEntries.value = diagLog.list();
}

function clearLog(): void {
  diagLog.clear();
  refresh();
  ElMessage.success('已清空');
}

async function copyText(): Promise<void> {
  try {
    await navigator.clipboard.writeText(textPreview.value);
    ElMessage.success('已复制纯文本诊断信息');
  } catch {
    // 剪贴板 API 在非 https 或无权限时不可用 —— 给个可复制的兜底
    ElMessage.warning('浏览器不允许直接写剪贴板，请手动选中下方预览内容复制');
  }
}

function downloadJson(): void {
  const file = buildDiagnosticFile({
    货物: counts.value.boxes,
    柜型: counts.value.containers,
    方案: counts.value.plans,
    实测案例: casesCount.value,
  });
  downloadText(JSON.stringify(file, null, 2), diagnosticFileName(appVersion.version));
  ElMessage.success('诊断包已下载');
}

async function copyIssueBody(): Promise<void> {
  try {
    await navigator.clipboard.writeText(issueBody());
    ElMessage.success('已复制 Issue 正文');
  } catch {
    ElMessage.warning('浏览器不允许直接写剪贴板，请手动复制下方预览内容');
  }
}

function openIssue(): void {
  if (!ISSUE_URL) return;
  const url = `${ISSUE_URL}/issues/new?title=${encodeURIComponent(issueTitle())}&body=${encodeURIComponent(issueBody())}`;
  window.open(url, '_blank', 'noopener');
}

onMounted(async () => {
  refresh();
  try {
    const [boxes, containers, plans] = await Promise.all([api.listBoxes(), api.listContainers(), api.listPlans()]);
    counts.value = { boxes: boxes.length, containers: containers.length, plans: plans.length, cases: casesCount.value };
    if (api.listCases) {
      casesCount.value = (await api.listCases()).length;
      counts.value = { ...counts.value, cases: casesCount.value };
    }
  } catch {
    // 取不到条数不影响反馈 —— 诊断包里那一节会缺，但错误本身已被 recordError 记下
  }
});
</script>

<style scoped>
.fb-page {
  max-width: 900px;
  margin: 0 auto;
  padding: 12px;
}
.mt4 { margin-left: 4px; }
.mr4 { margin-right: 4px; }
.mt8 { margin-top: 8px; }
.mt12 { margin-top: 12px; }
.mt16 { margin-top: 16px; }
.hint { font-size: 12px; color: #909399; }
.row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.stat-row { display: flex; gap: 28px; }
.stat-num {
  font-size: 28px; font-weight: 700; line-height: 1.2;
  font-variant-numeric: tabular-nums;
}
.stat-num.bad { color: #f56c6c; }
.stat-label { font-size: 12px; color: #909399; }
.lead { font-size: 13px; line-height: 1.9; color: #303133; margin: 0 0 10px; }
.preview {
  margin: 0; font-family: ui-monospace, Consolas, monospace; font-size: 12px; line-height: 1.7;
  white-space: pre-wrap; max-height: 340px; overflow: auto;
  background: #f5f7fa; padding: 8px 10px; border-radius: 4px;
}
.tip {
  font-size: 12px; color: #606266; background: #f5f7fa;
  border-left: 3px solid #c0c4cc; padding: 8px 10px; line-height: 1.8; margin: 0;
}
.foot { text-align: center; font-size: 11px; color: #909399; padding: 18px 0 6px; }
table { width: 100%; border-collapse: collapse; font-size: 12.5px; margin: 6px 0; }
th, td { border: 1px solid #dcdfe6; padding: 6px 8px; text-align: left; vertical-align: top; line-height: 1.7; }
thead th { background: #f5f7fa; font-weight: 600; }

@media (max-width: 991px) {
  .stat-row { gap: 20px; }
  .stat-num { font-size: 24px; }
  .fb-page :deep(.el-card__body) { padding: 12px; }
  .row { gap: 8px; }
  .lead { font-size: 12.5px; }
  .tbl-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  table { min-width: 560px; font-size: 12px; }
}
</style>