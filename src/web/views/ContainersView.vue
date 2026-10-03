<template>
  <div>
    <el-card shadow="never">
      <div class="toolbar">
        <el-button type="primary" @click="openCreate">新增柜型</el-button>
        <el-button @click="refresh">刷新</el-button>
      </div>
      <el-table :data="containers" v-loading="loading" border stripe>
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

/** 表单默认值（新建/重置用） */
function defaultForm() {
  return {
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
  };
}

/** 表单 → API payload（角件/门尺寸为三元组/二元组） */
function toPayload(f: ReturnType<typeof defaultForm>) {
  const hasCorner = f.cornerLength > 0 || f.cornerWidth > 0 || f.cornerHeight > 0;
  const hasDoor = f.doorWidth > 0 || f.doorHeight > 0;
  return {
    name: f.name.trim(),
    label: f.label.trim() || undefined,
    description: f.description.trim() || undefined,
    length: f.length,
    width: f.width,
    height: f.height,
    weightCapacity: f.weightCapacity,
    dimensionUnit: f.dimensionUnit,
    weightUnit: f.weightUnit,
    cornerDims: hasCorner ? ([f.cornerLength, f.cornerWidth, f.cornerHeight] as [number, number, number]) : undefined,
    doorDims: hasDoor ? ([f.doorWidth, f.doorHeight] as [number, number]) : undefined,
    emptyWeight: f.emptyWeight,
    cost: f.cost,
    unit: f.unit.trim() || undefined,
  };
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
  Object.assign(form, defaultForm(), {
    name: row.name,
    label: row.label ?? '',
    description: row.description ?? '',
    length: row.innerLength,
    width: row.innerWidth,
    height: row.innerHeight,
    weightCapacity: row.weightCapacity,
    dimensionUnit: row.dimensionUnit ?? 'mm',
    weightUnit: row.weightUnit ?? 'kg',
    cornerLength: row.cornerDims?.[0] ?? 0,
    cornerWidth: row.cornerDims?.[1] ?? 0,
    cornerHeight: row.cornerDims?.[2] ?? 0,
    doorWidth: row.doorDims?.[0] ?? 0,
    doorHeight: row.doorDims?.[1] ?? 0,
    emptyWeight: row.emptyWeight ?? 0,
    cost: row.cost ?? 0,
    unit: row.unit ?? '',
  });
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
.toolbar {
  margin-bottom: 12px;
}
</style>
