<template>
  <div>
    <el-card shadow="never">
      <div class="toolbar">
        <el-button type="primary" @click="openCreate">新增货物</el-button>
        <el-button @click="refresh">刷新</el-button>
        <!--
          尺寸不在这里写：行内样式优先级最高，媒体查询覆盖不掉，
          窄屏就没法让这个下拉独占一行。改由 App.vue 全局的 `.toolbar .el-select` 负责。
        -->
        <el-select
          v-model="groupFilter"
          placeholder="按分组过滤"
          clearable
          @change="onGroupFilterChange"
        >
          <el-option v-for="g in groupOptions" :key="g" :label="g" :value="g" />
        </el-select>
      </div>
      <el-table :data="filteredBoxes" v-loading="loading" border stripe class="only-desktop">
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column prop="name" label="名称" min-width="140">
        <!-- 「资料库」标记：来自共享资料库的条目不是本机数据，得一眼看出 -->
        <template #default="{ row }">
          {{ row.name }}
          <span v-if="isFromLib('box', row.id)" class="lib-mark" title="来自共享资料库，不在本机数据里">资料库</span>
        </template>
      </el-table-column>
        <el-table-column prop="sku" label="SKU" min-width="110">
          <template #default="{ row }">{{ row.sku || '-' }}</template>
        </el-table-column>
        <el-table-column prop="batch" label="批次" min-width="100">
          <template #default="{ row }">{{ row.batch || '-' }}</template>
        </el-table-column>
        <el-table-column label="尺寸 L×W×H (mm)" width="190">
          <template #default="{ row }">{{ row.length }} × {{ row.width }} × {{ row.height }}</template>
        </el-table-column>
        <el-table-column prop="weight" label="重量 (kg)" width="100" />
        <el-table-column label="单价" width="110">
          <template #default="{ row }">{{ row.unitPrice !== undefined ? row.unitPrice : '-' }}</template>
        </el-table-column>
        <el-table-column label="单位" width="90">
          <template #default="{ row }">{{ row.unit || '-' }}</template>
        </el-table-column>
        <el-table-column label="分组" min-width="100">
          <template #default="{ row }">{{ row.groupName || '-' }}</template>
        </el-table-column>
        <el-table-column prop="stackClass" label="堆码级" width="90" />
        <el-table-column prop="pcsCount" label="每箱件数" width="100" />
        <el-table-column label="六向限制" width="120" align="center">
          <template #default="{ row }">
            <el-tag v-if="restrictedDirs(row).length" type="warning" size="small">
              {{ restrictedDirs(row).length }}/6 受限
            </el-tag>
            <el-tag v-else type="success" size="small">全向</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="颜色" width="80" align="center">
          <template #default="{ row }">
            <span v-if="row.color" class="color-dot" :style="{ background: row.color }"></span>
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="170" fixed="right">
          <template #default="{ row }">
            <el-button size="small" @click="openEdit(row)">编辑</el-button>
            <el-popconfirm :title="delConfirmTitle(row)" @confirm="remove(row)">
              <template #reference>
                <el-button size="small" type="danger">删除</el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
      </el-table>

      <!--
        窄屏卡片。**14 列压成 6 个字段**，取舍如下：

        保留：名称、尺寸（主）、重量、堆码级、六向限制 —— 这几项决定能不能装进去
        条件显示：SKU / 批次 / 分组 / 单价 / 单位 / 每箱件数 / 颜色 —— 有值才显示，
                  没值的字段在卡片上只是噪声（桌面上是 `-` 占位，卡片里直接不出现）
        舍弃：ID —— 手机上没人靠 ID 找货物

        「六向限制」保留是因为它直接决定摆放可行性；有货物不能倒放之类的情况时，
        这是用户最需要一眼看到的东西。
      -->
      <div class="only-mobile">
        <div v-if="loading" class="mcard-empty">加载中…</div>
        <div v-else-if="filteredBoxes.length === 0" class="mcard-empty">
          {{ boxes.length === 0 ? '还没有货物，点「新增货物」开始。' : '没有符合筛选条件的货物。' }}
        </div>
        <div v-for="row in filteredBoxes" :key="row.id" class="mcard">
          <div class="mcard-head">
            <span class="mcard-lead" style="margin-top: 0">
              {{ row.name }}
              <span v-if="isFromLib('box', row.id)" class="lib-mark">资料库</span>
            </span>
            <el-tag v-if="row.sku" size="small" type="info">{{ row.sku }}</el-tag>
          </div>
          <div class="mcard-lead">{{ row.length }} × {{ row.width }} × {{ row.height }}</div>
          <div class="mcard-meta">
            <div><span class="k">重量</span>{{ row.weight }} kg</div>
            <div><span class="k">堆码级</span>{{ row.stackClass }}</div>
            <div v-if="row.pcsCount && row.pcsCount !== 1">
              <span class="k">每箱</span>{{ row.pcsCount }} 件
            </div>
            <div v-if="row.batch"><span class="k">批次</span>{{ row.batch }}</div>
            <div v-if="row.groupName"><span class="k">分组</span>{{ row.groupName }}</div>
            <div v-if="row.unitPrice !== undefined">
              <span class="k">单价</span>{{ row.unitPrice }}{{ row.unit ? ' ' + row.unit : '' }}
            </div>
          </div>
          <div class="mcard-meta">
            <el-tag v-if="restrictedDirs(row).length" type="warning" size="small">
              {{ restrictedDirs(row).length }}/6 向受限
            </el-tag>
            <el-tag v-else type="success" size="small">六向可摆</el-tag>
            <span v-if="row.color" class="color-dot" :style="{ background: row.color }"></span>
          </div>
          <div class="mcard-ops">
            <el-button size="small" @click="openEdit(row)">编辑</el-button>
            <el-popconfirm :title="delConfirmTitle(row)" @confirm="remove(row)">
              <template #reference>
                <el-button size="small" type="danger">删除</el-button>
              </template>
            </el-popconfirm>
          </div>
        </div>
      </div>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editing ? '编辑货物' : '新增货物'" width="820px" top="6vh">
      <el-tabs v-model="formTab">
        <!-- 基本信息 -->
        <el-tab-pane label="基本信息" name="basic">
          <el-form :model="form" label-width="110px">
            <el-row :gutter="12">
              <el-col :xs="24" :sm="12">
                <el-form-item label="名称" required>
                  <el-input v-model="form.name" placeholder="例如：纸箱 A" />
                </el-form-item>
              </el-col>
              <el-col :xs="24" :sm="12">
                <el-form-item label="描述">
                  <el-input v-model="form.description" placeholder="例如：外箱 5 层瓦楞" />
                </el-form-item>
              </el-col>
              <el-col :xs="24" :sm="12">
                <el-form-item label="SKU">
                  <el-input v-model="form.sku" placeholder="例如：SKU-1001" />
                </el-form-item>
              </el-col>
              <el-col :xs="24" :sm="12">
                <el-form-item label="批次">
                  <el-input v-model="form.batch" placeholder="例如：2026-09 批" />
                </el-form-item>
              </el-col>
              <el-col :xs="24" :sm="12">
                <el-form-item label="颜色">
                  <el-color-picker v-model="form.color" :predefine="PREDEFINED_COLORS" />
                  <span class="form-hint">用于 3D 渲染配色</span>
                </el-form-item>
              </el-col>
              <el-col :xs="24" :sm="12">
                <el-form-item label="分组">
                  <el-input v-model="form.groupName" placeholder="电子产品 / 日用品" />
                </el-form-item>
              </el-col>
              <el-col :xs="24" :sm="12">
                <el-form-item label="单价">
                  <el-input-number v-model="form.unitPrice" :min="0" :max="100000000" style="width: 100%" />
                </el-form-item>
              </el-col>
              <el-col :xs="24" :sm="12">
                <el-form-item label="单位">
                  <el-input v-model="form.unit" placeholder="箱 / 件 / 托盘" />
                </el-form-item>
              </el-col>
              <el-col :xs="24" :sm="12">
                <el-form-item label="每箱件数">
                  <el-input-number v-model="form.pcsCount" :min="1" :max="100000" style="width: 100%" />
                </el-form-item>
              </el-col>
            </el-row>
          </el-form>
        </el-tab-pane>

        <!-- 尺寸与重量 -->
        <el-tab-pane label="尺寸与重量" name="size">
          <el-form :model="form" label-width="110px">
            <el-row :gutter="12">
              <el-col :xs="24" :sm="8">
                <el-form-item label="长 L" required>
                  <el-input-number v-model="form.length" :min="1" :max="100000" style="width: 100%" />
                </el-form-item>
              </el-col>
              <el-col :xs="24" :sm="8">
                <el-form-item label="宽 W" required>
                  <el-input-number v-model="form.width" :min="1" :max="100000" style="width: 100%" />
                </el-form-item>
              </el-col>
              <el-col :xs="24" :sm="8">
                <el-form-item label="高 H" required>
                  <el-input-number v-model="form.height" :min="1" :max="100000" style="width: 100%" />
                </el-form-item>
              </el-col>
              <el-col :xs="24" :sm="8">
                <el-form-item label="尺寸单位">
                  <el-select v-model="form.dimensionUnit" style="width: 100%">
                    <el-option v-for="u in ['mm', 'cm', 'in']" :key="u" :value="u" :label="u" />
                  </el-select>
                </el-form-item>
              </el-col>
              <el-col :xs="24" :sm="8">
                <el-form-item label="毛重">
                  <el-input-number v-model="form.weight" :min="0" :max="100000" style="width: 100%" />
                </el-form-item>
              </el-col>
              <el-col :xs="24" :sm="8">
                <el-form-item label="净重">
                  <el-input-number v-model="form.netWeight" :min="0" :max="100000" placeholder="留空同毛重" style="width: 100%" />
                </el-form-item>
              </el-col>
              <el-col :xs="24" :sm="8">
                <el-form-item label="重量单位">
                  <el-select v-model="form.weightUnit" style="width: 100%">
                    <el-option v-for="u in ['kg', 'g', 'lb']" :key="u" :value="u" :label="u" />
                  </el-select>
                </el-form-item>
              </el-col>
            </el-row>
            <el-alert type="info" :closable="false" class="mt8">
              尺寸与重量按所选单位录入；算法内部统一按 mm / kg 计算。
            </el-alert>
          </el-form>
        </el-tab-pane>

        <!-- 型变 -->
        <el-tab-pane label="型变" name="deform">
          <el-form :model="form" label-width="130px">
            <el-form-item label="型变系数">
              <el-input-number v-model="form.deformFactor" :min="0.1" :max="5" :step="0.05" style="width: 160px" />
              <span class="form-hint">实际装柜尺寸 = 名义尺寸 × 该系数（如软包装受压压缩取 0.9）</span>
            </el-form-item>
            <el-form-item label="型变公差">
              <el-input-number v-model="form.deformTolerance" :min="0" :max="1" :step="0.05" style="width: 160px" />
              <span class="form-hint">允许的尺寸偏差比例（0~1）</span>
            </el-form-item>
            <el-alert type="warning" :closable="false" class="mt8">
              型变系数与公差目前仅作数据存档，尚未参与装柜计算（算法侧仍按名义尺寸）。
            </el-alert>
          </el-form>
        </el-tab-pane>

        <!-- 摆放限制 -->
        <el-tab-pane label="摆放限制" name="placement">
          <el-form :model="form" label-width="130px">
            <el-form-item label="堆码级别">
              <el-input-number v-model="form.stackClass" :min="1" :max="9" style="width: 160px" />
              <span class="form-hint">值越大允许堆得越高；限制其它货物的承托级别上限</span>
            </el-form-item>
            <el-form-item label="底部承托比例">
              <div class="triple">
                <label>X <el-input-number v-model="form.supportPct[0]" :min="0" :max="1" :step="0.05" size="small" /></label>
                <label>Y <el-input-number v-model="form.supportPct[1]" :min="0" :max="1" :step="0.05" size="small" /></label>
                <label>Z <el-input-number v-model="form.supportPct[2]" :min="0" :max="1" :step="0.05" size="small" /></label>
              </div>
              <span class="form-hint">离地放置时底面被承托的最小比例（算法取 Z 轴值判定）</span>
            </el-form-item>
          </el-form>

          <el-divider content-position="left">六向设置</el-divider>
          <el-table :data="sixDirRows" size="small" border class="six-table">
            <el-table-column label="方向" min-width="130">
              <template #default="{ row }">{{ row.label }}</template>
            </el-table-column>
            <el-table-column label="允许摆放" width="100" align="center">
              <template #default="{ row }">
                <el-checkbox v-model="form.allowDirections[row.i]" />
              </template>
            </el-table-column>
            <el-table-column label="承托级别" width="120" align="center">
              <template #default="{ row }">
                <el-input-number v-model="form.supportClasses[row.i]" :min="0" :max="9" size="small" controls-position="right" style="width: 90px" />
              </template>
            </el-table-column>
            <el-table-column label="最大堆放数" width="130" align="center">
              <template #default="{ row }">
                <el-input-number v-model="form.maxPlaceDepth[row.i]" :min="0" :max="999" size="small" controls-position="right" style="width: 100px" />
              </template>
            </el-table-column>
            <el-table-column label="可承重" width="90" align="center">
              <template #default="{ row }">
                <el-checkbox v-model="form.supportFaces[row.i]" />
              </template>
            </el-table-column>
          </el-table>
          <div class="form-hint mt8">
            「允许摆放」未勾选的方向会被算法排除；「承托级别」为 0 同样禁止该方向；
            最大堆放数 0 表示不限（字段已存档，算法暂未使用）。
          </div>
        </el-tab-pane>
      </el-tabs>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import api from '../api/client';
import type { Box } from '../../types';
import { SIX_DIRECTION_LABELS } from '../../types';
import { isFromLib } from '../api/withReferenceLib';
import { addDeletedId } from '../lib/referenceStore';

const boxes = ref<Box[]>([]);
const loading = ref(false);
const dialogVisible = ref(false);
const editing = ref<Box | null>(null);
/** 正在编辑的条目是否来自共享资料库（决定保存后的提示文案） */
const wasFromLib = ref(false);
const groupFilter = ref('');
const formTab = ref('basic');

/** 预置颜色（3D 渲染用） */
const PREDEFINED_COLORS = ['#5470c6', '#91cc75', '#fac858', '#ee6666', '#73c0de', '#3ba272', '#fc8452', '#9a60b4', '#ea7ccc'];

/** 六向表格行（索引对应方向 0..5） */
const sixDirRows = SIX_DIRECTION_LABELS.map((label, i) => ({ i, label }));

const form = reactive({
  // 基本信息
  name: '',
  description: '',
  sku: '',
  batch: '',
  color: '',
  unitPrice: undefined as number | undefined,
  unit: '',
  groupName: '',
  // 尺寸与重量
  length: 100,
  width: 100,
  height: 100,
  weight: 0,
  netWeight: undefined as number | undefined,
  dimensionUnit: 'mm',
  weightUnit: 'kg',
  // 型变
  deformFactor: 1,
  deformTolerance: 0,
  // 堆码/承托
  stackClass: 1,
  supportClasses: [5, 5, 5, 5, 5, 5] as number[],
  supportPct: [1, 1, 1] as [number, number, number],
  allowDirections: [true, true, true, true, true, true] as boolean[],
  maxPlaceDepth: [0, 0, 0, 0, 0, 0] as number[],
  supportFaces: [true, true, true, true, true, true] as boolean[],
  pcsCount: 1,
});

/** 表单默认值（新建/重置时用） */
function defaultForm() {
  return {
    name: '',
    description: '',
    sku: '',
    batch: '',
    color: '',
    unitPrice: undefined as number | undefined,
    unit: '',
    groupName: '',
    length: 100,
    width: 100,
    height: 100,
    weight: 0,
    netWeight: undefined as number | undefined,
    dimensionUnit: 'mm',
    weightUnit: 'kg',
    deformFactor: 1,
    deformTolerance: 0,
    stackClass: 1,
    supportClasses: [5, 5, 5, 5, 5, 5] as number[],
    supportPct: [1, 1, 1] as [number, number, number],
    allowDirections: [true, true, true, true, true, true] as boolean[],
    maxPlaceDepth: [0, 0, 0, 0, 0, 0] as number[],
    supportFaces: [true, true, true, true, true, true] as boolean[],
    pcsCount: 1,
  };
}

/** 分组下拉选项：由现有货物分组去重得到 */
const groupOptions = computed<string[]>(() => {
  const set = new Set<string>();
  for (const b of boxes.value) {
    if (b.groupName && b.groupName.trim()) {
      set.add(b.groupName.trim());
    }
  }
  return Array.from(set).sort();
});

/** 按分组过滤后的列表 */
const filteredBoxes = computed<Box[]>(() => {
  if (!groupFilter.value) {
    return boxes.value;
  }
  return boxes.value.filter((b) => (b.groupName ?? '').trim() === groupFilter.value);
});

function onGroupFilterChange() {
  // 过滤逻辑在 computed 中实时生效，此处仅保留事件入口
}

/** 该货物受限的方向数（未允许摆放 或 承托级别为 0） */
function restrictedDirs(row: Box): number[] {
  const out: number[] = [];
  for (let i = 0; i < 6; i++) {
    const allowed = row.allowDirections?.[i] !== false;
    const support = (row.supportClasses?.[i] ?? 0) > 0;
    if (!allowed || !support) {
      out.push(i);
    }
  }
  return out;
}

async function refresh() {
  loading.value = true;
  try {
    boxes.value = await api.listBoxes();
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  editing.value = null;
  // 数组字段需整体替换（reactive 内数组直接赋值会丢响应式）
  Object.assign(form, defaultForm());
  form.supportClasses = [5, 5, 5, 5, 5, 5];
  form.supportPct = [1, 1, 1];
  form.allowDirections = [true, true, true, true, true, true];
  form.maxPlaceDepth = [0, 0, 0, 0, 0, 0];
  form.supportFaces = [true, true, true, true, true, true];
  dialogVisible.value = true;
}

function openEdit(row: Box) {
  editing.value = row;
  // 记下"正在编辑的是不是库里的条目" —— 保存后要给出不同提示。
  // 必须在编辑**之前**取：保存后同 id 就变成"本地优先"了，再查已查不出
  wasFromLib.value = isFromLib('box', row.id);
  Object.assign(form, defaultForm(), {
    name: row.name,
    description: row.description ?? '',
    sku: row.sku ?? '',
    batch: row.batch ?? '',
    color: row.color ?? '',
    unitPrice: row.unitPrice,
    unit: row.unit ?? '',
    groupName: row.groupName ?? '',
    length: row.length,
    width: row.width,
    height: row.height,
    weight: row.weight,
    netWeight: row.netWeight,
    dimensionUnit: row.dimensionUnit ?? 'mm',
    weightUnit: row.weightUnit ?? 'kg',
    deformFactor: row.deformFactor ?? 1,
    deformTolerance: row.deformTolerance ?? 0,
    stackClass: row.stackClass,
    pcsCount: row.pcsCount,
  });
  // 数组字段逐一复制，避免与 row 共享引用
  form.supportClasses = [...(row.supportClasses ?? [5, 5, 5, 5, 5, 5])];
  form.supportPct = [...(row.supportPct ?? [1, 1, 1])] as [number, number, number];
  form.allowDirections = [...(row.allowDirections ?? [true, true, true, true, true, true])];
  form.maxPlaceDepth = [...(row.maxPlaceDepth ?? [0, 0, 0, 0, 0, 0])];
  form.supportFaces = [...(row.supportFaces ?? [true, true, true, true, true, true])];
  dialogVisible.value = true;
}

async function submit() {
  if (!form.name.trim()) {
    ElMessage.warning('请填写货物名称');
    return;
  }
  if (!form.length || !form.width || !form.height) {
    ElMessage.warning('请填写三维尺寸');
    return;
  }
  if (form.allowDirections.every((v) => !v)) {
    ElMessage.warning('至少要允许一个摆放方向');
    return;
  }
  // 净重缺省时按毛重处理
  if (form.netWeight === undefined || form.netWeight === null) {
    form.netWeight = form.weight;
  }
  try {
    if (editing.value) {
      await api.updateBox(editing.value.id, { ...form });
      // 编辑的是**库里的**条目 → 已以同 id 存成"你自己的"，从此本地优先。
      // 不必再提示"库还是旧的"，但说清楚比不说好：否则用户会以为改动同步回去了
      if (wasFromLib.value) {
        ElMessage.success('已存为本地版本（这份资料库不会被改动，下次刷新仍在）');
      } else {
        ElMessage.success('保存成功');
      }
    } else {
      await api.createBox({ ...form });
      ElMessage.success('保存成功');
    }
    dialogVisible.value = false;
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

/**
 * 删除确认框的标题
 *
 * **库条目必须换一套说法。**对一条"本机根本没有、只是从库里读出来"的条目
 * 说"确认删除该货物？"是误导 —— 它删不掉任何东西，只是在本机隐藏。
 * 用户点确定后发现条目还在，会以为程序有 bug。
 */
function delConfirmTitle(row: Box): string {
  return isFromLib('box', row.id)
    ? `「${row.name}」来自共享资料库。确定在这台设备上隐藏它？（资料库文件不受影响，其它设备仍会显示）`
    : '确认删除该货物？';
}

/**
 * 删除
 *
 * 分两种，因为库里的条目本地并不存在：
 * - 本地条目 → 真删
 * - 库里的条目 → 记一个墓碑（本地记下"我不要这条"），
 *   否则下次拉取它又原样出现，删除看起来没生效
 *
 * 确认框已在 `delConfirmTitle` 里把话说清，不再弹第二次
 */
async function remove(row: Box) {
  if (isFromLib('box', row.id)) {
    addDeletedId('box', row.id);
    ElMessage.success('已在本机隐藏。资料库文件本身没有改动');
    await refresh();
    return;
  }
  try {
    await api.deleteBox(row.id);
    ElMessage.success('已删除');
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

onMounted(refresh);
</script>

<style scoped>
/* `.toolbar` 移到 App.vue 的全局样式里了 —— 三页共用一份，
   且需要能整体覆盖窄屏断点；原来这里只写 margin-bottom、没有 flex，
   是窄屏下控件挤成一团的根因。 */
.form-hint {
  margin-left: 10px;
  font-size: 12px;
  color: #909399;
  line-height: 1.5;
}
.triple {
  display: flex;
  gap: 10px;
}
.triple label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: #606266;
}
.six-table {
  margin-top: 4px;
}
.color-dot {
  display: inline-block;
  width: 14px;
  height: 14px;
  border-radius: 3px;
  border: 1px solid #dcdfe6;
  vertical-align: middle;
}
</style>
