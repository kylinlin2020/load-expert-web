/**
 * 相机 up 向量对 3D 图"宽/高方向"的影响（验证 camera.up 修复）
 *
 * Packing3D 的初始视角由 fitCameraToBox() → applyCamera(dir) 决定，
 * 相机最终朝向 = lookAt(target) 且以 camera.up 为"屏幕上方"。
 * 本项目高度轴是 z、宽度轴是 y，而 Three.js 的 camera.up 默认是 (0,1,0)。
 * 若不显式改成 (0,0,1)，宽度轴就会被当成屏幕竖直方向。
 *
 * 用法：node scripts/camera-up-check.mjs
 */
import * as THREE from 'three';

const L = 13556;
const W = 2352;
const H = 2698;
const DIR = new THREE.Vector3(0.55, 0.62, 0.56);

/** 复现 Packing3D.projectedHalfExtents + applyCamera 的相机摆放 */
function placeCamera(upVec) {
  const camera = new THREE.PerspectiveCamera(50, 600 / 520, 0.1, 200000);
  camera.up.copy(upVec);
  const center = new THREE.Vector3(L / 2, W / 2, H / 2);

  // 与 projectedHalfExtents 同源：upRef 只按视线方向决定，与 camera.up 无关
  const fwd = DIR.clone().normalize();
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
  const tanV = Math.tan((camera.fov * Math.PI) / 360);
  const tanH = tanV * camera.aspect;
  const dist = Math.max(hv / tanV, hw / tanH) + hd;
  camera.position.copy(center).add(fwd.clone().multiplyScalar(dist));
  camera.near = Math.max(1, dist / 500);
  camera.far = dist * 6;
  camera.lookAt(center); // OrbitControls.update() 内部等价于此
  camera.updateMatrixWorld(true);
  return camera;
}

/**
 * 把**世界方向**投影到屏幕（NDC）
 *
 * 注意：`project()` 只能投点，不能投方向（方向没有位置，投影无意义）。
 * 必须取 center 与 center+dir·S 两点投影后作差。
 */
function screenDir(camera, worldDir, center, S) {
  const a = center.clone().project(camera);
  const b = center.clone().addScaledVector(worldDir, S).project(camera);
  return { right: b.x - a.x, up: b.y - a.y };
}

const AXES = [
  ['长 L (x)', new THREE.Vector3(1, 0, 0)],
  ['宽 W (y)', new THREE.Vector3(0, 1, 0)],
  ['高 H (z)', new THREE.Vector3(0, 0, 1)],
];

for (const [label, upVec] of [
  ['修复前：camera.up = (0,1,0)（Three.js 默认，未显式设置）', new THREE.Vector3(0, 1, 0)],
  ['修复后：camera.up = (0,0,1)（本项目高度轴）', new THREE.Vector3(0, 0, 1)],
]) {
  const cam = placeCamera(upVec);
  const center = new THREE.Vector3(L / 2, W / 2, H / 2);
  console.log(`\n${label}`);
  const dirs = AXES.map(([n, v]) => {
    const d = screenDir(cam, v, center, 1000);
    // 单位世界向量投影后的屏幕分量，衡量"该轴在屏幕上的走向"
    return { n, right: d.right, up: d.up };
  });
  for (const d of dirs) {
    const len = Math.hypot(d.right, d.up) || 1;
    console.log(
      `  ${d.n.padEnd(9)} 屏幕右 ${(d.right / len).toFixed(3).padStart(7)}  屏幕上 ${(d.up / len).toFixed(3).padStart(7)}`,
    );
  }
  // 判定：高度轴是否"竖直"（屏幕上分量为 ±1、水平分量为 0）
  const h = dirs[2];
  const hLen = Math.hypot(h.right, h.up) || 1;
  const vertical = Math.abs(h.up / hLen);
  const horizontal = Math.abs(h.right / hLen);
  console.log(`  → 高度轴竖直度 ${(vertical * 100).toFixed(1)}%（理想 100%），水平偏移 ${(horizontal * 100).toFixed(1)}%`);
  console.log(`  → ${vertical > 0.99 ? '✅ 高度轴竖直，宽在水平方向' : '❌ 高度轴歪了，宽被当成竖直方向'}`);
}