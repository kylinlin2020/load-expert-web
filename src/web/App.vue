<template>
  <el-container class="app-shell">
    <el-aside width="220px" class="app-aside">
      <div class="brand">
        <span class="brand-title">装柜专家</span>
        <span class="brand-sub">LoadExpert Web</span>
      </div>
      <el-menu router :default-active="$route.path" class="app-menu">
        <el-menu-item index="/boxes">
          <el-icon><Box /></el-icon>
          <span>货物管理</span>
        </el-menu-item>
        <el-menu-item index="/containers">
          <el-icon><Van /></el-icon>
          <span>柜型管理</span>
        </el-menu-item>
        <el-menu-item index="/calculate">
          <el-icon><Cpu /></el-icon>
          <span>装柜计算</span>
        </el-menu-item>
        <el-menu-item index="/plans">
          <el-icon><List /></el-icon>
          <span>方案列表</span>
        </el-menu-item>
        <el-menu-item index="/about">
          <el-icon><InfoFilled /></el-icon>
          <span>应用版本</span>
        </el-menu-item>
      </el-menu>
    </el-aside>

    <el-container>
      <el-header class="app-header">
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
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router';
import { Box, Van, Cpu, List, InfoFilled } from '@element-plus/icons-vue';
import { appVersion } from '../version';

const router = useRouter();
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
