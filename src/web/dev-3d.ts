/**
 * 3D 视图的**独立验证页**（dev-3d.html）
 *
 * 用途：把 Packing3D 单独挂起来看，不经过装柜计算页的表单。
 * 起因：计算页要手填数量才能出 3D，而"初始视角对不对"这种事光看代码不够 ——
 * 必须真的渲染出来看柜体有没有躺倒（高度轴是否竖直）。
 *
 * 这个页面对**初始视角**特别重要：3D 一挂载就走 fitCameraToBox()，
 * 正是原先 camera.up 没设错的那个时机。
 *
 * 开发期工具，不参与生产构建入口。
 */
import { createApp, h } from 'vue';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import Packing3D from './components/Packing3D.vue';
import { load } from '../algorithm/load';
import type { Box, Container } from '../types';

const container: Container = {
  id: 'hq',
  name: '45HQ',
  innerLength: 13556,
  innerWidth: 2352,
  innerHeight: 2698,
  weightCapacity: 26800,
};

const mk = (id: string, l: number, w: number, h: number, weight: number, sc: number, qty: number): Box => ({
  id,
  name: id,
  length: l,
  width: w,
  height: h,
  weight,
  quantity: qty,
  stackClass: sc,
  supportClasses: new Array(6).fill(sc),
  supportPct: [1, 1, 1],
  pcsCount: 1,
  allowDirections: [true, true, false, false, false, false],
});

const boxes: Box[] = [
  mk('水泵2', 480, 380, 380, 20, 8, 630),
  mk('水泵3', 515, 380, 425, 22, 8, 330),
];

const result = load({ boxes, container, strategy: 3 });

createApp({
  setup() {
    return () =>
      h('div', { style: 'width:1100px' }, [
        h(
          'div',
          { style: 'margin-bottom:8px;font-size:13px;color:#303133' },
          `验证页：内 ${container.innerLength}×${container.innerWidth}×${container.innerHeight}，` +
            `装载率 ${(result.loadRate * 100).toFixed(2)}%，${result.placements.reduce((a, p) => a + p.count, 0)} 箱`,
        ),
        h(Packing3D, { result, boxes }),
      ]);
  },
})
  .use(ElementPlus)
  .mount('#app');