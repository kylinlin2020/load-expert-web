<template>
  <div class="about-page">
    <!-- ══════════ 版本 ══════════ -->
    <el-card shadow="never" class="ver-card">
      <div class="ver-head">
        <div>
          <div class="ver-label">应用版本</div>
          <div class="ver-num">{{ appVersion.version }}</div>
          <div class="ver-src">
            版本号来源：<strong>{{ sourceText }}</strong>
            <span v-if="appVersion.commit !== null"> · 第 {{ appVersion.commit }} 次提交</span>
          </div>
        </div>
        <div class="ver-right">
          <el-tag v-if="appVersion.commitShort" type="info" effect="plain" size="small">
            提交 {{ appVersion.commitShort }}
          </el-tag>
          <el-tag v-if="appVersion.dirty" type="warning" size="small">工作区有未提交改动</el-tag>
        </div>
      </div>

      <!--
        dirty 必须显式提示：版本号来自"上一次提交"，而页面上的代码可能已经变了。
        不标注的话，看到 0.1.12 的人会以为它精确对应某次提交，其实不对。
      -->
      <el-alert
        v-if="appVersion.dirty"
        class="mt12"
        type="warning"
        show-icon
        :closable="false"
        title="当前工作区有未提交的改动"
        description="上面的版本号取自最近一次 git 提交，而页面上的代码可能已经比它更新了。提交后版本号会自动 +1。"
      />
      <el-alert
        v-else-if="appVersion.source === 'package.json'"
        class="mt12"
        type="info"
        show-icon
        :closable="false"
        title="未初始化 git，版本号不会自增"
        description="当前版本直接取自 package.json。在项目目录执行 git init 并提交后，每次提交版本号自动 +1。"
      />

      <div class="tbl-scroll">
        <table class="kv mt12">
          <tbody>
            <tr>
              <th>版本号</th>
              <td>{{ appVersion.version }}</td>
              <th>提交数</th>
              <td>{{ appVersion.commit ?? '—' }}</td>
            </tr>
            <tr>
              <th>短提交号</th>
              <td>{{ appVersion.commitShort ?? '—' }}</td>
              <th>提交时间</th>
              <td>{{ fmtTime(appVersion.commitDate) }}</td>
            </tr>
            <tr>
              <th>本次构建时间</th>
              <td>{{ fmtTime(appVersion.builtAt) }}</td>
              <th>版本号规则</th>
              <td><code>0.1.N</code>，N = git 提交总数</td>
            </tr>
          </tbody>
        </table>
      </div>
    </el-card>

    <!-- ══════════ 使用说明 ══════════ -->
    <el-card shadow="never" header="使用说明" class="mt16">
      <h3 class="sec">一、快速上手（4 步出单）</h3>
      <ol class="manual">
        <li><strong>货物管理</strong> → 录入要装的货物（尺寸、毛重、堆码级别、允许摆放方向等）</li>
        <li><strong>柜型管理</strong> → 确认柜内尺寸与载重上限</li>
        <li><strong>装柜计算</strong> → 选柜型 → 从货物管理中选货物并填数量 → 点「开始计算」</li>
        <li>看 3D 与装柜步骤确认无误 → <strong>导出装柜步骤 PDF</strong> 打印带到现场</li>
      </ol>

      <h3 class="sec">二、装柜计算页</h3>

      <h4>柜型选择（支持单选 / 多选）</h4>
      <ul class="manual">
        <li><strong>单选</strong>：只保留最后选择的一项</li>
        <li><strong>多选</strong>：可勾多个柜型，<strong>每种柜型各算一份结果</strong>。
          结果区顶部会出现「柜型对比」表，逐行列出该柜型用了几个柜、共装多少箱、
          总体装载率、装完仍剩多少。
          <br /><strong>各行之间不可相加</strong> —— 同一批货物被每种柜型各算了一遍，
          把箱数加起来是重复计数。点某一柜型行可切换下方的柜列表与 3D。</li>
      </ul>

      <h4>货物与数量</h4>
      <ul class="manual">
        <li>货物<strong>从货物管理里选</strong>，单选 / 多选皆可</li>
        <li><strong>数量留空 = 不限</strong>，塞满柜子为止。
          留空时算法用的是「柜内容积 ÷ 单箱体积」这个几何上界，
          所以一定会装到空间确实用尽（不会在半路停下），但也意味着装载率由几何决定、
          未必能达到你期望的百分比。</li>
        <li>显式填 <strong>0</strong> 会报错并提示 —— 想"不装这个"请点「移除」，
          填 0 与留空的含义不同。</li>
      </ul>

      <h4>装载模式</h4>
      <ul class="manual">
        <li><strong>单柜</strong>：只算一个柜</li>
        <li><strong>多柜循环</strong>：所选每种柜型各自循环装柜直到装完，
          用于「每种柜型分别需要几个柜」的测算；多选柜型时按柜型分组对比</li>
      </ul>

      <h4>计算策略</h4>
      <div class="tbl-scroll">
        <table class="grid">
          <thead>
            <tr><th style="width: 52px">策略</th><th style="width: 130px">名称</th><th>几何特征</th></tr>
          </thead>
          <tbody>
            <tr v-for="s in [0, 1, 2, 3, 4, 5]" :key="s">
              <td class="num">{{ s }}</td>
              <td>{{ STRATEGY_NAMES[s] }}</td>
              <td>{{ STRATEGY_HINTS[s] }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="tip">
        策略 3「满舱主块」是装载率最高的基准实现，混装时通常也是首选。
        混装场景下不同策略差异很大，拿不准时在 0~5 上各跑一遍比较即可。
      </p>

      <h4>高级选项</h4>
      <div class="tbl-scroll">
        <table class="grid">
          <thead>
            <tr><th style="width: 130px">选项</th><th>说明</th></tr>
          </thead>
          <tbody>
            <tr><td>允许旋转</td><td>关闭后仅允许原方向 dir0，通常装载率大幅下降</td></tr>
            <tr><td>堆码级别约束</td><td>限制"只能压在承托级别 ≥ 自己的货物上"</td></tr>
            <tr><td>承托比例约束</td><td>限制箱底实际接触面积占箱底面积的下限，防"半悬空"</td></tr>
            <tr><td>候选块上限</td><td>限制每次枚举的候选块数量。调小换速度，调大找更优解</td></tr>
            <tr><td>最大迭代轮数</td><td>贪心主循环上限。默认足够，调大极少有用</td></tr>
          </tbody>
        </table>
      </div>
      <p class="tip">
        关闭约束开关后算法会忽略堆码 / 承托限制，结果更快但<strong>可能不符合物理摆放要求</strong>，
        只适合做对比试验，不要拿来出单。
      </p>

      <h3 class="sec">三、结果怎么看</h3>
      <ul class="manual">
        <li><strong>装柜步骤</strong>：一步 = 一个聚合放置块，按「自下而上、同层由柜内深处向门口推进」
          排序。点某一步可在 3D 里高亮该步装的箱子</li>
        <li><strong>装入清单</strong>：按货物汇总件数 / 体积 / 重量</li>
        <li><strong>分层明细</strong>：按每箱真实底面高度分层，能看出每层装了哪些货</li>
        <li><strong>未装</strong>：列出没装下的货物与原因（超重 / 空间耗尽 / 承托不足 / 堆码超限…）</li>
      </ul>

      <h3 class="sec">四、3D 视图操作</h3>
      <ul class="manual">
        <li>左键拖拽旋转 · 滚轮缩放 · 右键平移 · 点击货物查看详情</li>
        <li><strong>俯视 / 正视 / 侧视 / 透视</strong>：各视图沿指定法线观察，距离按真实投影拟合</li>
        <li><strong>切片 ≤</strong>：只看某个高度以下，用来检查柜内深处的码放情况</li>
        <li><strong>逐箱 / 整块</strong>：逐箱是真实逐件渲染（数千箱仍流畅），
          整块按放置块着色，便于看清"哪一步装了哪一块"</li>
        <li><strong>导出 PNG</strong>：导出当前 3D 画面</li>
      </ul>

      <h3 class="sec">五、导出</h3>
      <div class="tbl-scroll">
        <table class="grid">
          <thead>
            <tr><th style="width: 130px">导出</th><th style="width: 80px">格式</th><th>内容</th></tr>
          </thead>
          <tbody>
            <tr><td>装柜报表</td><td>PDF</td><td>基本信息 / 汇总指标 / 装入清单 / 3D 示意图 / 分层明细 / 未装清单</td></tr>
            <tr><td>装柜步骤单</td><td>PDF</td><td>逐条摆放顺序 + 完整坐标区间 + 累计装载率 + 签字栏</td></tr>
            <tr><td>逐箱坐标</td><td>CSV</td><td>每行一箱，含单箱尺寸与姿态</td></tr>
            <tr><td>3D 画面</td><td>PNG</td><td>3D 面板内导出</td></tr>
          </tbody>
        </table>
      </div>
      <el-alert
        class="mt12"
        type="info"
        show-icon
        :closable="false"
        title="PDF 的产生方式"
        description="点「打印 / 另存为 PDF」后会打开浏览器打印对话框，请在其中选择「另存为 PDF」这一项。这样得到的 PDF 是真矢量文字（中文可选中、可搜索），表格跨页自动重复表头、行不会被截断。"
      />

      <h3 class="sec">六、已知限制（据实说明）</h3>
      <div class="limits">
        <p><strong>以下几项是从原程序逆向还原时未能取到的部分，现按通行做法自拟，语义不保证与原软件一致：</strong></p>
        <ul class="manual">
          <li><strong>装柜步骤的排序规则</strong>：原程序有此输出，但排序规则与列结构未还原。
            当前按「自下而上、同层由柜内深处向门口推进」实现</li>
          <li><strong>柜门位置</strong>：数据模型里<strong>只记录了门尺寸，没有记录门在哪一端</strong>。
            所以计算页有「门在 x 最大端 / x = 0 端」的可切换开关，报表里也会写明用的是哪个约定</li>
          <li><strong>姿态命名</strong>：按"哪一轴朝上"推导（平放 / 侧放 / 立放）。
            注意与集装箱行业惯例未必一致</li>
          <li><strong>策略 4（承托分级分层）</strong>的承托分层细节未完全还原</li>
        </ul>
        <p class="tip">
          另外，「多选多个柜型」的分组对比编排<strong>放在前端</strong>（复用同一个单柜型后端端点若干次），
          不是后端的一个原生能力。分组与"最优柜型"判定逻辑在
          <code>src/web/lib/containerGroups.ts</code>，有单元测试覆盖。
        </p>
      </div>
    </el-card>

    <div class="foot">LoadExpert Web · Vue 3 + TypeScript 全栈 · 算法引擎与界面均为本项目逆向还原实现</div>
  </div>
</template>

<script setup lang="ts">
/**
 * 应用版本 + 使用说明
 *
 * ## 版本号怎么来的
 * `src/version.ts` 由 `scripts/gen-version.mjs` 生成（build / dev / server 都会自动先跑一遍），
 * 规则是 `0.1.N`，N = git 提交总数。
 *
 * **不手改版本号**是刻意的：手改的必然结果是"改了代码忘了改版本"，
 * 页面显示 0.1.0 的东西其实是第 30 次迭代，没人看得出。提交数天然单调递增，
 * 且不需要额外的 tag 约定。详见该脚本的注释。
 *
 * 策略名称/特征说明直接 import 算法侧的常量，避免文档与实现漂移。
 */
import { STRATEGY_NAMES, STRATEGY_HINTS } from '../../algorithm/candidate-blocks';
import { appVersion } from '../../version';

const sourceText = appVersion.source === 'git' ? 'git 提交数自动推算' : 'package.json（未初始化 git）';

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
</script>

<style scoped>
.about-page {
  max-width: 1000px;
  margin: 0 auto;
  padding: 12px;
}

/* ───────────── 窄屏适配 ─────────────
 * 这页是长文档 + 宽表格。手机上不做重排（重排一张 8 列的报表毫无意义），
 * 而是让表格**横向滚动**、标题与列表正常换行，保证可读。
 */
@media (max-width: 991px) {
  .ver-head {
    flex-direction: column;
    gap: 8px;
  }
  .ver-num {
    font-size: 32px;
  }
  .ver-right {
    padding-top: 0;
  }
  .about-page :deep(.el-card__body) {
    padding: 12px;
  }
  h3.sec {
    font-size: 14px;
  }
  ul,
  ol.manual {
    padding-left: 18px;
    font-size: 12.5px;
    line-height: 1.9;
  }
  /* 表格外层横向滚动；table 设 min-width 是让它"必须"比容器宽，从而触发滚动 */
  .tbl-scroll {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
  table {
    min-width: 560px;
    font-size: 12px;
  }
  tbody th {
    width: auto;
  }
}

/* ── 版本卡 ── */
.ver-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.ver-label {
  font-size: 13px;
  color: #909399;
}
.ver-num {
  font-size: 40px;
  font-weight: 700;
  line-height: 1.15;
  color: #303133;
  font-variant-numeric: tabular-nums;
}
.ver-src {
  font-size: 12px;
  color: #606266;
  margin-top: 4px;
}
.ver-right {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-shrink: 0;
  padding-top: 6px;
}

/* ── 说明正文 ── */
h3.sec {
  font-size: 15px;
  font-weight: 600;
  margin: 22px 0 8px;
  padding-left: 8px;
  border-left: 3px solid #409eff;
}
h3.sec:first-of-type {
  margin-top: 4px;
}
h4 {
  font-size: 13px;
  font-weight: 600;
  margin: 14px 0 4px;
  color: #303133;
}
ul,
ol.manual {
  margin: 4px 0 8px;
  padding-left: 22px;
  font-size: 13px;
  line-height: 1.85;
  color: #303133;
}
.tip {
  font-size: 12px;
  color: #606266;
  background: #f5f7fa;
  border-left: 3px solid #c0c4cc;
  padding: 7px 10px;
  margin: 6px 0 10px;
  line-height: 1.75;
}
.limits {
  border: 1px solid #e6e6e6;
  border-radius: 4px;
  padding: 10px 12px;
  background: #fafafa;
}
.limits p {
  margin: 4px 0;
  font-size: 13px;
  color: #303133;
  line-height: 1.8;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
  margin: 6px 0;
}
th,
td {
  border: 1px solid #dcdfe6;
  padding: 6px 8px;
  text-align: left;
  vertical-align: top;
  line-height: 1.7;
}
thead th {
  background: #f5f7fa;
  font-weight: 600;
}
tbody th {
  background: #fafafa;
  font-weight: 600;
  white-space: nowrap;
  width: 110px;
}
.num {
  text-align: center;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
code {
  background: #f5f7fa;
  border: 1px solid #e6e6e6;
  border-radius: 3px;
  padding: 1px 5px;
  font-size: 12px;
}

.foot {
  text-align: center;
  font-size: 11px;
  color: #909399;
  padding: 18px 0 6px;
}
</style>