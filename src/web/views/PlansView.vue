<template>
  <div>
    <el-card shadow="never">
      <div class="toolbar">
        <el-button @click="refresh">刷新</el-button>
      </div>
      <el-table :data="plans" v-loading="loading" border stripe>
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column prop="name" label="方案名称" min-width="160" />
        <el-table-column prop="containerId" label="柜型 ID" width="90" />
        <el-table-column label="装载率" width="110">
          <template #default="{ row }">{{ (row.result.loadRate * 100).toFixed(1) }}%</template>
        </el-table-column>
        <el-table-column label="总件数" width="90">
          <template #default="{ row }">{{ row.result.pieces }}</template>
        </el-table-column>
        <el-table-column prop="createdAt" label="创建时间" width="180" />
        <el-table-column label="操作" width="230" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="primary" @click="loadPlan(row)">加载</el-button>
            <el-button size="small" @click="printPlan(row)">报表</el-button>
            <el-popconfirm title="确认删除该方案？" @confirm="remove(row)">
              <template #reference>
                <el-button size="small" type="danger">删除</el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import api, { type PlanRecord } from '../api/client';
import { setPlanDoc } from '../store/planDoc';

const PENDING_KEY = 'load_expert_pending_plan';

const router = useRouter();
const plans = ref<PlanRecord[]>([]);
const loading = ref(false);

async function refresh() {
  loading.value = true;
  try {
    plans.value = await api.listPlans();
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    loading.value = false;
  }
}

async function loadPlan(row: PlanRecord) {
  try {
    const plan = await api.getPlan(row.id);
    localStorage.setItem(PENDING_KEY, JSON.stringify(plan));
    ElMessage.success(`已加载方案：${plan.name}，跳转装柜计算页`);
    void router.push('/calculate');
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

/**
 * 直接打印某个历史方案的报表（不必先"加载"到计算页再导出）
 *
 * 方案记录里 `boxes` 就是当时提交的 Box 列表（**带本次申请数量**），
 * 正好同时充当报表需要的"货物元数据 + 申请数量"。
 * `doorAtMaxX` 未随方案保存，沿用默认约定（与计算页一致）。
 */
async function printPlan(row: PlanRecord) {
  try {
    const plan = await api.getPlan(row.id);
    setPlanDoc({
      result: plan.result,
      boxes: plan.boxes,
      planName: plan.name,
      doorAtMaxX: true,
      requested: Object.fromEntries(plan.boxes.map((b) => [b.id, b.quantity ?? null])),
    });
    void router.push({ path: '/report', query: { doc: 'all' } });
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

async function remove(row: PlanRecord) {
  try {
    await api.deletePlan(row.id);
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
