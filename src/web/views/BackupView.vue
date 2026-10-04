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

    <!-- ══════════ 共享资料库 ══════════
         与「导出备份」配对：左边导出参考数据 → 传到网盘/对象存储 →
         右边把地址填进所有设备，柜型/货物就都能查到了。
    -->
    <el-card shadow="never" class="mt16">
      <template #header>共享资料库（多设备查同一份柜型与货物）</template>

      <p class="hint">
        静态版的数据只在本浏览器里，办公室录好的柜型/货物，手机上查不到。
        把「参考数据」导成一个 JSON 放到网盘或对象存储，在每台设备上填它的地址，
        就能随手查到同一份资料。
      </p>

      <el-alert type="info" :closable="false" show-icon class="mt8 mb8"
        title="三条规则，动手前先看清">
        <template #default>
          <ul class="rules">
            <li><strong>库里的数据永远写不进本地</strong> —— 拉取失败、文件被传错、库被清空，
              最坏只是「查不到共享资料」，<strong>绝不会覆盖你本地的数据</strong>。</li>
            <li><strong>编辑库里的条目 = 存成你自己的</strong>（同 id，本地优先）。
              要改回去，在维护设备上改源文件再重新上传。</li>
            <li><strong>不会写回远程</strong>。共享库是「上次快照」，不是双向同步。</li>
          </ul>
        </template>
      </el-alert>

      <div class="row">
        <el-button :loading="exportingLib" @click="doExportLib">
          <el-icon class="mr4"><Download /></el-icon>导出参考数据（柜型 + 货物）
        </el-button>
        <span class="hint">不含历史方案与实测案例，文件很小，适合传网盘</span>
      </div>

      <el-divider />

      <el-form label-width="76px">
        <el-form-item label="资料库地址">
          <el-input
            v-model="libUrlInput"
            placeholder="https://.../装柜参考数据.json"
            :disabled="probing || savingLib"
          />
        </el-form-item>
      </el-form>

      <div class="row">
        <el-button :loading="probing" @click="doProbeLib">测试这个地址</el-button>
        <el-button type="primary" :loading="savingLib" @click="doSaveLib">保存并启用</el-button>
        <el-button v-if="libUrl" @click="doClearLib">停用</el-button>
      </div>

      <div class="mt8">
        <template v-if="probing">
          <el-alert :type="probeOk ? 'success' : 'error'" :closable="false" show-icon
            :title="probeOk ? `地址可用：读到 ${probeBoxes} 种货物、${probeContainers} 个柜型` : '地址不可用'" />
          <p v-if="!probeOk" class="hint danger mt4">{{ probeError }}</p>
        </template>
        <el-alert v-else-if="libUrl" :type="libNoticeType" :closable="false" show-icon :title="libNotice" />
        <p v-else class="hint">未启用。启用前所有功能与现在完全一样，不填这个地址也没有任何影响。</p>
      </div>

      <p class="hint mt8">
        地址必须允许跨域读取（响应带 <code>Access-Control-Allow-Origin</code>），
        否则浏览器会拦下响应。网盘分享链接一般不满足；
        仓库里有 <code>scripts/check-cors.mjs</code> 可先测一把。
      </p>

      <p class="hint mt4">
        <strong>只要 URL 不公开，别人就拿不到。</strong>但它终究是公开可读的文件，
        拿到链接的人能读到柜型与货物规格 —— 柜型尺寸本就是 ISO 公开标准，
        货物规格是否敏感你自己判断。
      </p>
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
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Download, Upload } from '@element-plus/icons-vue';
import api from '../api/client';
import { IS_STATIC_BUILD as isLocalBuild } from '../api/client';
import { parseBackup, describeBackup, backupFileName, buildBackup, type BackupFile, type ImportMode } from '../../model/backup';
import { appVersion } from '../../version';
import type { ImportOutcome } from '../../model/backupApply';
import {
  clearLib,
  ensureLib,
  getLibUrl,
  libState,
  probeLibUrl,
  setLibUrl,
} from '../lib/referenceStore';
import { downloadText } from '../lib/diagnosticFile';

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

// ── 共享资料库 ────────────────────────────────────────────────────────────
const libUrl = ref(getLibUrl());
const libUrlInput = ref(getLibUrl());
const probing = ref(false);
const probeOk = ref(false);
const probeError = ref('');
const probeBoxes = ref(0);
const probeContainers = ref(0);
const savingLib = ref(false);
const exportingLib = ref(false);
const libInfo = ref(libState());

/** 已启用时的状态条。**如实区分"正常"与"用的是缓存"**，不假装一切正常 */
const libNotice = computed(() => {
  if (!libUrl.value) return '';
  if (libInfo.value.lastError) return `已启用，但最近一次拉取没成功：${libInfo.value.lastError}（继续使用上次缓存的内容）`;
  if (libInfo.value.loadedAt === 0) return '已启用，尚未成功拉到内容';
  const when = new Date(libInfo.value.loadedAt).toLocaleString('zh-CN');
  const n = libInfo.value.payload;
  return `已启用：上次更新 ${when}，含 ${n?.containers.length ?? 0} 个柜型、${n?.boxes.length ?? 0} 种货物${libInfo.value.stale ? '（已超过 6 小时，下次打开会自动重新拉）' : ''}`;
});
const libNoticeType = computed(() => {
  if (!libUrl.value) return 'info';
  if (libInfo.value.lastError) return 'warning';
  if (libInfo.value.loadedAt === 0) return 'warning';
  return 'success';
});

/**
 * 导出参考数据
 *
 * 就是「导出备份」把 `plans` 与 `cases` 置空 —— 复用 `buildBackup`，
 * 所以产出的文件**同时是一个合法备份文件**：既能当资料库上传，
 * 也能直接被本应用「导入」回去，不需要任何转换。
 */
async function doExportLib(): Promise<void> {
  exportingLib.value = true;
  try {
    const [boxes, containers] = await Promise.all([api.listBoxes(), api.listContainers()]);
    if (boxes.length === 0 && containers.length === 0) {
      ElMessage.warning('还没有货物与柜型，没什么可导出的');
      return;
    }
    const file = buildBackup({
      boxes,
      containers,
      plans: [],
      cases: [],
      appVersion: appVersion.version,
    });
    const stamp = new Date().toISOString().slice(0, 10);
    downloadText(JSON.stringify(file, null, 2), `装柜参考数据_${stamp}.json`, 'application/json;charset=utf-8');
    ElMessage.success(`已导出：${containers.length} 个柜型、${boxes.length} 种货物。把它上传到网盘，再把地址填到下面`);
  } catch (e) {
    ElMessage.error(`导出失败：${(e as Error).message}`);
  } finally {
    exportingLib.value = false;
  }
}

/** 先验地址再决定存不存 —— 避免"存了才发现根本读不到" */
async function doProbeLib(): Promise<void> {
  const url = libUrlInput.value.trim();
  if (!url) {
    ElMessage.warning('先填一个地址');
    return;
  }
  probing.value = true;
  probeOk.value = false;
  probeError.value = '';
  try {
    const r = await probeLibUrl(url);
    probeOk.value = r.ok;
    probeError.value = r.error;
    if (r.ok) {
      probeBoxes.value = r.boxes;
      probeContainers.value = r.containers;
      ElMessage.success(`地址可用：${r.containers} 个柜型、${r.boxes} 种货物`);
    }
  } finally {
    probing.value = false;
  }
}

async function doSaveLib(): Promise<void> {
  const url = libUrlInput.value.trim();
  if (!url) {
    ElMessage.warning('先填一个地址');
    return;
  }
  savingLib.value = true;
  try {
    const r = await probeLibUrl(url);
    if (!r.ok) {
      // **不静默保存一个读不到的地址** —— 否则用户以为配好了，实际列表里什么都没有
      ElMessage.error(`地址不可用，未保存：${r.error}`);
      probeOk.value = false;
      probeError.value = r.error;
      return;
    }
    if (!setLibUrl(url)) {
      ElMessage.error('浏览器拒绝写入本地设置（可能开了无痕模式）');
      return;
    }
    libUrl.value = url;
    await ensureLib(true);
    libInfo.value = libState();
    ElMessage.success(`已启用：${r.containers} 个柜型、${r.boxes} 种货物`);
  } catch (e) {
    ElMessage.error(`启用失败：${(e as Error).message}`);
  } finally {
    savingLib.value = false;
  }
}

/** 停用 = 清掉地址与缓存。**墓碑刻意保留** —— 那是用户删条目的选择，不该被"停用"顺手抹掉 */
function doClearLib(): void {
  clearLib();
  libUrl.value = '';
  libUrlInput.value = '';
  libInfo.value = libState();
  probeOk.value = false;
  ElMessage.success('已停用。本地数据没有任何改动');
}

async function refreshCounts(): Promise<void> {
  const [boxes, containers, plans] = await Promise.all([api.listBoxes(), api.listContainers(), api.listPlans()]);
  counts.value = { boxes: boxes.length, containers: containers.length, plans: plans.length };
  libInfo.value = libState();
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