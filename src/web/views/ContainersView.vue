<template>
  <div>
    <el-card shadow="never">
      <div class="toolbar">
        <el-button type="primary" @click="openCreate">新增柜型</el-button>
        <el-button @click="refresh">刷新</el-button>
      </div>
      <el-table :data="containers" v-loading="loading" border stripe class="only-desktop">
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column prop="label" label="标签" width="90" />
        <el-table-column prop="name" label="名称" min-width="160" />
        <el-table-column label="内尺寸 L×W×H (mm)" width="210">
          <template #default="{ row }">{{ row.innerLength }} × {{ row.innerWidth }} × {{ row.innerHeight }}</template>
        </el-table-column>
        <el-table-column prop="weightCapacity" label="载重 (kg)" width="110" />
        <el-table-column label="空柜自重" width="100" align="right">
          <template #default="{ row }">{{ row.emptyWeight ? row.emptyWeight.toFixed(0) : '-' }}</template>
        </el-table-column>
        <el-table-column label="门尺寸 (mm)" width="120" align="center">
          <template #default="{ row }">
            <span v-if="row.doorDims">{{ row.doorDims[0] }}×{{ row.doorDims[1] }}</span>
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="170" fixed="right">
          <template #default="{ row }">
            <el-button size="small" @click="openEdit(row)">编辑</el-button>
            <el-popconfirm title="确认删除该柜型？" @confirm="remove(row)">
              <template #reference>
                <el-button size="small" type="danger">删除</el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
      </el-table>

      <!--
        窄屏卡片：8 列压成一张卡。
        刻意**不列 ID** —— 手机上没人靠 ID 找柜型，位置留给尺寸和载重这两个
        真正影响装柜的字段。门尺寸只在有值时显示（大部分柜型没录门）。
      -->
      <div class="only-mobile">
        <div v-if="loading" class="mcard-empty">加载中…</div>
        <div v-else-if="containers.length === 0" class="mcard-empty">还没有柜型，点「新增柜型」开始。</div>
        <div v-for="row in containers" :key="row.id" class="mcard">
          <div class="mcard-head">
            <span class="mcard-lead" style="margin-top: 0">{{ row.name }}</span>
            <el-tag v-if="row.label" size="small" type="info">{{ row.label }}</el-tag>
          </div>
          <div class="mcard-lead">{{ row.innerLength }} × {{ row.innerWidth }} × {{ row.innerHeight }}</div>
          <div class="mcard-meta">
            <div><span class="k">载重</span>{{ row.weightCapacity }} kg</div>
            <!-- 没录空柜自重时不要拼出 "- kg" 这种怪东西 -->
            <div>
              <span class="k">空柜</span>
              <template v-if="row.emptyWeight">{{ row.emptyWeight.toFixed(0) }} kg</template>
              <template v-else>未录</template>
            </div>
            <div v-if="row.doorDims"><span class="k">门尺寸</span>{{ row.doorDims[0] }}×{{ row.doorDims[1] }} mm</div>
          </div>
          <div class="mcard-ops">
            <el-button size="small" @click="openEdit(row)">编辑</el-button>
            <el-popconfirm title="确认删除该柜型？" @confirm="remove(row)">
              <template #reference>
                <el-button size="small" type="danger">删除</el-button>
              </template>
            </el-popconfirm>
          </div>
        </div>
      </div>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editing ? '编辑柜型' : '新增柜型'" width="700px" top="8vh">
      <el-form :model="form" label-width="110px">
        <el-row :gutter="12">
          <el-col :xs="24" :sm="12">
            <el-form-item label="名称" required>
              <el-input v-model="form.name" placeholder="例如：40 尺高柜" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="标签">
              <el-input v-model="form.label" placeholder="例如：40HQ" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="描述">
          <el-input v-model="form.description" type="textarea" :rows="2" placeholder="例如：40 尺 9.6m 高柜" />
        </el-form-item>

        <el-divider content-position="left">内尺寸与载重</el-divider>
        <el-row :gutter="12">
          <el-col :xs="24" :sm="8">
            <el-form-item label="内长 L" required>
              <el-input-number v-model="form.length" :min="1" :max="100000" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="8">
            <el-form-item label="内宽 W" required>
              <el-input-number v-model="form.width" :min="1" :max="100000" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="8">
            <el-form-item label="内高 H" required>
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
            <el-form-item label="载重">
              <el-input-number v-model="form.weightCapacity" :min="0" :max="100000" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="8">
            <el-form-item label="重量单位">
              <el-select v-model="form.weightUnit" style="width: 100%">
                <el-option v-for="u in ['kg', 'lb']" :key="u" :value="u" :label="u" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>

        <el-divider content-position="left">结构与商务</el-divider>
        <el-row :gutter="12">
          <el-col :xs="24" :sm="8">
            <el-form-item label="角件 长">
              <el-input-number v-model="form.cornerLength" :min="0" :max="500" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="8">
            <el-form-item label="角件 宽">
              <el-input-number v-model="form.cornerWidth" :min="0" :max="500" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="8">
            <el-form-item label="角件 高">
              <el-input-number v-model="form.cornerHeight" :min="0" :max="500" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="门 宽">
              <el-input-number v-model="form.doorWidth" :min="0" :max="100000" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="门 高">
              <el-input-number v-model="form.doorHeight" :min="0" :max="100000" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="空柜自重">
              <el-input-number v-model="form.emptyWeight" :min="0" :max="100000" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="成本">
              <el-input-number v-model="form.cost" :min="0" :max="10000000" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="计量单位">
              <el-input v-model="form.unit" placeholder="柜 / 次" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-alert type="info" :closable="false">
          角件/门尺寸、空柜自重、成本目前仅作数据存档；装柜计算按内尺寸与载重进行，角件冲突检测尚未实现。
        </el-alert>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import api from '../api/client';
import { defaultContainerForm, containerFormToPayload, containerToForm } from '../lib/containerForm';
import type { Container } from '../../types';

const containers = ref<Container[]>([]);
const loading = ref(false);
const dialogVisible = ref(false);
const editing = ref<Container | null>(null);
const form = reactive({
  name: '',
  label: '',
  description: '',
  length: 5898,
  width: 2352,
  height: 2393,
  weightCapacity: 21770,
  dimensionUnit: 'mm',
  weightUnit: 'kg',
  cornerLength: 0,
  cornerWidth: 0,
  cornerHeight: 0,
  doorWidth: 0,
  doorHeight: 0,
  emptyWeight: 0,
  cost: 0,
  unit: '',
});

/** 表单默认值（新建/重置用）—— 实现见 lib/containerForm.ts */
function defaultForm() {
  return defaultContainerForm();
}

/**
 * 表单 → API payload
 *
 * 实现已抽到 `lib/containerForm.ts`，因为它曾在这里藏过一个**两边互相抵消**的 bug
 * （表单发 SQLite 列名、服务端数据层也收列名，于是静态版失效）。详细说明见那个文件。
 */
function toPayload(f: ReturnType<typeof defaultForm>): Partial<Container> {
  return containerFormToPayload(f);
}

async function refresh() {
  loading.value = true;
  try {
    containers.value = await api.listContainers();
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  editing.value = null;
  Object.assign(form, defaultForm());
  dialogVisible.value = true;
}

function openEdit(row: Container) {
  editing.value = row;
  Object.assign(form, containerToForm(row));
  dialogVisible.value = true;
}

async function submit() {
  if (!form.name.trim()) {
    ElMessage.warning('请填写柜型名称');
    return;
  }
  try {
    const payload = toPayload(form);
    if (editing.value) {
      await api.updateContainer(editing.value.id, payload);
    } else {
      await api.createContainer(payload);
    }
    ElMessage.success('保存成功');
    dialogVisible.value = false;
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

async function remove(row: Container) {
  try {
    await api.deleteContainer(row.id);
    ElMessage.success('已删除');
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

onMounted(refresh);
</script>

<style scoped>
/* `.toolbar` 在 App.vue 全局样式里（与货物 / 方案页共用一份） */
</style>
