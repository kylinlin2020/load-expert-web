<template>
  <el-container class="app-shell">
    <!--
      宽屏：固定侧边栏；窄屏：侧边栏收进抽屉（见 NAV_BREAK 的说明）。
      两套都用同一份菜单项数据，避免改菜单时漏改一处。
    -->
    <el-aside v-if="!isNarrow" width="220px" class="app-aside">
      <div class="brand">
        <span class="brand-title">装柜专家</span>
        <span class="brand-sub">LoadExpert Web</span>
      </div>
      <el-menu router :default-active="$route.path" class="app-menu">
        <el-menu-item v-for="m in MENU" :key="m.index" :index="m.index">
          <el-icon><component :is="m.icon" /></el-icon>
          <span>{{ m.label }}</span>
        </el-menu-item>
      </el-menu>
    </el-aside>

    <!-- 窄屏导航抽屉 -->
    <el-drawer v-model="drawerOpen" direction="ltr" size="230px" :with-header="false" class="nav-drawer">
      <div class="brand">
        <span class="brand-title">装柜专家</span>
        <span class="brand-sub">LoadExpert Web</span>
      </div>
      <el-menu router :default-active="$route.path" class="app-menu" @select="drawerOpen = false">
        <el-menu-item v-for="m in MENU" :key="m.index" :index="m.index">
          <el-icon><component :is="m.icon" /></el-icon>
          <span>{{ m.label }}</span>
        </el-menu-item>
      </el-menu>
    </el-drawer>

    <el-container>
      <el-header class="app-header">
        <el-button v-if="isNarrow" class="nav-toggle" text @click="drawerOpen = true">
          <el-icon :size="20"><Fold /></el-icon>
        </el-button>
        <span class="header-title">{{ $route.meta.title || '' }}</span>
        <!--
          版本号常驻顶栏：报问题时第一句往往是"我是哪个版本"，
          让人自己翻到「应用版本」页去抄编号太费事。
          工作区有未提交改动时标黄 —— 那个版本号对应的其实是上一次提交。
        -->
        <span class="header-ver" :class="{ 'is-dirty': appVersion.dirty }" @click="router.push('/about')">
          v{{ appVersion.version }}<template v-if="appVersion.dirty"> *</template>
        </span>
      </el-header>
      <el-main class="app-main">
        <!--
          KeepAlive：切换菜单时**不销毁**页面组件，切回来时表单与计算结果原样保留。

          为什么必须：路由组件默认在离开时被 unmount，所有局部状态（柜型选择、
          已选货物与数量、策略、计算结果、门位置约定）全部丢失 —— 用户反馈的
          "切换菜单再切回来要重新选一遍重新算" 就是这个原因。
          把状态搬到全局 store 也能解决，但要动几十处引用；
          KeepAlive 是 Vue 官方的做法，一处改动解决所有页面。

          exclude 掉 ReportView：它是"用完即走"的单据页，
          且挂着整套 3D 场景（WebGL 上下文很吃内存），缓存起来没有收益。
        -->
        <router-view v-slot="{ Component }">
          <KeepAlive :exclude="['ReportView']">
            <component :is="Component" />
          </KeepAlive>
        </router-view>
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Box, Van, Cpu, List, InfoFilled, Fold, Download } from '@element-plus/icons-vue';
import { appVersion } from '../version';

const router = useRouter();
const route = useRoute();

/** 菜单项（侧边栏与窄屏抽屉共用同一份，避免改一处漏一处） */
const MENU = [
  { index: '/boxes', label: '货物管理', icon: Box },
  { index: '/containers', label: '柜型管理', icon: Van },
  { index: '/calculate', label: '装柜计算', icon: Cpu },
  { index: '/plans', label: '方案列表', icon: List },
  // 备份入口放在业务菜单里而不是塞进「应用版本」——
  // 这是**唯一的救命手段**，真出事时用户不该在"关于"里翻找它。
  { index: '/backup', label: '数据备份', icon: Download },
  { index: '/about', label: '应用版本', icon: InfoFilled },
];

/**
 * 窄屏断点 = Element Plus 的 md 断点（992px）
 *
 * 为什么是 992 而不是更小的 768：本项目是**表格与 3D 密集**的桌面型工具，
 * 768~991px（如平板横屏、小窗笔记本）放得下 8/16 两栏；再窄就真的放不下了。
 * 与 el-col 的 `:md` 断点保持一致，列折叠与侧边栏收起在同一时刻发生，
 * 不会出现"侧边栏收起了但两栏还并排"的中间态。
 */
const NARROW_MAX = 991;
const isNarrow = ref(false);
const drawerOpen = ref(false);

function syncNarrow(): void {
  isNarrow.value = window.innerWidth <= NARROW_MAX;
}

onMounted(() => {
  syncNarrow();
  window.addEventListener('resize', syncNarrow);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', syncNarrow);
});

// 从抽屉里点菜单跳转后要关抽屉（桌面宽度下抽屉本就不存在，直接复位）
watch(() => route.path, () => {
  drawerOpen.value = false;
});
</script>

<style scoped>
.app-shell {
  height: 100vh;
}
.app-aside {
  background: #1f2d3d;
  color: #fff;
  display: flex;
  flex-direction: column;
}
.brand {
  padding: 18px 16px 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}
.brand-title {
  display: block;
  font-size: 18px;
  font-weight: 600;
  color: #fff;
}
.brand-sub {
  display: block;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.6);
  margin-top: 2px;
}
.app-menu {
  flex: 1;
  border-right: none;
  background: transparent;
}
.app-menu :deep(.el-menu-item) {
  color: rgba(255, 255, 255, 0.75);
}
.app-menu :deep(.el-menu-item.is-active) {
  color: #fff;
  background: rgba(64, 158, 255, 0.25);
}
.app-menu :deep(.el-menu-item:hover) {
  background: rgba(255, 255, 255, 0.08);
}
.app-header {
  display: flex;
  align-items: center;
  background: #fff;
  border-bottom: 1px solid #e6e6e6;
}
.header-title {
  font-size: 16px;
  font-weight: 600;
  color: #303133;
}
.header-ver {
  margin-left: auto;
  font-size: 12px;
  color: #909399;
  cursor: pointer;
  padding: 2px 8px;
  border-radius: 4px;
  font-variant-numeric: tabular-nums;
  user-select: none;
}
.header-ver:hover {
  background: #f5f7fa;
  color: #409eff;
}
/* 未提交改动：版本号对应的其实是上一次提交，必须一眼看出来 */
.header-ver.is-dirty {
  color: #e6a23c;
  font-weight: 600;
}
.app-main {
  background: #f5f7fa;
  padding: 16px;
}
.nav-toggle {
  margin-right: 4px;
  padding: 6px;
  flex-shrink: 0;
}

/* ───────────── 窄屏适配（组件内样式） ─────────────
 * 之前在 390px 宽的手机上侧边栏就占掉 56% 屏宽，正文被挤成一条竖排文字带，
 * 完全不可用。这里统一收口：抽屉导航 + 缩小留白 + 控件加大点击区域。
 */
@media (max-width: 991px) {
  .app-header {
    padding: 0 10px;
  }
  .header-title {
    font-size: 15px;
  }
  .app-main {
    padding: 10px;
  }
}

/* ───────────── 打印：只出单据本身 ─────────────
 * 打印/另存为 PDF 会打印**整个文档**，不只是报表页的内容。
 * 侧边栏、顶栏、主区留白都必须去掉，否则 PDF 里会凭空多出
 * 一条深色导航栏和一堆空白边距 —— 单据是要贴到现场去的。
 */
@media print {
  .app-aside,
  .app-header {
    display: none !important;
  }
  .app-shell {
    /* 原本 100vh 会把打印内容限制在一屏高度内，导致只印出第一页 */
    height: auto;
  }
  .app-main {
    padding: 0;
    background: #fff;
    /* el-main 默认 overflow:auto，打印时会裁掉超出部分 */
    overflow: visible;
  }
}
</style>

<!--
  ─────────────────────────────────────────────────────────────
  全局样式（**不加 scoped**）

  这一块必须非 scoped：Element Plus 的 `el-drawer` / `el-dialog` / `el-message-box`
  都通过 teleport 挂到 `body` 下，**不在本组件的 DOM 子树内**。
  之前把抽屉样式写成 `.nav-drawer :deep(.el-drawer__body)`，
  scoped 编译后要求祖先带 `[data-v-xxx]`，而 `.nav-drawer` 这个类是由
  el-drawer 自己写在 teleport 出去的根节点上的 —— 匹配不到，样式全部失效。
  后果是：抽屉白底 + 白字，**除当前项外所有菜单项都看不见**
  （截图里发现的：白色背景把白色文字吃掉了，只有带底色的当前项能看见）。

  同理，窄屏下那些全局覆盖（对话框宽度、卡片内边距、按钮点击区）也必须放在这里。
  ─────────────────────────────────────────────────────────────
-->
<style>
/* 抽屉导航：与固定侧边栏同一套深色 */
.nav-drawer .el-drawer__body {
  padding: 0;
  background: #1f2d3d;
  overflow-y: auto;
}
.nav-drawer .brand {
  padding: 18px 16px 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}
.nav-drawer .brand-title {
  display: block;
  font-size: 18px;
  font-weight: 600;
  color: #fff;
}
.nav-drawer .brand-sub {
  display: block;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.6);
  margin-top: 2px;
}
.nav-drawer .app-menu {
  background: transparent;
  border-right: none;
}
.nav-drawer .app-menu .el-menu-item {
  color: rgba(255, 255, 255, 0.75);
}
.nav-drawer .app-menu .el-menu-item.is-active {
  color: #fff;
  background: rgba(64, 158, 255, 0.25);
}
.nav-drawer .app-menu .el-menu-item:hover {
  background: rgba(255, 255, 255, 0.08);
}

@media (max-width: 991px) {
  /* 抽屉导航项在手机上要够大才好点 */
  .nav-drawer .app-menu .el-menu-item {
    height: 48px;
    line-height: 48px;
    font-size: 15px;
  }
  /* 各处 dialog 用的是 width="420px" 这类固定值，窄屏会溢出屏幕 */
  .el-dialog {
    width: 92% !important;
  }
  .el-message-box {
    width: 88% !important;
    max-width: 92vw;
  }
  /* 卡片内边距收窄，给窄屏留出内容宽度 */
  .el-card__body {
    padding: 12px;
  }
  /* 表格单元格默认行高在手机上偏挤 */
  .el-table .cell {
    line-height: 1.5;
  }
  /*
   * 表单里的数字输入框在窄屏必须**独占一行**。
   * 两列并排时，`el-input-number` 自带的 +/- 控件会把输入区挤到只剩一条缝
   * （实测长/宽/高/毛重那几栏几乎看不到数字），而这些正是最需要看清的字段。
   * 对应 BoxesView / ContainersView 里 `:xs="24" :sm="8"`。
   */
  .el-dialog .el-input-number {
    width: 100%;
  }
}
</style>
