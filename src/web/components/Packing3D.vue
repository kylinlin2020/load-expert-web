<template>
  <div class="packing3d-wrap">
    <div ref="mountEl" class="packing3d-canvas"></div>

    <!-- 统计浮层 -->
    <div v-if="result" class="packing3d-stats">
      <div class="stat-item"><span class="stat-label">箱数</span><span class="stat-value">{{ stats.cartons }}</span></div>
      <div class="stat-item"><span class="stat-label">件数</span><span class="stat-value">{{ stats.pieces }}</span></div>
      <div class="stat-item"><span class="stat-label">占用体积</span><span class="stat-value">{{ stats.volumeText }}</span></div>
      <div class="stat-item"><span class="stat-label">装载率</span><span class="stat-value">{{ stats.rateText }}</span></div>
    </div>

    <!-- 工具条 -->
    <div class="packing3d-toolbar">
      <el-button-group size="small">
        <el-button @click="setView('top')">俯视</el-button>
        <el-button @click="setView('front')">正视</el-button>
        <el-button @click="setView('side')">侧视</el-button>
        <el-button @click="setView('persp')">透视</el-button>
      </el-button-group>
      <div class="toolbar-sep"></div>
      <label class="toolbar-item">切片 ≤
        <el-slider
          class="slice-slider"
          :min="0"
          :max="sliceMax"
          v-model="sliceZ"
          :disabled="sliceMax <= 0"
          @change="applySlice"
        />
        <span class="slice-value">{{ sliceZText }}</span>
      </label>
      <div class="toolbar-sep"></div>
      <el-checkbox v-model="showShell" @change="applyShell" label="柜体" />
      <el-checkbox v-model="showOutline" @change="applyOutline" label="轮廓线" />
      <div class="toolbar-sep"></div>
      <el-radio-group v-model="renderMode" size="small">
        <el-radio-button value="carton">逐箱</el-radio-button>
        <el-radio-button value="block">整块</el-radio-button>
      </el-radio-group>
      <div class="toolbar-sep"></div>
      <el-button size="small" type="primary" @click="exportPNG">导出 PNG</el-button>
      <span v-if="stats.placements > 0" class="mode-hint">
        {{ renderMode === 'carton' ? '逐箱渲染' : '整块渲染' }} · {{ stats.placements }} 个放置块 / {{ stats.cartons }} 箱
      </span>
    </div>

    <!-- 图例 -->
    <div v-if="legendItems.length" class="packing3d-legend">
      <div class="legend-title">图例</div>
      <div v-for="item in legendItems" :key="item.boxId" class="legend-item" @click="focusBox(item.boxId)">
        <span class="legend-dot" :style="{ background: item.color }"></span>
        <span class="legend-name" :title="item.name">{{ item.name }}</span>
        <span class="legend-count">×{{ item.count }}</span>
      </div>
    </div>

    <!-- 点击信息浮层 -->
    <div v-if="hoverInfo" class="packing3d-hover" :style="{ left: hoverInfo.x + 'px', top: hoverInfo.y + 'px' }">
      <div class="hover-title">{{ hoverInfo.name }}</div>
      <div class="hover-row"><span>SKU</span><span>{{ hoverInfo.sku || '-' }}</span></div>
      <div class="hover-row"><span>位置 (mm)</span><span>({{ hoverInfo.x0 }}, {{ hoverInfo.y0 }}, {{ hoverInfo.z0 }})</span></div>
      <div class="hover-row"><span>尺寸</span><span>{{ hoverInfo.dx }} × {{ hoverInfo.dy }} × {{ hoverInfo.dz }} mm</span></div>
      <template v-if="hoverInfo.cartonIndex !== null">
        <div class="hover-row"><span>逐件序号</span><span>#{{ hoverInfo.cartonIndex + 1 }} / {{ hoverInfo.totalForBox }}</span></div>
        <div class="hover-row"><span>说明</span><span>单箱（逐箱模式）</span></div>
      </template>
      <div v-else class="hover-row"><span>箱数</span><span>{{ hoverInfo.count }} 箱（整块模式）</span></div>
      <div class="hover-row"><span>所属货物</span><span>{{ hoverInfo.boxId }}</span></div>
    </div>

    <div class="packing3d-tips">拖拽旋转 · 滚轮缩放 · 右键平移 · 点击货物查看</div>
  </div>
</template>

<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
// 路径深度与同目录的其它 web 模块保持一致：src/web/components → ../../ = src
import type { Box, CartonPlacement, PackResult } from '../../types';
import { expandResult } from '../../algorithm/expand';

const props = defineProps<{
  result: PackResult | null;
  /** 货物元数据（用于名称/SKU 展示），可选 */
  boxes?: Box[];
  /** 外部联动：高亮指定货物 id */
  highlightBoxId?: string | null;
  /**
   * 外部联动：高亮指定「装柜步骤」（即 result.placements 的下标集合）
   *
   * 装柜步骤比"按货物高亮"更细：同一种货物可能分布在多个步骤里，
   * 只按 boxId 高亮会把所有步骤一起点亮，看不出这一步具体装哪一块。
   * 优先级高于 highlightBoxId。传 null / 空数组表示不高亮。
   */
  highlightPlacements?: number[] | null;
}>();

const emit = defineEmits<{ (e: 'select', boxId: string): void }>();

const mountEl = ref<HTMLDivElement | null>(null);

let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let controls: OrbitControls | null = null;
let boxGroup: THREE.Group | null = null;
let shellGroup: THREE.Group | null = null;
let outlineGroup: THREE.Group | null = null;
const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
let frameId = 0;
let resizeHandler: (() => void) | null = null;
let resizeObserver: ResizeObserver | null = null;
/** 上一次生效的画布尺寸，用于跳过无意义的重算（见 resizeHandler 内注释） */
let lastW = 0;
let lastH = 0;
let clickHandler: ((e: MouseEvent) => void) | null = null;
let defaultCameraPos = new THREE.Vector3(3000, 3500, 4000);

/** 货物 id → 材质实例映射（整块模式下用于高亮/恢复） */
const meshMeta = new Map<
  THREE.Mesh,
  { boxId: string; material: THREE.MeshStandardMaterial; baseColor: THREE.Color; placementId: string }
>();

/**
 * 逐箱渲染的批次结构（按货物分组）
 *
 * 逐箱渲染有两条性能路径：
 *  - instanced：InstancedMesh 批量提交（单货物 1 draw call），数千箱仍流畅
 *  - mesh：每箱一个 Mesh，仅在箱数很少时使用（便于逐箱独立改材质做高亮/描边）
 */
interface CartonBatch {
  boxId: string;
  /** 逐箱坐标，顺序与 InstancedMesh 的 instanceId 一一对应 */
  cartons: CartonPlacement[];
  instanced: THREE.InstancedMesh | null;
  /** 该货物共享材质（instanced 模式）或逐箱材质集合（mesh 模式） */
  materials: THREE.MeshStandardMaterial[];
  baseColor: THREE.Color;
  /**
   * 本批次的摆放姿态
   *
   * 批次按 (货物, 姿态) 双重分组 —— **不能只按货物分组**：
   * InstancedMesh 只有一个共用几何体，其尺寸必须对批内所有箱一致。
   * 同一种货物在一次计算里可能同时以多个姿态摆放（例如 A 既有 dir4 又有 dir5：
   * dir4 占位 300×400×500、dir5 占位 400×300×500），
   * 若共用首箱尺寸，后者会被 x/y 转置地画错（实测 S5 有 67% 的箱受影响）。
   */
  orientation: number;
  /** 逐箱轮廓线（仅 mesh 模式，按需生成） */
  outlines: THREE.LineSegments[];
  /**
   * 逐箱边线里「每箱占用的顶点数」（12 棱 × 2 端点）。
   * 边线按 z 升序逐箱写入一个 BufferGeometry，故第 i 箱占 [i*24, (i+1)*24)，
   * 分层切片可直接用 setDrawRange 精确裁剪，无需重建几何。
   * 超大批次退回批次外壳时为 null（外壳不参与切片，整段显示或整段隐藏）。
   */
  edgeVertsPerCarton: number | null;
}

/** 当前逐箱批次（按货物分组） */
let cartonBatches: CartonBatch[] = [];
/** 当前逐件坐标（拾取与浮层定位用） */
let currentCartons: CartonPlacement[] = [];

/** 交互状态 */
const hoverInfo = ref<{
  x: number;
  y: number;
  name: string;
  sku: string;
  x0: number;
  y0: number;
  z0: number;
  dx: number;
  dy: number;
  dz: number;
  count: number;
  /** 逐箱模式：命中的逐件全局序号 */
  cartonIndex: number | null;
  /** 该货物总箱数 */
  totalForBox: number;
  boxId: string;
} | null>(null);

/** 工具条状态 */
const sliceZ = ref(0);
const sliceMax = ref(0);
const showShell = ref(true);
const showOutline = ref(true);
/** 渲染模式：逐箱（InstancedMesh，默认）/ 整块（原聚合块） */
const renderMode = ref<'carton' | 'block'>('carton');
let selectedBoxId: string | null = null;
let highlightBoxIdInternal: string | null = null;

/** 逐箱模式下各货物批次的包围盒 [minX,minY,minZ,maxX,maxY,maxZ] */
const cartonBounds = new Map<string, number[]>();
/** 场景构建期间的临时对象，避免每箱分配 */
const tmpColor = new THREE.Color();
let maxZOverall = 0;

/** 每箱 12 条棱 × 2 端点 = 24 个顶点 */
const EDGE_VERTS_PER_CARTON = 24;
/** 逐箱描边的箱数上限：超过则退回批次外壳，避免几百万顶点拖垮渲染 */
const MAX_CARTON_EDGES = 20000;

/**
 * 货物配色：优先用主数据里指定的 COLOR 字段，缺省时回退到按 id 哈希的稳定区分色
 *
 * 解析失败（非法字符串）时同样回退，避免一个手滑的色值导致整柜渲染变黑/报错。
 */
function colorFor(id: string): THREE.Color {
  const specified = props.boxes?.find((b) => b.id === id)?.color?.trim();
  if (specified) {
    const c = new THREE.Color();
    // setStyle 接受 #rgb / #rrggbb / rgb(...) / 具名色；非法值时 c 保持黑色，需显式判别
    try {
      c.setStyle(specified);
      if (c.getHexString() !== '000000' || /^#?0{3,6}$/i.test(specified)) {
        return c;
      }
    } catch {
      // 落到下面的哈希配色
    }
  }
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0;
  }
  return new THREE.Color().setHSL((h % 360) / 360, 0.66, 0.56);
}

function boxName(boxId: string): string {
  return props.boxes?.find((b) => b.id === boxId)?.name ?? `货物 ${boxId}`;
}
function boxSku(boxId: string): string {
  return props.boxes?.find((b) => b.id === boxId)?.sku ?? '';
}

const stats = computed(() => {
  const r = props.result;
  if (!r) return { pieces: 0, cartons: 0, placements: 0, volumeText: '-', rateText: '-' };
  const volume = r.usedVolume;
  const rate = r.loadRate ?? 0;
  const cartons = r.placements.reduce((acc, p) => acc + p.count, 0);
  return {
    pieces: r.pieces ?? cartons,
    cartons,
    placements: r.placements.length,
    volumeText: `${(volume / 1e9).toFixed(3)} m³`,
    rateText: `${(rate * 100).toFixed(1)}%`,
  };
});

const legendItems = computed(() => {
  if (!props.result) return [];
  const map = new Map<string, { boxId: string; count: number }>();
  for (const p of props.result.placements) {
    const cur = map.get(p.boxId);
    map.set(p.boxId, { boxId: p.boxId, count: (cur?.count ?? 0) + p.count });
  }
  return [...map.values()].map((it) => ({
    ...it,
    name: boxName(it.boxId),
    color: '#' + colorFor(it.boxId).getHexString(),
  }));
});

const sliceZText = computed(() => (sliceMax.value > 0 ? `${sliceZ.value.toFixed(0)} mm` : '全部'));

/** 生成文本 Sprite 用于尺寸标注 */
function makeLabel(text: string, color: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = color;
  ctx.font = 'bold 44px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(600, 150, 1);
  return sprite;
}

/** 沿一条棱生成刻度线 */
function makeTicks(start: THREE.Vector3, dir: THREE.Vector3, totalLen: number, step: number): THREE.LineSegments {
  const pts: THREE.Vector3[] = [];
  const n = Math.floor(totalLen / step);
  for (let i = 0; i <= n; i++) {
    const base = start.clone().add(dir.clone().multiplyScalar(i * step));
    pts.push(base, base.clone().add(new THREE.Vector3(0, 0, step * 0.25)));
  }
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x1a1a1a, transparent: true, opacity: 0.6 }));
}

function tickStep(len: number): number {
  if (len <= 2000) return 500;
  if (len <= 6000) return 1000;
  if (len <= 15000) return 2000;
  return 5000;
}

/** 重建货物区域（逐箱 / 整块） */
function buildCargo(): void {
  if (!boxGroup || !outlineGroup || !props.result) return;
  // 清理旧货物与轮廓
  for (const g of [boxGroup, outlineGroup]) {
    while (g.children.length) {
      const child = g.children.pop();
      if (child) {
        child.traverse((obj) => {
          const any = obj as THREE.Mesh | THREE.LineSegments;
          any.geometry?.dispose();
          const mat = any.material as THREE.Material | THREE.Material[] | undefined;
          if (Array.isArray(mat)) {
            mat.forEach((m) => m.dispose());
          } else {
            mat?.dispose();
          }
        });
      }
    }
  }
  meshMeta.clear();
  cartonBatches = [];
  currentCartons = [];
  cartonBounds.clear();
  maxZOverall = 0;
  hoverInfo.value = null;

  const result = props.result;
  /**
   * 实体收缩系数
   *
   * 原为 0.995（每箱每侧缩 0.5%）以"制造间隙"让相邻箱体边界可见 ——
   * 但实测算法把货物是**紧贴**摆放的（相邻箱间距恒为 0），
   * 收缩只是把每箱缩小一点点，累积成一层"发虚的缝"，让整柜看起来不真实，
   * 而且 0.5% 会被误读成货物之间真的有间隙。
   *
   * 现在改为 1（几何与算法输出严格一致），箱与箱的边界改由**逐箱描边**表达，
   * 既真实又能看清每箱。共面紧贴不会 z-fighting：相邻箱的接触面在实体内部，
   * 外表面虽共面但不重叠。
   */
  const shrink = 1;
  /** 逐箱亮度微扰幅度：相邻箱体边界清晰可辨，但不至于变成棋盘格 */
  const jitterLo = 0.965;
  const jitterSpan = 0.07;

  if (renderMode.value === 'carton') {
    // ---------- 逐箱模式：按货物分组，每组一个 InstancedMesh ----------
    const cartons = expandResult(result, props.boxes ?? []);
    currentCartons = cartons;
    if (cartons.length === 0) {
      return;
    }

    // 按 (货物, 姿态) 分组：InstancedMesh 的共用几何体要求批内尺寸一致，
    // 而逐箱尺寸 = orientDims(box, 姿态)，是 (货物, 姿态) 的纯函数
    const byBoxOrient = new Map<string, CartonPlacement[]>();
    for (const ct of cartons) {
      const key = `${ct.boxId}|${ct.orientation}`;
      const arr = byBoxOrient.get(key);
      if (arr) {
        arr.push(ct);
      } else {
        byBoxOrient.set(key, [ct]);
      }
    }

    const dummy = new THREE.Object3D();
    for (const [key, raw] of byBoxOrient) {
      // z 升序（同 z 再按 y、x）：分层切片可用 instance count 前缀截断
      const list = raw.sort((a, b) => a.z - b.z || a.y - b.y || a.x - b.x);
      const boxId = list[0].boxId;
      const orientation = list[0].orientation;
      const dims = list[0].dims;
      // 不变式自检：逐箱尺寸应是 (货物, 姿态) 的纯函数，即批内必然一致。
      // 一旦不一致说明 expandResult 的尺寸来源变了，共用几何体就会画错 —— 明确报警而非静默。
      for (let i = 1; i < list.length; i++) {
        const d = list[i].dims;
        if (d[0] !== dims[0] || d[1] !== dims[1] || d[2] !== dims[2]) {
          console.warn(
            `[Packing3D] 批次 ${key} 内逐箱尺寸不一致（首箱 ${dims}，第 ${i} 箱 ${d}）：` +
              `共用 InstancedMesh 几何体会画错，请检查 expandResult 的 dims 是否仍只依赖 (货物, 姿态)`,
          );
          break;
        }
      }
      const geometry = new THREE.BoxGeometry(dims[0] * shrink, dims[1] * shrink, dims[2] * shrink);
      const baseColor = colorFor(boxId);
      const material = new THREE.MeshStandardMaterial({
        color: 0xffffff, // 逐箱颜色走 instanceColor，基色设为白
        roughness: 0.55,
        metalness: 0.08,
      });
      const inst = new THREE.InstancedMesh(geometry, material, list.length);
      inst.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      inst.frustumCulled = false; // 逐箱分散，包围球剔除易误判
      for (let i = 0; i < list.length; i++) {
        const ct = list[i];
        dummy.position.set(ct.x + dims[0] / 2, ct.y + dims[1] / 2, ct.z + dims[2] / 2);
        dummy.updateMatrix();
        inst.setMatrixAt(i, dummy.matrix);
        // 逐箱亮度微扰：相邻箱体边界清晰可辨
        const jitter = jitterLo + (((ct.index * 2654435761) % 97) / 97) * jitterSpan;
        tmpColor.copy(baseColor).multiplyScalar(jitter);
        inst.setColorAt(i, tmpColor);
        maxZOverall = Math.max(maxZOverall, ct.z + ct.dims[2]);
      }
      inst.instanceMatrix.needsUpdate = true;
      if (inst.instanceColor) {
        inst.instanceColor.needsUpdate = true;
      }
      inst.userData = { boxId, kind: 'carton' };
      boxGroup!.add(inst);
      cartonBatches.push({
        boxId,
        orientation,
        cartons: list,
        instanced: inst,
        materials: [material],
        baseColor,
        outlines: [],
        edgeVertsPerCarton: null,
      });
    }

    // 逐箱模式的轮廓线：**逐箱描边**（合并成单个 LineSegments，一次 draw call）
    // 早期版本画的是"整批次外壳线框" —— 只能看出货物堆的轮廓，
    // 看不出有多少箱、怎么摆；改成逐箱描边后，去掉收缩也能看清每箱的边界。
    if (showOutline.value) {
      for (const batch of cartonBatches) {
        let minX = Infinity;
        let minY = Infinity;
        let minZ = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        let maxZ = -Infinity;
        for (const ct of batch.cartons) {
          minX = Math.min(minX, ct.x);
          minY = Math.min(minY, ct.y);
          minZ = Math.min(minZ, ct.z);
          maxX = Math.max(maxX, ct.x + ct.dims[0]);
          maxY = Math.max(maxY, ct.y + ct.dims[1]);
          maxZ = Math.max(maxZ, ct.z + ct.dims[2]);
        }
        cartonBounds.set(`${batch.boxId}|${batch.orientation}`, [minX, minY, minZ, maxX, maxY, maxZ]);

        const list = batch.cartons;
        let lines: THREE.LineSegments;
        if (list.length <= MAX_CARTON_EDGES) {
          batch.edgeVertsPerCarton = EDGE_VERTS_PER_CARTON;
          const pos = new Float32Array(list.length * EDGE_VERTS_PER_CARTON * 3);
          let o = 0;
          const put = (x: number, y: number, z: number) => {
            pos[o++] = x;
            pos[o++] = y;
            pos[o++] = z;
          };
          for (const ct of list) {
            const [dx, dy, dz] = ct.dims;
            const x0 = ct.x;
            const y0 = ct.y;
            const z0 = ct.z;
            const x1 = x0 + dx;
            const y1 = y0 + dy;
            const z1 = z0 + dz;
            // 12 条棱：(x,y,z) 组合，每条 2 个端点
            const edges: Array<[number[], number[]]> = [
              [[x0, y0, z0], [x1, y0, z0]], [[x1, y0, z0], [x1, y1, z0]], [[x1, y1, z0], [x0, y1, z0]], [[x0, y1, z0], [x0, y0, z0]],
              [[x0, y0, z1], [x1, y0, z1]], [[x1, y0, z1], [x1, y1, z1]], [[x1, y1, z1], [x0, y1, z1]], [[x0, y1, z1], [x0, y0, z1]],
              [[x0, y0, z0], [x0, y0, z1]], [[x1, y0, z0], [x1, y0, z1]], [[x1, y1, z0], [x1, y1, z1]], [[x0, y1, z0], [x0, y1, z1]],
            ];
            for (const [a, b] of edges) {
              put(a[0], a[1], a[2]);
              put(b[0], b[1], b[2]);
            }
          }
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
          lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x1a1a1a, transparent: true, opacity: 0.42 }));
        } else {
          // 超大批次（万箱级）退回批次外壳，避免几百万顶点拖垮渲染
          const w = maxX - minX;
          const h = maxY - minY;
          const d = maxZ - minZ;
          lines = new THREE.LineSegments(
            new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d)),
            new THREE.LineBasicMaterial({ color: 0x1a1a1a, transparent: true, opacity: 0.5 }),
          );
          lines.position.set(minX + w / 2, minY + h / 2, minZ + d / 2);
        }
        lines.userData = { outline: true, boxId: batch.boxId, zMin: minZ, zMax: maxZ };
        outlineGroup!.add(lines);
        batch.outlines.push(lines);
      }
    }
  } else {
    // ---------- 整块模式：保留原聚合块渲染 ----------
    for (const p of result.placements) {
      const [dx, dy, dz] = p.dims;
      if (!(dx > 0 && dy > 0 && dz > 0)) continue;
      maxZOverall = Math.max(maxZOverall, p.z + dz);
      const geo = new THREE.BoxGeometry(dx * shrink, dy * shrink, dz * shrink);
      const baseColor = colorFor(p.boxId);
      const mat = new THREE.MeshStandardMaterial({ color: baseColor, roughness: 0.55, metalness: 0.08 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(p.x + dx / 2, p.y + dy / 2, p.z + dz / 2);
      mesh.userData = { boxId: p.boxId, kind: 'block' };
      boxGroup!.add(mesh);
      meshMeta.set(mesh, {
        boxId: p.boxId,
        material: mat,
        baseColor,
        placementId: `${p.boxId}-${p.x.toFixed(0)}-${p.y.toFixed(0)}-${p.z.toFixed(0)}`,
      });

      const boxLine = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo),
        new THREE.LineBasicMaterial({ color: 0x1a1a1a, transparent: true, opacity: 0.55 }),
      );
      boxLine.position.copy(mesh.position);
      boxLine.userData = { outline: true, boxId: p.boxId, zMin: p.z, zMax: p.z + dz };
      outlineGroup!.add(boxLine);
    }
  }
}

/** 重建场景（柜体 + 标注 + 货物） */
function buildScene(result: PackResult): void {
  if (!scene || !boxGroup) return;
  // 清理柜体与标注（货物由 buildCargo 自行清理）
  if (shellGroup) {
    while (shellGroup.children.length) {
      const child = shellGroup.children.pop();
      if (child) {
        child.traverse((obj) => {
          const any = obj as THREE.Mesh | THREE.LineSegments | THREE.Sprite;
          any.geometry?.dispose();
          const mat = any.material as THREE.Material | THREE.Material[] | undefined;
          if (Array.isArray(mat)) {
            mat.forEach((m) => m.dispose());
          } else {
            mat?.dispose();
          }
        });
      }
    }
  }
  meshMeta.clear();
  hoverInfo.value = null;
  selectedBoxId = null;
  highlightBoxIdInternal = null;

  const c = result.container;
  const L = c.innerLength;
  const W = c.innerWidth;
  const H = c.innerHeight;

  // ---------- 柜体：半透明外框 + 深色边线 + 尺寸标注 ----------
  const shellGeo = new THREE.BoxGeometry(L, W, H);
  const shellMat = new THREE.MeshStandardMaterial({
    color: 0x8fb8e8,
    transparent: true,
    opacity: 0.1,
    depthWrite: false,
    side: THREE.DoubleSide,
    roughness: 0.9,
    metalness: 0,
  });
  const shell = new THREE.Mesh(shellGeo, shellMat);
  shell.position.set(L / 2, W / 2, H / 2);
  shellGroup!.add(shell);

  const edgesGeo = new THREE.EdgesGeometry(shellGeo);
  const edgesLine = new THREE.LineSegments(edgesGeo, new THREE.LineBasicMaterial({ color: 0x23467a, transparent: true, opacity: 0.85 }));
  edgesLine.position.set(L / 2, W / 2, H / 2);
  shellGroup!.add(edgesLine);

  // 尺寸标注：L / W / H 文本 + 刻度线
  const labelL = makeLabel(`L=${L}mm`, '#1f3a66');
  labelL.position.set(L / 2, -80, H + 260);
  const labelW = makeLabel(`W=${W}mm`, '#1f3a66');
  labelW.position.set(L + 300, W / 2, H + 260);
  const labelH = makeLabel(`H=${H}mm`, '#1f3a66');
  labelH.position.set(L + 300, -80, H / 2);
  shellGroup!.add(labelL, labelW, labelH);

  const step = tickStep(Math.max(L, W, H));
  shellGroup!.add(
    makeTicks(new THREE.Vector3(0, 0, H), new THREE.Vector3(1, 0, 0), L, step),
    makeTicks(new THREE.Vector3(0, 0, H), new THREE.Vector3(0, 1, 0), W, step),
    makeTicks(new THREE.Vector3(L, W, 0), new THREE.Vector3(0, 0, 1), H, step),
  );

  // ---------- 已装货物（逐箱 / 整块） ----------
  buildCargo();

  const maxZ = maxZOverall;
  sliceMax.value = Math.ceil(maxZ);
  sliceZ.value = Math.ceil(maxZ);
  applySlice();

  // 相机视角：按柜体在当前视线下的真实投影范围拟合
  fitCameraToBox();
  applyShell();
  applyOutline();
}

/**
 * 把柜体 8 个角点投影到给定视线的屏幕基上，求真实半宽/半高/半深
 * 比包围球紧得多 —— 40HQ 这类细长柜体用包围球会留出大片空白
 */
function projectedHalfExtents(dir: THREE.Vector3): { hw: number; hv: number; hd: number } {
  const c = props.result!.container;
  const L = c.innerLength;
  const W = c.innerWidth;
  const H = c.innerHeight;
  const center = new THREE.Vector3(L / 2, W / 2, H / 2);
  const fwd = dir.clone().normalize(); // 由相机指向目标
  const upRef = Math.abs(fwd.z) > 0.95 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  const right = upRef.clone().cross(fwd).normalize();
  const up = fwd.clone().cross(right).normalize();

  let hw = 0;
  let hv = 0;
  let hd = 0;
  for (const cx of [0, L]) {
    for (const cy of [0, W]) {
      for (const cz of [0, H]) {
        const v = new THREE.Vector3(cx, cy, cz).sub(center);
        hw = Math.max(hw, Math.abs(v.dot(right)));
        hv = Math.max(hv, Math.abs(v.dot(up)));
        hd = Math.max(hd, Math.abs(v.dot(fwd)));
      }
    }
  }
  return { hw, hv, hd };
}

/** 依据视线方向计算恰好入画的相机距离（含近端透视余量） */
function fitDistance(dir: THREE.Vector3): number {
  const { hw, hv, hd } = projectedHalfExtents(dir);
  const tanV = Math.tan((camera!.fov * Math.PI) / 360);
  const tanH = tanV * camera!.aspect;
  // 近端角点比中心更靠近相机、透视下更大，补足 hd 保证不被近裁剪
  return Math.max(hv / tanV, hw / tanH) + hd;
}

/** 应用相机位置：dir 为由目标指向相机的方向 */
function applyCamera(dir: THREE.Vector3, keepDefault: boolean): void {
  if (!camera || !props.result) return;
  const c = props.result.container;
  const center = new THREE.Vector3(c.innerLength / 2, c.innerWidth / 2, c.innerHeight / 2);
  const dist = fitDistance(dir);
  camera.position.copy(center).add(dir.clone().normalize().multiplyScalar(dist));
  camera.near = Math.max(1, dist / 500);
  camera.far = dist * 6;
  camera.updateProjectionMatrix();
  controls?.target.copy(center);
  controls?.update();
  if (keepDefault) {
    defaultCameraPos = camera.position.clone();
  }
}

/** 相机视角：按柜体在当前视线下的真实投影范围拟合 */
function fitCameraToBox(): void {
  if (!camera || !props.result) return;
  // 默认视线（斜 45° 俯视）
  applyCamera(new THREE.Vector3(0.55, 0.62, 0.56), true);
}

/** 分层切片：隐藏 z 超过阈值的货物（逐箱与整块两种模式都支持） */
function applySlice(): void {
  if (!boxGroup || !props.result) return;
  const limit = sliceZ.value;
  if (renderMode.value === 'carton') {
    for (const batch of cartonBatches) {
      if (batch.instanced) {
        // InstancedMesh 按 z 升序排列，count 即"完全在阈值以下"的箱数
        let visible = 0;
        for (let i = 0; i < batch.cartons.length; i++) {
          if (batch.cartons[i].z + batch.cartons[i].dims[2] <= limit + 1e-6) {
            visible = i + 1;
          } else {
            break;
          }
        }
        batch.instanced.count = visible;
        // 逐箱描边与箱体共用同一 z 升序，故用 drawRange 同步裁剪
        // （否则切片后所有边线仍完整显示，会比切片前更乱）
        const per = batch.edgeVertsPerCarton;
        for (const line of batch.outlines) {
          if (per) {
            line.geometry.setDrawRange(0, visible * per);
          } else {
            // 批次外壳：不做部分切片，仅在"未切片"时显示
            line.visible = visible >= batch.cartons.length;
          }
        }
      }
    }
  } else {
    boxGroup.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        const meta = meshMeta.get(obj);
        const pl = meta
          ? props.result!.placements.find(
              (p) => meta.placementId === `${p.boxId}-${p.x.toFixed(0)}-${p.y.toFixed(0)}-${p.z.toFixed(0)}`,
            )
          : undefined;
        obj.visible = pl ? pl.z + pl.dims[2] <= limit + 1e-6 : true;
      }
    });
  }
  applyHighlight();
}

function applyShell(): void {
  if (shellGroup) shellGroup.visible = showShell.value;
}
function applyOutline(): void {
  if (!outlineGroup) return;
  outlineGroup.visible = showOutline.value;
  if (renderMode.value === 'carton') {
    // 逐箱模式的轮廓在 buildCargo 内按需生成，这里按开关重建
    buildCargo();
    const maxZ = maxZOverall;
    sliceMax.value = Math.ceil(maxZ);
    sliceZ.value = Math.ceil(maxZ);
    applySlice();
  }
}

/** 应用高亮（点击选中 / 外部联动）：逐箱与整块两种模式 */
function applyHighlight(): void {
  if (!boxGroup) return;
  const active = selectedBoxId ?? highlightBoxIdInternal;

  if (renderMode.value === 'carton') {
    // 装柜步骤高亮：按 placementIndex 逐实例着色，命中的提亮、其余压暗。
    // 批（货物×姿态）可能横跨多个步骤，所以必须落到 instanceColor 逐实例处理，
    // 只改批次材质无法区分步骤。
    const stepSet = props.highlightPlacements;
    if (stepSet && stepSet.length > 0) {
      const want = new Set(stepSet);
      for (const batch of cartonBatches) {
        const inst = batch.instanced;
        if (!inst) continue;
        const list = batch.cartons;
        let touched = false;
        for (let i = 0; i < list.length; i++) {
          const jitter = 0.965 + ((((list[i].index * 2654435761) % 97) as number) / 97) * 0.07;
          tmpColor.copy(batch.baseColor).multiplyScalar(want.has(list[i].placementIndex) ? Math.min(1, jitter * 1.45) : jitter * 0.3);
          inst.setColorAt(i, tmpColor);
          touched = true;
        }
        if (touched && inst.instanceColor) {
          inst.instanceColor.needsUpdate = true;
        }
        // 材质回到中性（步骤高亮完全由实例颜色表达）
        batch.materials.forEach((m) => {
          m.opacity = 1;
          m.transparent = false;
          m.emissive.setHex(0x000000);
          m.emissiveIntensity = 0;
        });
      }
      return;
    }

    // 无步骤高亮时把实例颜色恢复成常态（清掉上一次步骤高亮的压暗）
    for (const batch of cartonBatches) {
      const inst = batch.instanced;
      if (!inst) continue;
      const list = batch.cartons;
      let touched = false;
      for (let i = 0; i < list.length; i++) {
        const jitter = 0.965 + ((((list[i].index * 2654435761) % 97) as number) / 97) * 0.07;
        tmpColor.copy(batch.baseColor).multiplyScalar(jitter);
        inst.setColorAt(i, tmpColor);
        touched = true;
      }
      if (touched && inst.instanceColor) {
        inst.instanceColor.needsUpdate = true;
      }
    }

    // 逐箱模式：命中货物批次保留原色并提亮，其余批次压暗
    for (const batch of cartonBatches) {
      if (!batch.instanced) continue;
      const isActive = active === null || batch.boxId === active;
      batch.materials.forEach((m) => {
        m.opacity = 1;
        m.transparent = false;
        if (isActive) {
          m.emissive.copy(batch.baseColor);
          m.emissiveIntensity = 0.35;
        } else {
          m.emissive.setHex(0x000000);
          m.emissiveIntensity = 0;
        }
      });
      batch.instanced.visible = true;
    }
    // 轮廓线跟随高亮
    if (outlineGroup) {
      for (const line of outlineGroup.children) {
        const lid = (line.userData as { boxId?: string }).boxId;
        const mat = (line as THREE.LineSegments).material as THREE.LineBasicMaterial;
        if (lid && active !== null && lid !== active) {
          mat.opacity = 0.12;
        } else {
          mat.opacity = 0.5;
        }
      }
    }
    return;
  }

  // 整块模式：沿用原逻辑
  boxGroup.traverse((obj) => {
    const meta = obj instanceof THREE.Mesh ? meshMeta.get(obj) : undefined;
    if (meta) {
      if (active !== null && meta.boxId === active && obj.visible) {
        meta.material.emissive.copy(meta.baseColor);
        meta.material.emissiveIntensity = 0.45;
      } else {
        meta.material.emissive.setHex(0x000000);
        meta.material.emissiveIntensity = 0;
      }
    }
  });
}

/** 视图切换：各视图沿指定法线观察，距离按该视线下的真实投影拟合 */
function setView(view: 'top' | 'front' | 'side' | 'persp'): void {
  if (!camera || !controls || !props.result) return;
  if (view === 'persp') {
    camera.up.set(0, 0, 1);
    fitCameraToBox();
    return;
  }
  if (view === 'top') {
    camera.up.set(0, 1, 0);
    applyCamera(new THREE.Vector3(0, 0, 1), false);
  } else if (view === 'front') {
    // 沿 +y 看：屏幕上 x=长、z=高
    camera.up.set(0, 0, 1);
    applyCamera(new THREE.Vector3(0, 1, 0), false);
  } else {
    // 沿 +x 看：屏幕上 y=宽、z=高
    camera.up.set(0, 0, 1);
    applyCamera(new THREE.Vector3(1, 0, 0), false);
  }
}

/**
 * 把当前 3D 画面导出为 PNG dataURL（**不触发下载**）
 *
 * 供「装柜报表」页调用：报表里要放 3D 示意图，而打印走的是 `<img>` 而非活的 WebGL canvas
 * —— canvas 直接进打印件在不同浏览器/驱动下时序不可靠（可能印出空白帧），
 * 先定格成一张图片，屏幕上的 3D 交互与打印出的示意图就完全解耦了。
 */
function capturePNG(): string {
  if (!renderer || !scene || !camera) return '';
  renderer.render(scene, camera);
  return renderer.domElement.toDataURL('image/png');
}

/** 导出 PNG（下载） */
function exportPNG(): void {
  const url = capturePNG();
  if (!url) return;
  const a = document.createElement('a');
  a.href = url;
  a.download = `packing-${Date.now()}.png`;
  a.click();
}

/** 供外部（报表页）调用：取图 + 复位到默认视角（保证示意图每次都是同一个角度） */
defineExpose({ capturePNG, resetView: () => setView('persp') });

/** 点击拾取（逐箱 / 整块通用） */
function onCanvasClick(e: MouseEvent): void {
  const el = mountEl.value;
  const dom = renderer?.domElement;
  if (!el || !dom || !camera || !boxGroup) return;
  const rect = dom.getBoundingClientRect();
  pointerNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointerNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointerNdc, camera);

  // 收集可拾取对象：逐箱模式取 InstancedMesh，整块模式取普通 Mesh
  const targets: THREE.Object3D[] = [];
  boxGroup.traverse((obj) => {
    if (obj instanceof THREE.Mesh && obj.visible) {
      if (obj instanceof THREE.InstancedMesh) {
        // count 已被切片截断，超出部分不参与拾取
        targets.push(obj);
      } else {
        targets.push(obj);
      }
    }
  });
  const hits = raycaster.intersectObjects(targets, false);
  if (hits.length === 0) {
    selectedBoxId = null;
    hoverInfo.value = null;
    applyHighlight();
    return;
  }

  const hit = hits[0];
  const object = hit.object as THREE.Mesh;
  const boxId = (object.userData as { boxId?: string }).boxId;
  if (!boxId) return;

  let worldX: number;
  let worldY: number;
  let worldZ: number;
  let dx: number;
  let dy: number;
  let dz: number;
  let x0: number;
  let y0: number;
  let z0: number;
  let cartonIndex: number | null = null;

  if (object instanceof THREE.InstancedMesh) {
    // 逐箱：instanceId 映射回具体那一箱
    const batch = cartonBatches.find((b) => b.instanced === object);
    const iid = hit.instanceId;
    if (!batch || iid === undefined || iid < 0 || iid >= batch.cartons.length) return;
    const ct = batch.cartons[iid];
    cartonIndex = ct.index;
    x0 = ct.x;
    y0 = ct.y;
    z0 = ct.z;
    dx = ct.dims[0];
    dy = ct.dims[1];
    dz = ct.dims[2];
    worldX = x0 + dx / 2;
    worldY = y0 + dy / 2;
    worldZ = z0 + dz / 2;
  } else {
    // 整块：回查原 placement
    const meta = meshMeta.get(object);
    if (!meta) return;
    const pl = props.result?.placements.find(
      (p) => meta.placementId === `${p.boxId}-${p.x.toFixed(0)}-${p.y.toFixed(0)}-${p.z.toFixed(0)}`,
    );
    if (!pl) return;
    x0 = pl.x;
    y0 = pl.y;
    z0 = pl.z;
    dx = pl.dims[0];
    dy = pl.dims[1];
    dz = pl.dims[2];
    worldX = object.position.x;
    worldY = object.position.y;
    worldZ = object.position.z;
  }

  selectedBoxId = boxId;
  highlightBoxIdInternal = null;
  applyHighlight();
  emit('select', boxId);

  // 屏幕坐标 → 浮层位置
  const v = new THREE.Vector3(worldX, worldY, worldZ);
  v.project(camera);
  const domRect = dom.getBoundingClientRect();
  const px = ((v.x + 1) / 2) * domRect.width;
  const py = ((-v.y + 1) / 2) * domRect.height;
  const totalForBox = cartonBatches
    .find((b) => b.boxId === boxId)
    ?.cartons.reduce((s, c) => s + 1, 0);

  hoverInfo.value = {
    x: px + 16,
    y: py - 8,
    name: boxName(boxId),
    sku: boxSku(boxId),
    x0: Math.round(x0),
    y0: Math.round(y0),
    z0: Math.round(z0),
    dx: Math.round(dx),
    dy: Math.round(dy),
    dz: Math.round(dz),
    // 逐箱模式显示单箱（count=1）+ 序号；整块模式显示整块箱数
    count: cartonIndex !== null ? 1 : (props.result?.placements.find((p) => p.boxId === boxId)?.count ?? 0),
    cartonIndex,
    totalForBox: totalForBox ?? 0,
    boxId,
  };
}

/** 图例点击聚焦 */
function focusBox(boxId: string): void {
  selectedBoxId = boxId;
  highlightBoxIdInternal = null;
  applyHighlight();
}

function animate(): void {
  frameId = requestAnimationFrame(animate);
  controls?.update();
  if (renderer && scene && camera) {
    renderer.render(scene, camera);
  }
}

function init(): void {
  const el = mountEl.value;
  if (!el) return;
  if (el.clientWidth === 0 || el.clientHeight === 0) return;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf5f7fa);

  camera = new THREE.PerspectiveCamera(50, el.clientWidth / el.clientHeight, 0.1, 200000);
  /**
   * 相机 up 必须显式设为 **世界 +z**，因为本项目**高度轴是 z**（柜体 z ∈ [0, innerHeight]）。
   *
   * 修复的正是用户报的「3D 图把宽高两个方向展示错了」：
   * Three.js 的 `camera.up` 默认是 **(0,1,0)**，而本场景里 y 是**宽度**轴。
   * 原来 `camera.up` 只在 `setView()` 里被赋值，`init()` 与 `applyCamera()` 都没设，
   * 于是**页面刚打开、还没点任何视图按钮时**，OrbitControls 用 (0,1,0) 摆正相机 →
   * **宽度被当成竖直方向、高度轴斜着**，整个柜体是"躺倒"的。
   * 一旦点俯视/正视/侧视/透视，`setView` 补上 `camera.up` 就正常了 ——
   * 所以现象是"初始视角不对、点一下就好了"。
   *
   * 另外 `projectedHalfExtents()` 也是按 up=(0,0,1) 推算投影范围的，
   * up 不对时连相机距离都算错（表现为内容溢出面板）。
   */
  camera.up.set(0, 0, 1);
  camera.position.copy(defaultCameraPos);

  // preserveDrawingBuffer：让 toDataURL 能稳定取到画面。
  // 浏览器默认在合成后即丢弃绘制缓冲，若 `capturePNG` 不紧跟在一次 render 之后
  // （例如报表页要等若干帧再取图），toDataURL 会拿到空白图。
  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(el.clientWidth, el.clientHeight);
  el.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;

  // 光照：环境光 + 主方向光 + 补方向光 + 背光
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 1.15);
  key.position.set(1.2, 1.5, 0.8);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xbcd4ff, 0.5);
  fill.position.set(-1, 0.4, -1);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffffff, 0.3);
  rim.position.set(0, 0.2, 1.6);
  scene.add(rim);

  boxGroup = new THREE.Group();
  scene.add(boxGroup);
  shellGroup = new THREE.Group();
  scene.add(shellGroup);
  outlineGroup = new THREE.Group();
  scene.add(outlineGroup);

  if (props.result) {
    buildScene(props.result);
  }
  animate();

  clickHandler = (e: MouseEvent) => onCanvasClick(e);
  renderer.domElement.addEventListener('click', clickHandler);

  resizeHandler = () => {
    if (!renderer || !camera || !el) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (w === 0 || h === 0) return;
    // 尺寸没变就别动相机：fitCameraToBox 会重置用户已经调好的视角，
    // 而 ResizeObserver 在某些布局变化里会重复触发，白白把用户的视角打回默认。
    if (w === lastW && h === lastH) return;
    lastW = w;
    lastH = h;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    // 视口比例变化后按新 aspect 重新拟合，避免裁切
    fitCameraToBox();
  };

  /**
   * 监听**面板自身**尺寸变化，而不只是 window resize
   *
   * 侧边栏收成抽屉、el-col 的 :md 断点折叠、卡片换行 ——
   * 这些都会改变画布尺寸但**不触发 window resize**，于是 camera.aspect 与
   * 画布分辨率就与实际显示尺寸对不上（表现为画面被拉伸或内容溢出）。
   */
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => resizeHandler?.());
    resizeObserver.observe(el);
  }
  window.addEventListener('resize', resizeHandler);
}

function dispose(): void {
  cancelAnimationFrame(frameId);
  resizeObserver?.disconnect();
  resizeObserver = null;
  if (resizeHandler) {
    window.removeEventListener('resize', resizeHandler);
    resizeHandler = null;
  }
  if (clickHandler && renderer) {
    renderer.domElement.removeEventListener('click', clickHandler);
    clickHandler = null;
  }
  controls?.dispose();
  controls = null;
  if (renderer && mountEl.value?.contains(renderer.domElement)) {
    mountEl.value.removeChild(renderer.domElement);
  }
  renderer?.dispose();
  renderer = null;
  scene = null;
  camera = null;
  boxGroup = null;
  shellGroup = null;
  outlineGroup = null;
}

watch(
  () => props.result,
  (v) => {
    if (v) buildScene(v);
  },
);

/**
 * 货物元数据晚于计算结果到达时**重建 3D**
 *
 * 实测故障：从「方案列表」加载历史方案后，3D 只剩一个空柜体壳子、货物全没了
 * （切片滑块同时变成"全部"，因为 `maxZOverall === 0`）。
 *
 * 原因：CalculateView 在 `onMounted` 里**同步**恢复 `result`（读 localStorage），
 * 而 `boxes` 要等 `api.listBoxes()` 异步返回。于是第一次 `buildScene` 拿到的
 * `props.boxes` 是空数组 → `expandResult(result, [])` 返回 0 个逐箱坐标 →
 * `buildCargo` 直接 return、`maxZOverall` 停在 0。
 * 而 Packing3D 原本**只 watch result**，boxes 后到也不会重建，
 * 于是 3D 一直空着，直到用户手动重新计算一次。
 */
watch(
  () => props.boxes,
  () => {
    if (props.result) {
      buildScene(props.result);
    }
  },
);

// 切换渲染模式：重建货物区（柜体与标注不变）
watch(renderMode, () => {
  if (!props.result) return;
  buildCargo();
  const maxZ = maxZOverall;
  sliceMax.value = Math.ceil(maxZ);
  sliceZ.value = Math.ceil(maxZ);
  applySlice();
});

// 外部联动：高亮指定货物
watch(
  () => props.highlightBoxId,
  (v) => {
    if (v) {
      selectedBoxId = null;
      highlightBoxIdInternal = v;
    } else {
      highlightBoxIdInternal = null;
    }
    applyHighlight();
  },
);

// 外部联动：高亮指定装柜步骤（优先级高于按货物高亮）
watch(
  () => props.highlightPlacements,
  () => {
    if (props.highlightPlacements && props.highlightPlacements.length > 0) {
      // 步骤高亮与悬停/选中互斥，避免两套效果叠加
      selectedBoxId = null;
      highlightBoxIdInternal = null;
    }
    applyHighlight();
  },
);

onMounted(init);
onBeforeUnmount(dispose);

/**
 * KeepAlive 缓存期间停掉渲染循环，重新激活时补一帧
 *
 * App.vue 给 router-view 包了 `<KeepAlive>`，本页被切走时组件**不会卸载**，
 * 只是被移出文档。如果放任 `requestAnimationFrame` 一直跑：
 * - 用户不在这一页时仍然满帧渲染，白烧 CPU / 电池
 * - 而且 KeepAlive 期间 canvas 脱离文档，部分浏览器会丢弃 WebGL 绘制缓冲，
 *   切回来看到一片黑。重新激活时强制 render 一帧即可恢复
 *   （`preserveDrawingBuffer: true` 也起了兜底作用，见 init 里的说明）
 */
onActivated(() => {
  if (renderer && scene && camera) {
    // 面板宽度可能因侧栏/窗口变化而不同，重算 aspect 并按新尺寸渲染
    const el = mountEl.value;
    if (el && el.clientWidth > 0 && el.clientHeight > 0) {
      camera.aspect = el.clientWidth / el.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(el.clientWidth, el.clientHeight);
    }
    controls?.update();
    renderer.render(scene, camera);
  }
  if (!frameId && renderer) {
    frameId = requestAnimationFrame(animate);
  }
});

onDeactivated(() => {
  cancelAnimationFrame(frameId);
  frameId = 0;
});
</script>

<style scoped>
.packing3d-wrap {
  position: relative;
  height: 520px;
  border: 1px solid #e6e6e6;
  border-radius: 6px;
  overflow: hidden;
  background: #f5f7fa;
}
.packing3d-canvas {
  width: 100%;
  height: 100%;
}
.packing3d-tips {
  position: absolute;
  right: 10px;
  bottom: 8px;
  font-size: 12px;
  color: #909399;
  background: rgba(255, 255, 255, 0.85);
  padding: 2px 8px;
  border-radius: 4px;
  pointer-events: none;
}
.packing3d-stats {
  position: absolute;
  left: 10px;
  top: 10px;
  display: flex;
  gap: 16px;
  background: rgba(255, 255, 255, 0.92);
  border: 1px solid #e6e6e6;
  border-radius: 6px;
  padding: 6px 12px;
  pointer-events: none;
  z-index: 5;
}
.stat-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  line-height: 1.3;
}
.stat-label {
  font-size: 11px;
  color: #909399;
}
.stat-value {
  font-size: 15px;
  font-weight: 600;
  color: #1f2d3d;
}
.packing3d-toolbar {
  position: absolute;
  left: 10px;
  top: 60px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  background: rgba(255, 255, 255, 0.95);
  border: 1px solid #e6e6e6;
  border-radius: 6px;
  padding: 6px 10px;
  z-index: 5;
  font-size: 13px;
}
.toolbar-sep {
  width: 1px;
  height: 18px;
  background: #dcdfe6;
  margin: 0 4px;
}
.toolbar-item {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #606266;
}
.slice-slider {
  width: 140px;
  --el-slider-main-bg-color: #409eff;
}
.slice-value {
  min-width: 58px;
  color: #303133;
  font-variant-numeric: tabular-nums;
}
.mode-hint {
  color: #909399;
  font-size: 12px;
  white-space: nowrap;
}
.packing3d-legend {
  position: absolute;
  /* 左下角：右上角是视图切换/切片/渲染模式工具栏，右下角是操作提示，
     面板变窄时放右上会压住「透视」等按钮（已实测复现） */
  left: 10px;
  bottom: 28px;
  width: 190px;
  background: rgba(255, 255, 255, 0.94);
  border: 1px solid #e6e6e6;
  border-radius: 6px;
  padding: 8px 10px;
  z-index: 5;
  max-height: 320px;
  overflow-y: auto;
}
.legend-title {
  font-size: 13px;
  font-weight: 600;
  color: #303133;
  margin-bottom: 6px;
}
.legend-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 4px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  color: #606266;
}
.legend-item:hover {
  background: #f0f2f5;
}
.legend-dot {
  width: 12px;
  height: 12px;
  border-radius: 3px;
  flex: none;
}
.legend-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.legend-count {
  color: #909399;
}
.packing3d-hover {
  position: absolute;
  min-width: 220px;
  background: rgba(255, 255, 255, 0.97);
  border: 1px solid #d9d9d9;
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
  padding: 8px 12px;
  z-index: 10;
  pointer-events: none;
  font-size: 12px;
}
.hover-title {
  font-weight: 600;
  color: #303133;
  margin-bottom: 4px;
  font-size: 13px;
}
.hover-row {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  color: #606266;
  line-height: 1.5;
}
.hover-row span:last-child {
  color: #303133;
  font-variant-numeric: tabular-nums;
}

/* ───────────── 窄屏：控制条从"浮在画布上"改为"排在画布下方" ─────────────
 *
 * ## 为什么要这么改
 *
 * 统计条 / 工具栏 / 图例 / 提示这四块原本都是 `position: absolute` 浮在 wrap 里的，
 * 工具栏在窄屏还会折成 2~3 行。第一版只是把 wrap 从 520px 压到 260px，
 * 结果**画布几乎看不见了** —— 260px 里被浮层吃掉大半，柜体只剩一条细缝。
 *
 * 窄屏改成 flex 纵向流：画布固定高占满，控制条按 DOM 顺序排到下面。
 * 既保证模型有完整的显示区域，控制条也能拿到整行宽度（不再折行），手指点按钮也更准。
 * hover 提示（.packing3d-hover）保持绝对定位 —— 它要跟着鼠标走。
 *
 * ## 这段必须放在样式块的**最后**（同一个坑踩了两次）
 *
 * 媒体查询只是"条件成立时提高优先级"，**并不会自动排到基础规则后面**。
 * 同优先级下按源码顺序后者胜，所以：
 *   - 放在 `.packing3d-canvas { height: 100% }` 前面 → 画布高度算成 **0px**
 *     （父级此时 height:auto，100% 无参照）
 *   - 放在 `.packing3d-toolbar { position: absolute }` 前面 → 工具栏仍浮着
 * 两次都是靠 inspect 读计算样式才发现，肉眼看截图只会觉得"怎么还是老样子"。
 */
@media (max-width: 991px) {
  .packing3d-wrap {
    display: flex;
    flex-direction: column;
    height: auto;
  }
  .packing3d-canvas {
    order: 1;
    flex: none;
    height: 300px;
  }
  .packing3d-stats {
    order: 2;
    position: static;
    margin: 8px 8px 0;
    border-radius: 0 0 6px 6px;
  }
  .packing3d-toolbar {
    order: 3;
    position: static;
    margin: 8px;
    flex-wrap: wrap;
    border-radius: 4px;
  }
  .packing3d-legend {
    order: 4;
    position: static;
    margin: 0 8px 8px;
    max-height: none;
  }
  .packing3d-tips {
    order: 5;
    position: static;
    margin: 0 8px 8px;
    text-align: center;
  }
}
@media (max-width: 480px) {
  .packing3d-canvas {
    height: 240px;
  }
}
</style>
