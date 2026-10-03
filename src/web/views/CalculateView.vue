<template>
  <div class="calc-page">
    <el-row :gutter="16">
      <!-- 左：参数配置 -->
      <el-col :span="8">
        <el-card shadow="never" header="柜型选择">
          <div class="pick-row">
            <el-radio-group v-model="containerMode" size="small">
              <el-radio-button value="single">单选</el-radio-button>
              <el-radio-button value="multi">多选</el-radio-button>
            </el-radio-group>
          </div>
          <el-select
            v-model="containerIds"
            multiple
            filterable
            clearable
            collapse-tags
            collapse-tags-tooltip
            :max-collapse-tags="3"
            placeholder="请选择柜型"
            style="width: 100%"
            class="mt8"
          >
            <el-option
              v-for="c in containers"
              :key="c.id"
              :value="c.id"
              :label="`${c.label ? c.label + ' · ' : ''}${c.name}（内 ${c.innerLength}×${c.innerWidth}×${c.innerHeight}）`"
            />
          </el-select>
          <div class="pick-hint">
            已选 {{ containerIds.length }} 个柜型
            <template v-if="containerMode === 'single'">（单选模式：只保留最后选择的一项）</template>
            <template v-else>（多柜循环时按所选顺序依次装载，各柜型用完再换下一种）</template>
          </div>
        </el-card>

        <el-card shadow="never" header="货物与数量" class="mt16">
          <div class="pick-row">
            <el-radio-group v-model="selectMode" size="small">
              <el-radio-button value="single">单选</el-radio-button>
              <el-radio-button value="multi">多选</el-radio-button>
            </el-radio-group>
            <el-button
              v-if="selectedIds.length"
              link
              type="primary"
              size="small"
              @click="clearSelection"
            >
              清空
            </el-button>
          </div>

          <el-select
            v-model="selectedIds"
            multiple
            filterable
            clearable
            collapse-tags
            collapse-tags-tooltip
            :max-collapse-tags="3"
            :loading="loadingBoxes"
            placeholder="从货物管理中选择要装载的货物"
            style="width: 100%"
            class="mt8"
          >
            <el-option v-for="b in boxes" :key="b.id" :value="b.id" :label="`${b.name} · ${b.length}×${b.width}×${b.height}`" />
          </el-select>

          <div class="pick-hint">
            已选 {{ selectedIds.length }} 种货物<template v-if="selectMode === 'single'">（单选模式：只保留最后选择的一项）</template>
          </div>

          <!--
            只保留「货物 / 数量 / 移除」三列。
            左栏卡片内宽只有约 369px：四列（货物+尺寸+数量+移除）在 min-width 下
            合计 416px，放不下 —— el-table 会挤到某一列：
            先把「货物」压成"（禁…"，改小「数量」后 el-input-number 又被压成"…"
            （两次都实测复现过）。所以把**尺寸从独立列降级为货物名下方的副标题**
            —— 下拉选项与已选标签里本来就有"名称 · 尺寸"，这里重复一列纯属冗余。
          -->
          <el-table :data="selectedBoxRows" size="small" max-height="300" class="mt8" empty-text="请先从上方选择货物">
            <el-table-column label="货物" min-width="130">
              <template #default="{ row }">
                <div class="box-cell-name">{{ row.name }}</div>
                <div class="box-cell-dims">{{ row.length }}×{{ row.width }}×{{ row.height }}</div>
              </template>
            </el-table-column>
            <el-table-column label="数量" min-width="116">
              <template #default="{ row }">
                <el-input-number
                  v-model="quantities[row.id]"
                  :min="0"
                  :max="999999"
                  :placeholder="'不限'"
                  size="small"
                  controls-position="right"
                  style="width: 92px"
                />
              </template>
            </el-table-column>
            <el-table-column label="" width="52" align="center">
              <template #default="{ row }">
                <el-button link type="danger" size="small" @click="removeSelection(row.id)">移除</el-button>
              </template>
            </el-table-column>
          </el-table>
          <div class="pick-hint">数量留空 = <strong>不限</strong>，塞满柜子为止</div>
        </el-card>

        <el-card shadow="never" header="计算策略" class="mt16">
          <div class="mode-row">
            <el-radio-group v-model="loadMode" size="small">
              <el-radio-button value="single">单柜</el-radio-button>
              <el-radio-button value="multi">多柜循环</el-radio-button>
            </el-radio-group>
          </div>
          <div class="strategy-hint">
            <template v-if="loadMode === 'multi'">
              <strong>多柜循环装载</strong><br />
              同柜型循环装柜，直到全部装完或连续数柜一件都装不进；用于「需要多少个柜」的测算
            </template>
          </div>
          <div class="strategy-row mt12">
            <el-radio-group v-model="strategy">
              <el-radio v-for="n in 6" :key="n - 1" :value="n - 1" border size="large">{{ n - 1 }}</el-radio>
            </el-radio-group>
          </div>
          <div class="strategy-hint">
            <strong>{{ strategyName }}</strong>
            <br />
            {{ strategyHint }}
          </div>
          <el-checkbox v-model="lpEnabled" class="mt12">启用 LP 配比（线性规划优化）</el-checkbox>
          <div class="mt12">
            <el-button link type="primary" @click="advVisible = !advVisible">
              {{ advVisible ? '收起' : '展开' }}高级选项
              <span v-if="activeAdvCount > 0" class="adv-badge">{{ activeAdvCount }}</span>
            </el-button>
          </div>
          <el-card v-show="advVisible" shadow="never" class="adv-panel mt8">
            <div class="adv-grid">
              <div class="adv-item">
                <div class="adv-label">允许旋转</div>
                <el-switch v-model="adv.allowRotation" size="small" />
              </div>
              <div class="adv-item">
                <div class="adv-label">堆码级别约束</div>
                <el-switch v-model="adv.stackRulesEnabled" size="small" />
              </div>
              <div class="adv-item">
                <div class="adv-label">承托比例约束</div>
                <el-switch v-model="adv.supportRulesEnabled" size="small" />
              </div>
              <div class="adv-item">
                <div class="adv-label">候选块上限</div>
                <el-input-number v-model="adv.candidateLimit" :min="0" :max="10000" :step="10" size="small" controls-position="right" style="width: 100px" />
              </div>
              <div class="adv-item">
                <div class="adv-label">最大迭代轮数</div>
                <el-input-number v-model="adv.maxIterations" :min="100" :max="10000000" :step="1000" size="small" controls-position="right" style="width: 120px" />
              </div>
            </div>
            <div class="adv-note">关闭旋转则仅允许原方向 dir0；约束关闭后算法会忽略堆码/承托限制（结果更快但可能不符合物理摆放要求）。</div>
            <el-button link type="primary" size="small" @click="resetAdv">恢复默认</el-button>
          </el-card>
          <div class="mt16">
            <el-button type="primary" size="large" :loading="computing" @click="doCalculate">开始计算</el-button>
          </div>
        </el-card>
      </el-col>

      <!-- 右：结果 -->
      <el-col :span="16">
        <el-card shadow="never" header="计算结果" v-loading="computing">
          <template v-if="result && loadMode === 'single'">            <!-- 统计卡片 -->
            <el-row :gutter="12">
              <el-col :span="6">
                <div class="stat-card">
                  <div class="stat-label">装载率</div>
                  <el-progress type="dashboard" :percentage="Math.round(result.loadRate * 100)" :width="88" />
                </div>
              </el-col>
              <el-col :span="6">
                <div class="stat-card">
                  <div class="stat-label">占用体积 (m³)</div>
                  <div class="stat-value">{{ (result.usedVolume / 1e9).toFixed(2) }}</div>
                </div>
              </el-col>
              <el-col :span="6">
                <div class="stat-card">
                  <div class="stat-label">总重量 (kg)</div>
                  <div class="stat-value">{{ result.totalWeight.toFixed(1) }}</div>
                </div>
              </el-col>
              <el-col :span="6">
                <div class="stat-card">
                  <div class="stat-label">总件数</div>
                  <div class="stat-value">{{ result.pieces }}</div>
                </div>
              </el-col>
            </el-row>

            <div class="mt12 meta-line">
              策略 {{ result.strategy }} · 迭代 {{ result.iterations }} 次 · LP 配比：{{ result.lpEnabled ? '开启' : '关闭' }} ·
              逐件坐标 {{ cartons.length }} 个 · 实际分层 {{ layerRows.length }} 层
            </div>

            <!-- 三块布局：明细区 + 3D -->
            <el-row :gutter="12" class="mt12">
              <!-- 明细区 -->
              <el-col :span="10">
                <el-tabs v-model="detailTab" class="detail-tabs">
                  <!-- 装柜步骤（现场作业单） -->
                  <el-tab-pane :label="`装柜步骤（${stepRows.length}）`" name="steps">
                    <div class="step-toolbar">
                      <span class="step-order">顺序：自下而上，同层{{ doorAtMaxX ? '由深处向门口' : '由门口向深处' }}</span>
                      <el-radio-group v-model="doorAtMaxX" size="small">
                        <el-radio-button :value="true">柜门在深处端</el-radio-button>
                        <el-radio-button :value="false">柜门在本端</el-radio-button>
                      </el-radio-group>
                    </div>
                    <el-table
                      :data="stepRows"
                      size="small"
                      border
                      highlight-current-row
                      max-height="400"
                      row-key="step"
                      @current-change="onStepRowChange"
                    >
                      <el-table-column prop="step" label="步" width="30" align="center" />
                      <el-table-column label="货物 / 单箱占位">
                        <template #default="{ row }">
                          <div class="cell-nowrap">
                            <el-tag size="small" :type="ORIENTATION_SHORT[row.orientation] === '立放' ? 'warning' : ORIENTATION_SHORT[row.orientation] === '侧放' ? 'success' : 'info'">
                              {{ ORIENTATION_SHORT[row.orientation] }}
                            </el-tag>
                            <span class="step-name">{{ row.name }}</span>
                          </div>
                          <div class="cell-sub cell-nowrap">{{ row.dims[0] }}×{{ row.dims[1] }}×{{ row.dims[2] }}</div>
                        </template>
                      </el-table-column>
                      <el-table-column label="件数 / 累计" width="62" align="right">
                        <template #default="{ row }">
                          <div>{{ row.count }}</div>
                          <div class="cell-sub cell-nowrap">{{ containerVolume > 0 ? ((row.cumVolume / containerVolume) * 100).toFixed(1) + '%' : '-' }}</div>
                          <div class="cell-sub cell-nowrap">{{ row.cumCount }} 件</div>
                        </template>
                      </el-table-column>
                      <el-table-column label="占位区域 (mm)" width="94">
                        <template #default="{ row }">
                          <div class="cell-nowrap">X {{ row.xMin }}~{{ row.xMax }}</div>
                          <div class="cell-sub cell-nowrap">Z {{ row.zMin }}~{{ row.zMax }}</div>
                        </template>
                      </el-table-column>
                    </el-table>
                    <div class="step-toolbar step-actions">
                      <span class="layer-hint">点击步骤行可在 3D 中高亮该步骤装的箱子</span>
                      <el-button size="small" :disabled="stepRows.length === 0" @click="exportStepsCsv">导出装柜步骤 CSV</el-button>
                    </div>
                  </el-tab-pane>

                  <!-- 装入清单 -->
                  <el-tab-pane :label="`装入清单（${loadSummary.length}）`" name="load">
                    <el-table
                      :data="loadSummary"
                      size="small"
                      border
                      highlight-current-row
                      ref="loadTableRef"
                      max-height="460"
                      @current-change="onLoadRowChange"
                    >
                      <el-table-column prop="name" label="名称" min-width="110" show-overflow-tooltip />
                      <el-table-column prop="sku" label="SKU" width="90">
                        <template #default="{ row }">{{ row.sku || '-' }}</template>
                      </el-table-column>
                      <el-table-column prop="count" label="件数" width="70" align="right" />
                      <el-table-column label="体积 (m³)" width="90" align="right">
                        <template #default="{ row }">{{ (row.volume / 1e9).toFixed(3) }}</template>
                      </el-table-column>
                      <el-table-column label="重量 (kg)" width="90" align="right">
                        <template #default="{ row }">{{ row.weight.toFixed(1) }}</template>
                      </el-table-column>
                    </el-table>
                  </el-tab-pane>

                  <!-- 分层明细 -->
                  <el-tab-pane :label="`分层明细（${layerRows.length}）`" name="layers">
                    <el-table :data="layerRows" size="small" border max-height="460" row-key="level">
                      <el-table-column prop="level" label="层" width="56" align="center" />
                      <el-table-column label="z 区间 (mm)" width="110">
                        <template #default="{ row }">{{ row.zMin }} ~ {{ row.zMax }}</template>
                      </el-table-column>
                      <el-table-column prop="totalCount" label="件数" width="70" align="right" />
                      <el-table-column label="体积 (m³)" width="90" align="right">
                        <template #default="{ row }">{{ (row.totalVolume / 1e9).toFixed(3) }}</template>
                      </el-table-column>
                      <el-table-column label="货物明细" min-width="130">
                        <template #default="{ row }">
                          <el-tag v-for="it in row.items" :key="it.boxId" size="small" class="layer-tag" @click.stop="focusLayerItem(row, it)">
                            {{ it.name }} ×{{ it.count }}
                          </el-tag>
                        </template>
                      </el-table-column>
                    </el-table>
                    <div class="layer-hint">点击层内货物标签可高亮 3D 对应货物</div>
                  </el-tab-pane>

                  <!-- 未装列表 -->
                  <el-tab-pane :label="`未装（${rejectedList.length}）`" name="rejected">
                    <el-table :data="rejectedList" size="small" border max-height="460">
                      <el-table-column prop="boxId" label="货物 ID" width="130" show-overflow-tooltip />
                      <el-table-column label="原因" width="100">
                        <template #default="{ row }">
                          <el-tag :type="reasonTagType(row.reason)" size="small">{{ reasonLabel(row.reason) }}</el-tag>
                        </template>
                      </el-table-column>
                      <el-table-column label="说明" min-width="120">
                        <template #default="{ row }">
                          <span class="reason-desc">{{ reasonDesc(row.reason) }}</span>
                        </template>
                      </el-table-column>
                    </el-table>
                  </el-tab-pane>
                </el-tabs>
              </el-col>

              <!-- 3D 图 -->
              <el-col :span="14">
                <Packing3D :result="result" :boxes="boxes" :highlight-box-id="highlightBoxId" :highlight-placements="highlightPlacements" @select="on3DSelect" />
              </el-col>
            </el-row>

            <div class="mt12">
              <el-button type="success" :disabled="!containerId" @click="openSave">保存方案</el-button>
              <el-button :disabled="!result" @click="openReport('report')">导出装柜报表 PDF</el-button>
              <el-button :disabled="stepRows.length === 0" @click="openReport('steps')">导出装柜步骤 PDF</el-button>
              <el-button :disabled="cartons.length === 0" @click="exportCoords">导出逐箱坐标 CSV</el-button>
            </div>
          </template>
          <!-- 多柜循环结果 -->
          <template v-else-if="multiResult && loadMode === 'multi'">
            <el-row :gutter="12">
              <el-col :span="6">
                <div class="stat-card">
                  <div class="stat-label">需要柜数</div>
                  <div class="stat-value">{{ multiResult.totalContainers }}</div>
                </div>
              </el-col>
              <el-col :span="6">
                <div class="stat-card">
                  <div class="stat-label">总体装载率</div>
                  <el-progress type="dashboard" :percentage="Math.round(multiResult.overallRate * 100)" :width="88" />
                </div>
              </el-col>
              <el-col :span="6">
                <div class="stat-card">
                  <div class="stat-label">总体积 (m³)</div>
                  <div class="stat-value">{{ (multiResult.totalLoadedVolume / 1e9).toFixed(2) }}</div>
                </div>
              </el-col>
              <el-col :span="6">
                <div class="stat-card">
                  <div class="stat-label">剩余货物</div>
                  <div class="stat-value">{{ multiResult.remaining.length }}</div>
                </div>
              </el-col>
            </el-row>

            <el-alert
              v-if="multiResult.remaining.length"
              class="mt12"
              type="warning"
              :closable="false"
              :title="`有 ${multiResult.remaining.length} 种货物未能全部装入，详见下方剩余清单`"
            />

            <el-row :gutter="12" class="mt12">
              <!-- 柜列表 -->
              <el-col :span="9">
                <el-table
                  :data="multiResult.plans"
                  size="small"
                  border
                  highlight-current-row
                  max-height="520"
                  @current-change="onPlanRowChange"
                >
                  <el-table-column label="柜" width="60" align="center">
                    <template #default="{ $index }">{{ $index + 1 }}</template>
                  </el-table-column>
                  <el-table-column label="装载率" width="88" align="right">
                    <template #default="{ row }">{{ (row.loadRate * 100).toFixed(1) }}%</template>
                  </el-table-column>
                  <el-table-column label="箱数" width="76" align="right">
                    <template #default="{ row }">{{ row.placements.reduce((s, p) => s + p.count, 0) }}</template>
                  </el-table-column>
                  <el-table-column label="重量 (kg)" width="100" align="right">
                    <template #default="{ row }">{{ row.totalWeight.toFixed(0) }}</template>
                  </el-table-column>
                  <el-table-column label="货物构成" min-width="120">
                    <template #default="{ row }">
                      <el-tag v-for="it in planCargoSummary(row)" :key="it.boxId" size="small" class="plan-tag">
                        {{ it.name }} ×{{ it.count }}
                      </el-tag>
                    </template>
                  </el-table-column>
                </el-table>
                <div class="layer-hint">点击柜行切换 3D 对比</div>
              </el-col>

              <!-- 选中柜的 3D -->
              <el-col :span="15">
                <Packing3D
                  v-if="activePlan"
                  :result="activePlan"
                  :boxes="boxes"
                  :highlight-box-id="highlightBoxId"
                  :highlight-placements="highlightPlacements"
                  @select="on3DSelect"
                />
                <el-empty v-else description="没有有效的柜" />
              </el-col>
            </el-row>

            <div class="mt12">
              <el-button :disabled="activePlan === null" @click="exportMultiCoords">导出全部柜逐箱坐标 CSV</el-button>
              <!--
                多柜循环下也给出单据导出：现场是"一个柜一张作业单"，
                打印当前选中的这个柜（页眉会标"第 N / M 柜"），
                逐个柜切着导出即可，不必先把每个柜单独算一遍。
              -->
              <el-button :disabled="activePlan === null" @click="openReport('report')">导出装柜报表 PDF</el-button>
              <el-button :disabled="stepRows.length === 0" @click="openReport('steps')">导出装柜步骤 PDF</el-button>
            </div>
          </template>

          <el-empty v-else description="尚未计算，请先在左侧选择柜型并填写货物数量" />
        </el-card>
      </el-col>
    </el-row>

    <el-dialog v-model="saveVisible" title="保存装柜方案" width="420px">
      <el-form label-width="80px">
        <el-form-item label="方案名称" required>
          <el-input v-model="planName" placeholder="例如：40HQ 混合货物方案" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="saveVisible = false">取消</el-button>
        <el-button type="primary" @click="doSave">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useRouter } from 'vue-router';
import api, { type PlanRecord } from '../api/client';
import type { Box, CartonPlacement, Container, LoadOptions, MultiPlanResult, PackResult, Placement } from '../../types';
import { expandResult } from '../../algorithm/expand';
import Packing3D from '../components/Packing3D.vue';
import { setPlanDoc } from '../store/planDoc';
import {
  buildCartons,
  buildLayerRows,
  buildLoadSummary,
  buildStepRows,
  boxMetaOf,
  ORIENTATION_NAMES,
  ORIENTATION_SHORT,
  REASON_LABEL,
  type LayerRow,
  type LoadSummaryRow,
  type StepRow,
} from '../lib/packRows';

const PENDING_KEY = 'load_expert_pending_plan';

const containers = ref<Container[]>([]);
const boxes = ref<Box[]>([]);
const loadingBoxes = ref(false);
const router = useRouter();
/**
 * 从「方案列表」加载进来的方案名（`planName` 是「保存方案」对话框里的输入框，
 * 与历史方案名不是同一个东西，故单独存一份给报表页用）
 */
const pendingPlanName = ref('');
/**
 * 柜型选取状态（单选 / 多选）
 *
 * 与「货物与数量」同一个套路：el-select 始终是 `multiple`（一个控件两种模式），
 * 单选由下面的 watch 强制只保留**最后选择**的一项。
 * 若让 single 模式走 `:multiple="false"`，v-model 会变成标量语义，
 * 而绑的还是数组 —— 会表现为"已选 1 个柜型但下拉框仍是占位符"。
 *
 * `containerId` 是**派生**出来的第一个选中项 —— 大量单柜路径（保存方案、
 * 历史方案回填、后端单柜计算）都只要"一个柜型"，让它们继续读 `containerId`
 * 就不必到处改成数组。
 */
const containerMode = ref<'single' | 'multi'>('single');
const containerIds = ref<string[]>([]);
const containerId = computed<string | number | null>(() => containerIds.value[0] ?? null);

/** 已选柜型（按柜型管理的原始顺序排列，便于对照） */
const selectedContainers = computed<Container[]>(() => containers.value.filter((c) => containerIds.value.includes(c.id)));

watch(containerIds, (v) => {
  if (containerMode.value === 'single' && v.length > 1) {
    containerIds.value = [v[v.length - 1]];
  }
});

/**
 * 货物数量：`undefined` = **不限**（塞满柜子为止）
 *
 * 用户明确要求「数量没有填写是不限」。故不能沿用旧的"数量为 0 就报错"校验 ——
 * 留空恰恰是最常用的一种表达。
 */
const quantities = reactive<Record<string, number | undefined>>({});

/**
 * 「货物与数量」的选取状态
 *
 * 参与计算的货物由 **`selectedIds`（用户选了什么）** 决定，
 * 而不是"表格里所有行里数量 > 0 的那些"（旧实现把货物管理的全部货物都列出来，
 * 靠数量是否 > 0 来隐式筛选 —— 货物一多就是一屏噪音，且看不出"哪些是我选的"）。
 *
 * - `selectMode = 'single'`：单选。el-select 始终是 multiple（一个控件两种模式），
 *   由 watch 强制只保留**最后选择**的一项（EP 的 multiple 是追加语义，新项在末尾）。
 * - `selectMode = 'multi'`：多选，可任意增删。
 */
const selectMode = ref<'single' | 'multi'>('multi');
const selectedIds = ref<string[]>([]);

/** 已选货物（按货物管理的原始顺序排列，便于对照） */
const selectedBoxRows = computed<Box[]>(() => boxes.value.filter((b) => selectedIds.value.includes(b.id)));

watch(selectedIds, (v) => {
  if (selectMode.value === 'single' && v.length > 1) {
    selectedIds.value = [v[v.length - 1]];
  }
});

function removeSelection(id: string): void {
  selectedIds.value = selectedIds.value.filter((x) => x !== id);
}

function clearSelection(): void {
  selectedIds.value = [];
}
const strategy = ref(3);
const lpEnabled = ref(false);
/** 装载模式：单柜 / 多柜循环（多柜此前后端已就绪但前端无入口） */
const loadMode = ref<'single' | 'multi'>('single');
/** 多柜计算结果 */
const multiResult = ref<MultiPlanResult | null>(null);
/** 当前选中的柜（用于 3D 对比） */
const activePlanIndex = ref(0);

/** 策略名称与几何特征说明（与算法侧 STRATEGY_NAMES / STRATEGY_HINTS 对齐） */
const STRATEGY_NAMES: Record<number, string> = {
  0: '单方向条块',
  1: '单层薄片',
  2: '逐层残层',
  3: '满舱主块（基准）',
  4: '承托分级分层',
  5: '均衡层高',
};
const STRATEGY_HINTS: Record<number, string> = {
  0: '只沿最长轴铺一条线，细长条块，为其它货物留出最大空间',
  1: '横向铺满一个面、竖直只放一层，主动为上方保留空腔',
  2: '每次放一层但允许末层不足整行，货物数量不整除时能多装',
  3: '三轴尽可能堆满且只吃整层，装载率最高，作为对照基准',
  4: '层数不超过货物自身堆码级别，尊重承载能力，装载率低于满舱',
  5: '按可用件数反推层数、够用即止，块的竖直占位更贴合实际货量',
};
// 切换装载模式时清空另一模式的结果，避免展示陈旧数据
watch(loadMode, (m) => {
  if (m === 'multi') {
    result.value = null;
    rejectedList.value = [];
  } else {
    multiResult.value = null;
    activePlanIndex.value = 0;
  }
  highlightBoxId.value = null;
  highlightPlacements.value = null;
});

const strategyName = computed(() => STRATEGY_NAMES[strategy.value] ?? '未知策略');
const strategyHint = computed(() => STRATEGY_HINTS[strategy.value] ?? '');

/** 高级选项（对应后端 LoadOptions，此前后端全支持但前端未透传） */
const ADV_DEFAULT = {
  allowRotation: true,
  stackRulesEnabled: true,
  supportRulesEnabled: true,
  candidateLimit: 0,
  maxIterations: 100000,
} as const;
const adv = reactive({ ...ADV_DEFAULT });
const advVisible = ref(false);
/** 偏离默认值的项数（用于角标提示） */
const activeAdvCount = computed(() => {
  let n = 0;
  if (adv.allowRotation !== ADV_DEFAULT.allowRotation) n++;
  if (adv.stackRulesEnabled !== ADV_DEFAULT.stackRulesEnabled) n++;
  if (adv.supportRulesEnabled !== ADV_DEFAULT.supportRulesEnabled) n++;
  if (adv.candidateLimit !== ADV_DEFAULT.candidateLimit) n++;
  if (adv.maxIterations !== ADV_DEFAULT.maxIterations) n++;
  return n;
});
function resetAdv() {
  Object.assign(adv, ADV_DEFAULT);
  ElMessage.info('高级选项已恢复默认');
}

/** 组装随计算请求透传的 options */
function buildOptions(): LoadOptions {
  return {
    lpEnabled: lpEnabled.value,
    allowRotation: adv.allowRotation,
    stackRulesEnabled: adv.stackRulesEnabled,
    supportRulesEnabled: adv.supportRulesEnabled,
    candidateLimit: adv.candidateLimit,
    maxIterations: adv.maxIterations,
  };
}
const computing = ref(false);
const result = ref<PackResult | null>(null);
const rejectedList = ref<Array<{ boxId: string; reason: string }>>([]);
const saveVisible = ref(false);
const planName = ref('');

/** 明细区激活 tab */
const detailTab = ref<'load' | 'layers' | 'rejected'>('load');
/** 联动高亮状态：3D 点击或表格行点击后同步 */
const highlightBoxId = ref<string | null>(null);
const loadTableRef = ref<{ setCurrentRow: (row: unknown) => void } | null>(null);

function boxMeta(boxId: string): Box | undefined {
  return boxMetaOf(boxes.value, boxId);
}

/**
 * 逐件坐标（把聚合 placement 展开到单箱）
 * 用于「分层明细」按真实 z 底面分层、3D 逐箱渲染、坐标导出
 *
 * 注：行数据的派生逻辑（装入清单/分层明细/装柜步骤）已抽到 `lib/packRows.ts`，
 * 由本页与打印报表页 `ReportView` **共用同一份实现** ——
 * 否则会出现"打印出来的步骤单和页面上看到的对不上"，那是不可接受的缺陷。
 */
const cartons = computed<CartonPlacement[]>(() => buildCartons(result.value, boxes.value));

/** 装入清单：按货物类型聚合（实现见 lib/packRows.ts，与打印报表共用） */
const loadSummary = computed<LoadSummaryRow[]>(() => buildLoadSummary(result.value, boxes.value));

/**
 * 分层明细：按每箱真实 z 底面分层（实现见 lib/packRows.ts，与打印报表共用）
 *
 * 原实现用聚合 placement 的包围盒做 z 区间重叠判定，一个 3 层高的聚合块
 * 会被算成 1 层（200³ 小箱装出 dims=[5800,2200,600] count=957 却只报 1 层）。
 * 现改为直接用逐件坐标按 z 底面聚合，与后端 summarizeLayers 口径一致。
 */
const layerRows = computed<LayerRow[]>(() => buildLayerRows(cartons.value, result.value, boxes.value));

/** 装柜步骤的排序方向：柜门在哪一端（容器模型未记录门位，故做成可见的显式约定） */
const doorAtMaxX = ref(true);

/** 柜内容积（mm³），用于步骤的累计装载率 */
const containerVolume = computed<number>(() => {
  const c = result.value?.container;
  return c ? c.innerLength * c.innerWidth * c.innerHeight : 0;
});

/**
 * 装柜步骤行
 *
 * 一步 = 一个聚合放置（result.placements 的一条），即"把这块推进去"这一个动作。
 * 逐件坐标里带 placementIndex，故可把逐箱精确归到所属步骤。
 *
 * 行类型与派生实现都在 `lib/packRows.ts`，与打印报表页共用（排序规则与诚实标注见该文件）。
 */

/**
 * 装柜步骤：由逐件坐标按 placementIndex 归组，再排成物理上可执行的顺序
 * （实现见 lib/packRows.ts，与打印报表共用同一份逻辑）
 */
const stepRows = computed<StepRow[]>(() =>
  buildStepRows(cartons.value, boxes.value, doorAtMaxX.value, containerVolume.value),
);

/** 当前高亮的装柜步骤（placementIndex 集合） */
const highlightPlacements = ref<number[] | null>(null);

/** 点击步骤行：高亮该步骤在 3D 中的箱子，并按货物类型联动左侧清单 */
function onStepRowChange(row: StepRow | null) {
  if (!row) {
    highlightPlacements.value = null;
    highlightBoxId.value = null;
    return;
  }
  highlightPlacements.value = [row.placementIndex];
  highlightBoxId.value = null;
}

/** 导出装柜步骤 CSV（现场可直接照着装的作业单） */
function exportStepsCsv() {
  const rows = stepRows.value;
  if (rows.length === 0) {
    ElMessage.warning('没有可导出的装柜步骤');
    return;
  }
  const head = [
    '步骤',
    '货物名称',
    'SKU',
    '姿态',
    '单箱占位X(mm)',
    '单箱占位Y(mm)',
    '单箱占位Z(mm)',
    '件数',
    '区域X起(mm)',
    '区域X止(mm)',
    '区域Y起(mm)',
    '区域Y止(mm)',
    '区域Z起(mm)',
    '区域Z止(mm)',
    '体积(m³)',
    '重量(kg)',
    '累计件数',
    '累计体积(m³)',
  ];
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.step,
        r.name,
        r.sku,
        ORIENTATION_NAMES[r.orientation] ?? `dir${r.orientation}`,
        r.dims[0],
        r.dims[1],
        r.dims[2],
        r.count,
        r.xMin,
        r.xMax,
        r.yMin,
        r.yMax,
        r.zMin,
        r.zMax,
        (r.volume / 1e9).toFixed(4),
        r.weight.toFixed(2),
        r.cumCount,
        (r.cumVolume / 1e9).toFixed(4),
      ].join(','),
    );
  }
  const c = result.value?.container;
  const header = [
    '# 装柜步骤单',
    `# 柜型: ${c ? `${c.label ?? ''} ${c.name}`.trim() : ''}`,
    `# 内尺寸(mm): ${c ? `${c.innerLength}×${c.innerWidth}×${c.innerHeight}` : ''}`,
    `# 装柜顺序: 自下而上；同层${doorAtMaxX.value ? '由柜内深处向门口推进' : '由门口向柜内推进'}`,
    `# 装载率: ${((result.value?.loadRate ?? 0) * 100).toFixed(2)}%`,
  ];
  downloadCsv([...header, '', ...lines], `装柜步骤_${c?.label ?? 'container'}.csv`);
  ElMessage.success(`已导出 ${rows.length} 个装柜步骤`);
}

/** 未装原因说明文案（REASON_LABEL 已移入 lib/packRows.ts，与打印报表共用） */
const REASON_DESC: Record<string, string> = {
  'weight-exceed': '单件或累计超过柜体载重约束',
  'volume-exceed': '剩余空间不足以容纳该货物体积',
  'space-exhausted': '剩余空间已无可用放置区域',
  'no-fit': '任意方向姿态均无法放入剩余空间',
  'iteration-limit': '达到迭代上限仍未找到可放置位置',
  'lp-capped': 'LP 体积配比求解给出的建议数量少于可用数量',
  'stack-class-exceed': '本货物堆码级别高于下方货物的承托级别',
  'support-pct-exceed': '底部接触面积占比低于该货物要求的最少承托比例',
  'support-pct-invalid': '最少承托比例字段大于 100%，判定为非法',
  'no-support': '离地放置但下方找不到任何承托，判定为悬空',
  UNCERTAIN: '算法未提供明确原因，按放置上下文推断（代码标注 UNCERTAIN）',
};
function reasonLabel(reason: string): string {
  return REASON_LABEL[reason] ?? 'UNCERTAIN';
}
function reasonDesc(reason: string): string {
  return REASON_DESC[reason] ?? REASON_DESC['UNCERTAIN'];
}
function reasonTagType(reason: string): 'danger' | 'warning' | 'info' {
  if (reason === 'weight-exceed') return 'danger';
  if (reason === 'no-fit' || reason === 'space-exhausted') return 'warning';
  if (reason === 'stack-class-exceed' || reason === 'support-pct-exceed' || reason === 'no-support' || reason === 'support-pct-invalid') {
    return 'warning';
  }
  return 'info';
}

/** 装入清单行选中 → 高亮 3D */
function onLoadRowChange(row: LoadSummaryRow | null) {
  highlightBoxId.value = row ? row.boxId : null;
}

/** 分层明细标签点击 → 高亮 3D */
function focusLayerItem(_row: LayerRow, item: { boxId: string }) {
  highlightBoxId.value = item.boxId;
  detailTab.value = 'load';
  const target = loadSummary.value.find((s) => s.boxId === item.boxId) ?? null;
  loadTableRef.value?.setCurrentRow(target);
}

/** 3D 点击选中 → 联动装入清单表格 */
function on3DSelect(boxId: string) {
  highlightBoxId.value = boxId;
  const target = loadSummary.value.find((s) => s.boxId === boxId) ?? null;
  loadTableRef.value?.setCurrentRow(target);
}

async function loadBaseData() {
  try {
    containers.value = await api.listContainers();
    if (containers.value.length && containerIds.value.length === 0) {
      containerIds.value = [containers.value[containers.value.length - 1].id];
    }
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
  loadingBoxes.value = true;
  try {
    boxes.value = await api.listBoxes();
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    loadingBoxes.value = false;
  }
}

function selectedBoxes(): Box[] {
  return selectedBoxRows.value.map((b) => ({ ...b, quantity: effectiveQty(b) }));
}

/**
 * 某货物在所选柜型下的**几何容量上限**（件）
 *
 * 用户要求「数量留空 = 不限，塞满柜子为止」。算法侧的 `qty` 是一个**上限**
 * （实际装多少由几何与载重约束决定），所以"不限"只需给一个**足够大的上限**。
 *
 * 用柜内容积 ÷ 单箱体积取整，而不是随手写个 999999：
 * - 报表里显示的是一个有意义的数字（"这个柜最多也就装 2900 箱"），不是假数
 * - 上限够小就不会在"数量不限"时为无用的大数去做配比/循环
 */
function geometricCapacity(box: Box): number {
  const one = box.length * box.width * box.height;
  if (!(one > 0)) return 1;
  // 多选柜型时按最大的那个柜算，否则会被小柜型的容量错误截断
  let maxVol = 0;
  for (const c of selectedContainers.value) {
    maxVol = Math.max(maxVol, c.innerLength * c.innerWidth * c.innerHeight);
  }
  if (maxVol <= 0) return 99999;
  return Math.max(1, Math.floor(maxVol / one));
}

/** 某货物本次实际提交的件数：填了就按填的，没填就算几何容量（即"不限"） */
function effectiveQty(box: Box): number {
  const q = quantities[box.id];
  return typeof q === 'number' && Number.isFinite(q) && q >= 0 ? q : geometricCapacity(box);
}

/** 该货物是否处于「不限」状态（数量留空） */
function isUnlimited(boxId: string): boolean {
  const q = quantities[boxId];
  return !(typeof q === 'number' && Number.isFinite(q));
}

/**
 * 校验已选货物是否可以开始计算
 *
 * ## 「数量留空 = 不限」
 * 用户明确要求这个语义。旧实现把"数量为 0"当未填完并报错，现在改为
 * 「填了就按填的算，没填就算几何容量上限」——
 * 留空恰恰是最常用的表达（"这批货有多少装多少"），报错反而挡路。
 *
 * 但**显式填 0** 仍按 0 件处理（与"不限"区分开）：填 0 是明确表示不装，
 * 留空是"没填"。两者在 el-input-number 上表现相同，故以 undefined 为准 ——
 * 用户若真要 0 件，应该点「移除」把它移出本次装载。
 */
function validateSelection(): Array<{ boxId: string; qty: number }> | null {
  const rows = selectedBoxRows.value;
  if (rows.length === 0) {
    ElMessage.warning('请先在「货物与数量」中从货物管理选择要装载的货物');
    return null;
  }
  const zero = rows.filter((b) => quantities[b.id] === 0).map((b) => b.name);
  if (zero.length > 0) {
    ElMessage.warning(`以下已选货物数量为 0：${zero.join('、')}（要"不限"就把数量清空；要不装就点「移除」）`);
    return null;
  }
  return rows.map((b) => ({ boxId: b.id, qty: effectiveQty(b) }));
}

/**
 * 多柜循环装载：**按所选柜型的顺序依次装载**
 *
 * 用户要求「柜型选择支持单选和多选」。多选多个柜型时的语义是
 * "这批货可以用这些柜型装" —— 于是按用户勾选的顺序，一种柜型装到底
 * （装到再装一个就空为止），再换下一种；所有柜型都过一遍后收工。
 *
 * ## 为什么在前端编排，而不是给后端加一个"多柜型"接口
 * - 后端 `planMultiContainer` 只吃**一种**容器，语义干净、已被 64 项测试覆盖；
 *   改它的签名去接数组，等于把"一个柜型装到底"和"换柜型"两件事糅在一起。
 * - 前端编排 = 复用同一个成熟端点若干次，每种柜型仍各自跑一遍原算法。
 *   代价是要在前端把各次结果合成一个 `MultiPlanResult`，逻辑集中在下面的
 *   `mergeMultiResults` 一个函数里，可测。
 *
 * `maxEmptyRounds: 1` —— 一种柜型连一箱都装不进，就立刻换下一种，
 * 免得每种柜型白跑默认的 3 轮完整计算。
 */
async function calculateAcrossContainers(
  items: Array<{ boxId: string; qty: number }>,
  options: LoadOptions,
): Promise<MultiPlanResult> {
  let remaining = items.map((i) => ({ ...i }));
  const plans: PackResult[] = [];

  for (const cid of containerIds.value) {
    if (remaining.length === 0) break;
    const m = await api.calculateMulti({
      containerId: cid,
      items: remaining,
      strategy: strategy.value,
      options,
      maxEmptyRounds: 1,
    });
    plans.push(...m.plans);

    // 扣减剩余：按本次装入数逐项减，减到 0 的从剩余清单里去掉
    const placed = new Map<string, number>();
    for (const p of m.plans) {
      for (const pl of p.placements) {
        placed.set(pl.boxId, (placed.get(pl.boxId) ?? 0) + pl.count);
      }
    }
    remaining = remaining
      .map((r) => ({ boxId: r.boxId, qty: Math.max(0, r.qty - (placed.get(r.boxId) ?? 0)) }))
      .filter((r) => r.qty > 0);
  }

  return mergeMultiResults(plans, remaining);
}

/**
 * 把多次调用攒下的柜结果合成一个 `MultiPlanResult`（后端单柜型的返回结构）
 *
 * 汇总口径与 `planMultiContainer` 尾部一致：总体装载率 = 已装体积 / 总柜内容积，
 * 且**分母只算真正装了东西的柜**（plans 里本来就只含有效柜）。
 */
function mergeMultiResults(plans: PackResult[], remaining: Array<{ boxId: string; qty: number }>): MultiPlanResult {
  const totalLoadedVolume = plans.reduce((s, p) => s + p.usedVolume, 0);
  const totalContainerVolume = plans.reduce((s, p) => s + containerVolumeOf(p.container), 0);
  return {
    plans,
    totalContainers: plans.length,
    totalLoadedVolume,
    totalContainerVolume,
    overallRate: totalContainerVolume > 0 ? totalLoadedVolume / totalContainerVolume : 0,
    remaining,
  };
}

/** 柜内容积（mm³）。与算法侧 containerVolume 同一公式，此处独立实现以免跨层依赖 */
function containerVolumeOf(c: { innerLength: number; innerWidth: number; innerHeight: number }): number {
  return c.innerLength * c.innerWidth * c.innerHeight;
}

async function doCalculate() {
  if (containerId.value == null) {
    ElMessage.warning('请先选择柜型');
    return;
  }
  const items = validateSelection();
  if (!items) {
    return;
  }
  computing.value = true;
  try {
    const options = buildOptions();
    if (loadMode.value === 'multi') {
      const m = await calculateAcrossContainers(items, options);
      multiResult.value = m;
      result.value = m.plans[0] ?? null;
      activePlanIndex.value = 0;
      rejectedList.value = m.remaining.map((r) => ({
        boxId: r.boxId,
        reason: 'no-fit',
      }));
      highlightBoxId.value = null;
      highlightPlacements.value = null;
      loadTableRef.value?.setCurrentRow(null);
      const left = m.remaining.length;
      const kinds = new Set(m.plans.map((p) => p.container.id)).size;
      const kindNote = kinds > 1 ? `（含 ${kinds} 种柜型）` : '';
      ElMessage.success(
        left > 0
          ? `需要 ${m.totalContainers} 个柜${kindNote}；${left} 种货物有剩余`
          : `需要 ${m.totalContainers} 个柜${kindNote}，全部装完`,
      );
    } else {
      multiResult.value = null;
      result.value = await api.calculate({
        containerId: containerId.value,
        items,
        strategy: strategy.value,
        options,
      });
      rejectedList.value = result.value.rejected ?? [];
      highlightBoxId.value = null;
      highlightPlacements.value = null;
      loadTableRef.value?.setCurrentRow(null);
      ElMessage.success('计算完成');
    }
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    computing.value = false;
  }
}

/** 当前选中的柜（多柜模式下用于 3D 对比） */
const activePlan = computed<PackResult | null>(() => {
  if (loadMode.value !== 'multi' || !multiResult.value) {
    return result.value;
  }
  return multiResult.value.plans[activePlanIndex.value] ?? null;
});

/** 某柜的货物构成（用于柜列表标签） */
function planCargoSummary(plan: PackResult): Array<{ boxId: string; name: string; count: number }> {
  const m = new Map<string, number>();
  for (const p of plan.placements) {
    m.set(p.boxId, (m.get(p.boxId) ?? 0) + p.count);
  }
  return [...m.entries()].map(([boxId, count]) => ({ boxId, name: boxMeta(boxId)?.name ?? `货物 ${boxId}`, count }));
}

function onPlanRowChange(row: PackResult | null) {
  if (!row || !multiResult.value) return;
  const idx = multiResult.value.plans.indexOf(row);
  if (idx >= 0) {
    activePlanIndex.value = idx;
    highlightBoxId.value = null;
  }
}

/** 导出全部柜的逐箱坐标（每柜一段，含柜号列） */
function exportMultiCoords() {
  if (!multiResult.value || multiResult.value.plans.length === 0) {
    ElMessage.warning('没有可导出的柜');
    return;
  }
  const header = ['柜号', '序号', '货物ID', '货物名称', 'SKU', '方向', 'X(mm)', 'Y(mm)', 'Z(mm)', '长(mm)', '宽(mm)', '高(mm)', '体积(m³)', '重量(kg)'];
  const lines: string[] = [header.join(',')];
  multiResult.value.plans.forEach((plan, pi) => {
    const cartons = expandResult(plan, boxes.value);
    for (const ct of cartons) {
      const b = boxMeta(ct.boxId);
      lines.push(
        [
          pi + 1,
          ct.index + 1,
          ct.boxId,
          b?.name ?? '',
          b?.sku ?? '',
          `dir${ct.orientation}`,
          Math.round(ct.x),
          Math.round(ct.y),
          Math.round(ct.z),
          Math.round(ct.dims[0]),
          Math.round(ct.dims[1]),
          Math.round(ct.dims[2]),
          ((ct.dims[0] * ct.dims[1] * ct.dims[2]) / 1e9).toFixed(6),
          (b?.weight ?? 0).toFixed(3),
        ].join(','),
      );
    }
  });
  downloadCsv(lines, `packing-coords-${multiResult.value.totalContainers}containers-${Date.now()}.csv`);
  ElMessage.success(`已导出 ${multiResult.value.plans.length} 个柜的逐箱坐标`);
}

/** 触发 CSV 下载（BOM 前缀保证 Excel 正确识别 UTF-8 中文） */
function downloadCsv(lines: string[], filename: string): void {
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * 打开打印/报表页（装柜报表 或 装柜步骤单）
 *
 * 走**独立的 /report 路由**而不是直接 `window.print()`：
 * 计算结果住在本页组件状态里，`router.push` 不会带着走，
 * 故先把单据交接给 `store/planDoc`，报表页再渲染并唤起打印。
 *
 * 采用「打印 → 另存为 PDF」而非前端 PDF 库的原因见 ReportView 的说明：
 * PDF 规范没有内置中文字体，jsPDF/pdfmake 要显示中文必须内嵌 CJK 字体
 * （微软雅黑约 19MB），为一个打印功能付出这种体积不划算；
 * 而浏览器的打印到 PDF 是**真矢量文字**、中文天然正确、
 * 表格还能跨页自动重复表头 —— 正是报表/步骤单需要的。
 */
function openReport(kind: 'report' | 'steps' | 'all') {
  // 多柜循环时导出**当前正在看的那个柜**，而不是永远第一个 ——
  // 现场拿着步骤单照着装，看的就是柜列表里选中的那个柜。
  const target = kind === 'steps' ? activePlan.value : (activePlan.value ?? result.value);
  if (!target) {
    ElMessage.warning('请先完成一次计算');
    return;
  }
  if (kind === 'steps' && stepRows.value.length === 0) {
    ElMessage.warning('没有可导出的装柜步骤（逐件坐标为空，历史方案可能缺少货物尺寸数据）');
    return;
  }
  // 申请数量：留空（不限）传 null，报表上才显示「不限」而不是几何容量那个假数
  const requested: Record<string, number | null> = {};
  for (const b of selectedBoxRows.value) {
    requested[b.id] = isUnlimited(b.id) ? null : (quantities[b.id] ?? null);
  }
  setPlanDoc({
    result: target,
    boxes: boxes.value,
    planName: planName.value.trim() || pendingPlanName.value || `方案_${new Date().toISOString().slice(0, 10)}`,
    doorAtMaxX: doorAtMaxX.value,
    requested,
    multi: loadMode.value === 'multi',
    containerIndex: activePlanIndex.value,
    containerTotal: multiResult.value?.totalContainers ?? 1,
  });
  router.push({ path: '/report', query: { doc: kind } });
}

/** 导出逐箱坐标 CSV（每行一箱，含单箱尺寸与姿态） */
function exportCoords() {
  if (cartons.value.length === 0) {
    ElMessage.warning('没有可导出的逐箱坐标');
    return;
  }
  const header = ['序号', '货物ID', '货物名称', 'SKU', '方向', 'X(mm)', 'Y(mm)', 'Z(mm)', '长(mm)', '宽(mm)', '高(mm)', '体积(m³)', '重量(kg)'];
  const lines: string[] = [header.join(',')];
  for (const ct of cartons.value) {
    const b = boxMeta(ct.boxId);
    const vol = (ct.dims[0] * ct.dims[1] * ct.dims[2]) / 1e9;
    const wt = b?.weight ?? 0;
    lines.push(
      [
        ct.index + 1,
        ct.boxId,
        b?.name ?? '',
        b?.sku ?? '',
        `dir${ct.orientation}`,
        Math.round(ct.x),
        Math.round(ct.y),
        Math.round(ct.z),
        Math.round(ct.dims[0]),
        Math.round(ct.dims[1]),
        Math.round(ct.dims[2]),
        vol.toFixed(6),
        wt.toFixed(3),
      ].join(','),
    );
  }
  downloadCsv(lines, `packing-coords-${Date.now()}.csv`);
  ElMessage.success(`已导出 ${cartons.value.length} 条逐箱坐标`);
}

function openSave() {
  planName.value = '';
  saveVisible.value = true;
}

async function doSave() {
  if (!planName.value.trim()) {
    ElMessage.warning('请填写方案名称');
    return;
  }
  if (!result.value || containerId.value == null) {
    ElMessage.warning('没有可保存的计算结果');
    return;
  }
  try {
    await api.createPlan({
      name: planName.value.trim(),
      containerId: containerId.value,
      boxes: selectedBoxes(),
      result: result.value,
    });
    ElMessage.success('方案已保存');
    saveVisible.value = false;
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

onMounted(() => {
  void loadBaseData();
  // 从方案列表跳转加载的历史方案
  const pending = localStorage.getItem(PENDING_KEY);
  if (pending) {
    try {
      const plan = JSON.parse(pending) as PlanRecord;
      containerIds.value = [plan.containerId];
      containerMode.value = 'single';
      // 恢复历史方案：同时回填数量**与选中状态**（否则货物虽在表里却不会被装载）
      const ids: string[] = [];
      for (const b of plan.boxes) {
        quantities[b.id] = b.quantity ?? 1;
        if (!ids.includes(b.id)) {
          ids.push(b.id);
        }
      }
      selectedIds.value = ids;
      pendingPlanName.value = plan.name ?? '';
      if (ids.length > 1) {
        selectMode.value = 'multi';
      }
      result.value = plan.result;
      rejectedList.value = plan.result.rejected ?? [];
      ElMessage.success(`已加载方案：${plan.name}`);
    } catch {
      // 数据损坏则忽略
    } finally {
      localStorage.removeItem(PENDING_KEY);
    }
  }
});
</script>

<style scoped>
.pick-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.pick-hint {
  margin-top: 6px;
  font-size: 12px;
  color: #909399;
}
.box-cell-name {
  line-height: 1.3;
}
.box-cell-dims {
  font-size: 12px;
  color: #909399;
  line-height: 1.3;
}
.mt12 {
  margin-top: 12px;
}
.mt16 {
  margin-top: 16px;
}
.strategy-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.strategy-hint {
  margin-top: 8px;
  font-size: 12px;
  color: #909399;
  line-height: 1.6;
}
.mode-row {
  margin-bottom: 4px;
}
.adv-panel {
  background: #fafafa;
  border: 1px solid #ebeef5;
}
.adv-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 12px;
}
.adv-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}
.adv-label {
  font-size: 13px;
  color: #606266;
  white-space: nowrap;
}
.adv-note {
  margin: 10px 0 4px;
  font-size: 12px;
  line-height: 1.6;
  color: #909399;
}
.adv-badge {
  display: inline-block;
  min-width: 16px;
  padding: 0 5px;
  margin-left: 4px;
  border-radius: 8px;
  background: #409eff;
  color: #fff;
  font-size: 12px;
  line-height: 16px;
  text-align: center;
}
.plan-tag {
  margin: 2px 4px 2px 0;
}
.stat-card {
  text-align: center;
  padding: 8px 0;
}
.stat-label {
  font-size: 13px;
  color: #909399;
  margin-bottom: 8px;
}
.stat-value {
  font-size: 24px;
  font-weight: 600;
  color: #303133;
  line-height: 88px;
}
.meta-line {
  color: #909399;
  font-size: 13px;
}
.detail-tabs :deep(.el-tabs__content) {
  padding-top: 8px;
}
.layer-tag {
  margin: 2px 4px 2px 0;
  cursor: pointer;
}
.layer-hint {
  margin-top: 6px;
  font-size: 12px;
  color: #909399;
}
.step-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}
.step-order {
  font-size: 12px;
  color: #909399;
  line-height: 1.4;
}
.step-actions {
  margin-top: 0;
  margin-bottom: 2px;
}
.step-name {
  margin-left: 4px;
}
.cell-sub {
  font-size: 11px;
  color: #909399;
  line-height: 1.3;
}
/* 尺寸/坐标不允许折行 —— "380×515×42 / 5" 这种断法会被误读成另一个尺寸 */
.cell-nowrap {
  white-space: nowrap;
}
.reason-desc {
  font-size: 12px;
  color: #606266;
}
</style>
