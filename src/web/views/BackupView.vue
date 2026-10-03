<template>
  <div class="backup-page">
    <!-- ══════════ 数据现状 ══════════ -->
    <el-card shadow="never">
      <template #header>当前数据</template>
      <div class="stat-row">
        <div class="stat">
          <div class="stat-num">{{ counts.boxes }}</div>
          <div class="stat-label">货物</div>
        </div>
        <div class="stat">
          <div class="stat-num">{{ counts.containers }}</div>
          <div class="stat-label">柜型</div>
        </div>
        <div class="stat">
          <div class="stat-num">{{ counts.plans }}</div>
          <div class="stat-label">方案</div>
        </div>
      </div>
      <el-alert
        class="mt12"
        :type="isLocal ? 'error' : 'warning'"
        show-icon
        :closable="false"
        :title="isLocal ? '这些数据只在当前浏览器里，没有服务器副本' : '数据在后端 SQLite 文件里'"
        :description="
          isLocal
            ? '换浏览器、换电脑、换域名都看不到；清除浏览器数据 / 站点数据 / 用无痕窗口都会让它们永久丢失。请定期导出备份。'
            : '文件位于 data/load-expert.db。误删或磁盘损坏即永久丢失，建议定期导出备份存在别处。'
        "
      />
    </el-card>

    <!-- ══════════ 导出 ══════════ -->
    <el-card shadow="never" class="mt16">
      <template #header>导出备份</template>
      <!-- 说明文字放在 checkbox **外面**：
           Element Plus 的 .el-checkbox__label 强制 nowrap，
           长提示塞进去在窄屏会撑出横向滚动条（实测 390px 视口下标签宽 395px） -->
      <div class="row">
        <el-checkbox v-model="includePlans">包含历史方案</el-checkbox>
      </div>
      <p class="hint mt4">方案里存着完整计算结果，是文件里最占体积的部分</p>
      <div class="row mt8">
        <el-button type="primary" :loading="exporting" @click="doExport">
          <el-icon class="mr4"><Download /></el-icon>导出为 JSON 文件
        </el-button>
        <span class="hint">文件名含版本号与时间戳，方便分辨是哪一次导的</span>
      </div>
    </el-card>

    <!-- ══════════ 导入 ══════════ -->
    <el-card shadow="never" class="mt16">
      <template #header>导入备份</template>

      <div class="row">
        <input ref="fileInput" type="file" accept=".json,application/json" class="hidden-input" @change="onFilePicked" />
        <el-button :loading="reading" @click="pickFile">
          <el-icon class="mr4"><Upload /></el-icon>选择备份文件
        </el-button>
        <span v-if="pickedName" class="hint">{{ pickedName }}</span>
      </div>

      <template v-if="preview">
        <el-alert class="mt12" type="info" show-icon :closable="false" title="文件内容">
          <pre class="preview">{{ preview }}</pre>
        </el-alert>

        <el-form label-width="88px" class="mt12">
          <el-form-item label="导入方式">
            <el-radio-group v-model="mode">
              <el-radio value="replace">覆盖恢复</el-radio>
              <el-radio value="merge">合并导入</el-radio>
            </el-radio-group>
          </el-form-item>
          <el-form-item label=" ">
            <div class="mode-desc">{{ MODE_DESC[mode] }}</div>
          </el-form-item>
        </el-form>

        <div class="row mt8">
          <el-button type="warning" :loading="importing" @click="doImport">
            <el-icon class="mr4"><Upload /></el-icon>
            {{ mode === 'replace' ? '覆盖恢复（先自动备份当前数据）' : '合并导入' }}
          </el-button>
          <el-button @click="clearPicked">取消</el-button>
        </div>
      </template>

      <p class="tip mt12">
        <strong>覆盖恢复</strong>会先清空现有数据再写入文件里的内容，
        并<strong>在清空前自动下载一份当前数据</strong>作为退路。
        <strong>合并导入</strong>按 id 对齐：文件里有的覆盖或新增，
        文件里没有的现有记录<strong>一律保留</strong>。
      </p>
    </el-card>

    <!-- ══════════ 跨版本迁移 ══════════ -->
    <el-card shadow="never" class="mt16">
      <template #header>在两个版本之间搬数据</template>
      <p>
        两套构建用的是<strong>同一种备份文件格式</strong>，所以可以互相搬：
      </p>
      <ol class="manual">
        <li>在<strong>有数据的那一套</strong>里点「导出为 JSON 文件」</li>
        <li>在<strong>想要数据的那一套</strong>里打开本页面 → 选择该文件 → 「覆盖恢复」</li>
      </ol>
      <p class="tip">
        例：静态版（数据在浏览器）导出的文件，可以直接导进服务端版（数据在 SQLite）；
        反之亦然。<strong>两边数据不会自动同步</strong>，搬过一次之后就各是各的，
        之后要保持一致就得各自定期导出。
      </p>
      <el-alert
        type="warning"
        show-icon
        :closable="false"
        title="请固定使用同一个访问地址"
        description="数据按「浏览器 + 网址」存放。用 http://localhost:5173 录入、换到 http://192.168.x.x:5173 就看不到那份数据了。"
      />
    </el-card>
  </div>
</template>

<script setup lang="ts">
/**
 * 数据备份 / 恢复
 *
 * ## 为什么这个页面必须显眼
 *
 * 静态版的数据**只在用户自己的浏览器里**（IndexedDB），清除站点数据、
 * 换浏览器、换电脑就没了；服务端版的数据在一个 SQLite 文件里，误删或磁盘损坏也没了。
 * 两种情况都**不可逆**，所以入口放在主菜单里，而不是塞进「应用版本」让人翻找。
 *
 * ## 为什么覆盖导入前要自动下载一份当前数据
 *
 * 覆盖是唯一真正"恢复到某个时刻"的操作，也是唯一会**删除现有数据**的操作。
 * 让用户在点之前不用做任何事，就能拿到一份当前状态的备份 ——
 * 这样即便选错了文件，也还有退路。这类不可逆操作的成本应该由界面承担，
 * 而不是靠一句"你确定吗"。
 *
 * ## 为什么默认是「覆盖恢复」而不是「合并导入」
 *
 * 合并在新库上会出问题（踩过）：用户导出一份"自己只留了 2 个柜型"的备份，
 * 导入到新装的库时，merge 会把新库的 3 个 ISO 种子柜型一并留下，
 * 列表里凭空多出用户从没见过的柜型。
 * 而「导入备份」在用户心里就是"恢复到备份时的状态"，replace 才是那个语义。
 */
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Download, Upload } from '@element-plus/icons-vue';
import api from '../api/client';
import { IS_STATIC_BUILD as isLocalBuild } from '../api/client';
import { parseBackup, describeBackup, backupFileName, type BackupFile, type ImportMode } from '../../model/backup';
import { appVersion } from '../../version';
import type { ImportOutcome } from '../../model/backupApply';

const MODE_DESC: Record<ImportMode, string> = {
  replace:
    '清空现有全部数据，再按文件内容写入。结果与备份文件完全一致。\n' +
    '注意：文件里没有的记录会一并消失 —— 点按钮前会自动下载一份当前数据作为退路。',
  merge:
    '按 id 对齐：文件里有的记录覆盖或新增，文件里没有的现有记录一律保留。\n' +
    '适合往已有数据里补充内容。但在新库上会用 merge 时，种子柜型会混进来。',
};

const counts = ref({ boxes: 0, containers: 0, plans: 0 });
const exporting = ref(false);
const importing = ref(false);
const reading = ref(false);
const includePlans = ref(true);
const mode = ref<ImportMode>('replace');
const pickedName = ref('');
const pickedText = ref('');
const preview = ref('');
const fileInput = ref<HTMLInputElement | null>(null);
const file = ref<BackupFile | null>(null);

const isLocal = isLocalBuild;

async function refreshCounts(): Promise<void> {
  const [boxes, containers, plans] = await Promise.all([api.listBoxes(), api.listContainers(), api.listPlans()]);
  counts.value = { boxes: boxes.length, containers: containers.length, plans: plans.length };
}

onMounted(refreshCounts);

/** 触发文件选择框。input 的 change 事件在重复选同一个文件时不会触发，故每次先清空 value */
function pickFile(): void {
  const el = fileInput.value;
  if (!el) return;
  el.value = '';
  el.click();
}

async function onFilePicked(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  if (!f) return;
  reading.value = true;
  try {
    const text = await f.text();
    // 先解析并校验，**解析失败就地报错**，不让用户点完"覆盖恢复"才发现文件不对
    const parsed = parseBackup(text);
    file.value = parsed;
    pickedText.value = text;
    pickedName.value = f.name;
    preview.value = describeBackup(parsed);
  } catch (err) {
    clearPicked();
    ElMessage.error((err as Error).message);
  } finally {
    reading.value = false;
  }
}

function clearPicked(): void {
  file.value = null;
  pickedText.value = '';
  pickedName.value = '';
  preview.value = '';
}

/** 触发浏览器下载（两套版本都在浏览器里跑，这段代码两边通用） */
function download(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // 立刻 revoke 会让部分浏览器来不及开始下载，等一拍更稳
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function doExport(): Promise<void> {
  exporting.value = true;
  try {
    const f = await api.exportBackup({ includePlans: includePlans.value });
    download(JSON.stringify(f, null, 2), backupFileName(appVersion.version));
    ElMessage.success(`已导出 ${f.counts.boxes} 货物 / ${f.counts.containers} 柜型 / ${f.counts.plans} 方案`);
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    exporting.value = false;
  }
}

function outcomeText(o: ImportOutcome): string {
  const w = o.written;
  const base = `写入 ${w.boxes} 货物 / ${w.containers} 柜型 / ${w.plans} 方案`;
  return o.mode === 'replace'
    ? `${base}；已清掉原有 ${o.removed.boxes} 货物 / ${o.removed.containers} 柜型 / ${o.removed.plans} 方案`
    : `${base}；未删除任何现有数据`;
}

async function doImport(): Promise<void> {
  const f = file.value;
  if (!f) return;

  // 覆盖是不可逆的：先自动把当前数据存一份，再让用户确认
  if (mode.value === 'replace') {
    try {
      const current = await api.exportBackup({ includePlans: true });
      download(
        JSON.stringify(current, null, 2),
        `覆盖前自动备份_v${appVersion.version}_${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}.json`,
      );
    } catch (e) {
      ElMessage.error(`无法创建覆盖前备份，已中止导入：${(e as Error).message}`);
      return;
    }
  }

  try {
    await ElMessageBox.confirm(
      mode.value === 'replace'
        ? `将清空现有全部数据，恢复为文件里的 ${f.counts.boxes} 货物 / ${f.counts.containers} 柜型 / ${f.counts.plans} 方案。\n当前数据已自动备份到下载目录。`
        : `将按 id 写入 ${f.counts.boxes} 货物 / ${f.counts.containers} 柜型 / ${f.counts.plans} 方案，文件里没有的现有记录保持不变。`,
      mode.value === 'replace' ? '确认覆盖恢复' : '确认合并导入',
      { type: 'warning', confirmButtonText: '确定导入', cancelButtonText: '取消' },
    );
  } catch {
    return; // 用户点了取消
  }

  importing.value = true;
  try {
    const outcome = await api.importBackup(f, mode.value);
    ElMessage.success(outcomeText(outcome));
    clearPicked();
    await refreshCounts();
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    importing.value = false;
  }
}
</script>

<style scoped>
.backup-page {
  max-width: 900px;
  margin: 0 auto;
  padding: 12px;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.mt4 {
  margin-left: 4px;
}
.mr4 {
  margin-right: 4px;
}
.mt8 {
  margin-top: 8px;
}
.mt12 {
  margin-top: 12px;
}
.mt16 {
  margin-top: 16px;
}
.hint {
  font-size: 12px;
  color: #909399;
  line-height: 1.7;
  margin: 0;
}
.hidden-input {
  display: none;
}
.stat-row {
  display: flex;
  gap: 28px;
}
.stat-num {
  font-size: 28px;
  font-weight: 700;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
}
.stat-label {
  font-size: 12px;
  color: #909399;
}
.preview {
  margin: 0;
  font-family: inherit;
  font-size: 12.5px;
  line-height: 1.8;
  white-space: pre-wrap;
}
.mode-desc {
  font-size: 12px;
  color: #606266;
  line-height: 1.8;
  white-space: pre-line;
}
.tip {
  font-size: 12px;
  color: #606266;
  background: #f5f7fa;
  border-left: 3px solid #c0c4cc;
  padding: 8px 10px;
  line-height: 1.8;
  margin: 0;
}
.manual {
  margin: 6px 0;
  padding-left: 22px;
  font-size: 13px;
  line-height: 1.9;
  color: #303133;
}
p {
  font-size: 13px;
  line-height: 1.9;
  color: #303133;
  margin: 4px 0;
}

/* ───────────── 窄屏适配 ───────────── */
@media (max-width: 991px) {
  .stat-row {
    gap: 20px;
  }
  .stat-num {
    font-size: 24px;
  }
  .backup-page :deep(.el-card__body) {
    padding: 12px;
  }
  .row {
    gap: 8px;
  }
  /* 兜底：即便将来又把长文案塞回 checkbox，标签也必须能换行而不是撑破布局 */
  .backup-page :deep(.el-checkbox__label) {
    white-space: normal;
  }
  p,
  .manual {
    font-size: 12.5px;
  }
}
</style>