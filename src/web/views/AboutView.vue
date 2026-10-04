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
          <el-tag :type="isStaticBuild ? 'warning' : 'success'" effect="dark" size="small">
            {{ isStaticBuild ? '纯静态版（数据在本浏览器）' : '服务端版（数据在后端）' }}
          </el-tag>
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
      <!--
        静态版最需要说清的一件事：数据只在**这一个浏览器**里。
        不写清楚的话，用户会以为和在服务器版里看到的是同一份数据，
        或以为数据"在云上"。误清一次浏览器数据 = 全部货物/柜型/方案永久丢失。
      -->
      <el-alert
        v-if="isStaticBuild"
        class="mt12"
        type="error"
        show-icon
        :closable="false"
        title="数据保存在本浏览器的 IndexedDB 中，没有服务器副本"
      >
        <!--
          用默认插槽而不是 description 属性：description 是**纯字符串**，
          里面的 markdown 不会被渲染，`**` 会原样显示给用户。
          这一条尤其不该出错 —— 它是数据丢失警告，字面星号会让警告的可信度打折。
        -->
        <template #default>
          换浏览器、换电脑、换域名都看不到这份数据。清除浏览器数据 / 站点数据 / 用无痕窗口，
          都会让录入的货物、柜型、方案<strong>全部丢失且无法恢复</strong>。请只在一个固定浏览器里使用。
        </template>
      </el-alert>

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
      <p class="tip">
        <strong>请定期到「数据备份」页导出一份 JSON 存到网盘或 U 盘。</strong>
        录入的货物、柜型、方案在服务端版是后端的一个 SQLite 文件、在静态版是本浏览器的
        IndexedDB，误删或清浏览器数据都会<strong>永久丢失且无法恢复</strong>。
      </p>

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

      <h3 class="sec">六、数据存在哪里</h3>
      <p>
        本项目有两套构建产物，<strong>页面右上角会显示当前是哪一套</strong>。
        两套界面完全相同，区别只在数据放哪儿、算法在哪儿跑。
      </p>
      <div class="tbl-scroll">
        <table class="grid">
          <thead>
            <tr><th style="width: 120px">版本</th><th style="width: 130px">构建命令</th><th>数据</th><th style="width: 110px">算法在哪跑</th></tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>服务端版</strong></td>
              <td><code>npm run build:web</code></td>
              <td>后端 SQLite：<code>data/load-expert.db</code></td>
              <td>Node 服务端</td>
            </tr>
            <tr>
              <td><strong>纯静态版</strong></td>
              <td><code>npm run build:web:static</code></td>
              <td>
                本浏览器 IndexedDB（<code>load-expert</code> 库，boxes / containers / plans / cases 四张表）
              </td>
              <td><strong>浏览器内</strong></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="tip">
        两套版本跑的是<strong>同一份算法代码</strong>（<code>src/algorithm</code> 零 Node 依赖，直接编进浏览器包），
        装载率不会因为换了版本而变。<strong>但两边的数据互相独立、不会同步</strong> ——
        静态版里录入的货物不会出现在服务端版，反之亦然。
      </p>
      <el-alert
        type="success"
        show-icon
        :closable="false"
        title="但可以用「数据备份」把数据搬到另一套"
        description="两套构建用的是同一种备份文件格式：在有数据的那一套里「导出为 JSON 文件」，再到想要数据的那一套里「导入 → 覆盖恢复」即可。反过来也行。搬完之后两边各是各的，之后要保持一致就各自定期导出。"
      />

      <h3 class="sec">七、已知限制（据实说明）</h3>
      <div class="limits">
        <p><strong>以下几项没有权威规范可依，现按行业通行做法自拟 —— 与其他系统的输出不一定可互换：</strong></p>
        <ul class="manual">
          <li><strong>装柜步骤的排序规则与列结构</strong>：由本项目自定。
            当前按「自下而上、同层由柜内深处向门口推进」实现</li>
          <li><strong>柜门位置</strong>：数据模型里<strong>只记录了门尺寸，没有记录门在哪一端</strong>。
            所以计算页有「门在 x 最大端 / x = 0 端」的可切换开关，报表里也会写明用的是哪个约定</li>
          <li><strong>姿态命名</strong>：按"哪一轴朝上"推导（平放 / 侧放 / 立放）。
            注意与集装箱行业惯例未必一致</li>
          <li><strong>策略 4（承托分级分层）</strong>的承托分层细节为自拟实现，未经现场验证</li>
        </ul>
        <p class="tip">
          另外，「多选多个柜型」的分组对比编排<strong>放在前端</strong>（复用同一个单柜型后端端点若干次），
          不是后端的一个原生能力。分组与"最优柜型"判定逻辑在
          <code>src/web/lib/containerGroups.ts</code>，有单元测试覆盖。
        </p>
      </div>

      <h3 class="sec">八、反馈与实测</h3>

      <h4>实测案例（改进算法的主要途径）</h4>
      <ul class="manual">
        <li>
          <strong>什么时候该记</strong>：算出 966 箱，现场实际只装到 900 箱 ——
          这类偏差数据比"界面好不好用"重要得多，装柜有偏差时顺手记一条。
        </li>
        <li><strong>怎么记</strong>：装柜计算页算完后点「记录为实测案例」（紧挨「保存方案」）。</li>
        <li>
          <strong>实测值什么时候填</strong>：现场装完才知道，所以分两步 ——
          先记下算法输出，装完后到「实测案例」页补录实际箱数 / 柜数。
        </li>
        <li>
          <strong>柜型存的是快照</strong>，不是引用。之后你调整了柜型尺寸，
          这条案例仍反映"当时算的时候用的柜子"。
        </li>
        <li>
          <strong>算法输出不可改</strong>：补录实测只写现场那一半，
          不会篡改程序当时算出的结果 —— 所以两者的差始终可信。
        </li>
        <li>
          <strong>列表按偏差排序</strong>，偏差大的排最前。总览里区分「算法高估」与「算法保守」：
          高估最要紧，那种方案在现场装不下，发出去是要出事的。
        </li>
      </ul>

      <h4>意见反馈</h4>
      <ul class="manual">
        <li>
          <strong>两条路都留着</strong>：「意见反馈」页可复制诊断信息 / 下载诊断包（.json），
          也可直接提交 GitHub Issue（自动填好标题与正文）。
        </li>
        <li>
          <strong>复制那条最可靠</strong> —— 不需要账号、离线可用。
          诊断包是无损的，比截图加打字准确得多。
        </li>
        <li>
          <strong>错误与操作轨迹只存在当前页面的内存里</strong>，刷新或关页即消失。
          发现问题后<strong>先别刷新</strong>，直接去那一页导出。
        </li>
        <li>
          <strong>诊断信息不含业务数据</strong>：没有货物名称、尺寸、柜型等任何字段，
          只有版本、构建模式、浏览器、数据条数与错误堆栈。
          要附带具体数据的话，请自己到「数据备份」页导出一份。
        </li>
      </ul>

      <!-- ══════════ 九 ══════════
           放在最后一节、且不加侧边栏菜单项，是刻意的：
           工具页的菜单是干活的入口，把打赏塞进去会让它变成运营页。
           想支持的人会翻到这里，不想看的人不会被拦着。
      -->
      <h3 class="sec">九、支持作者</h3>
      <p class="tip">
        <strong>完全自愿。</strong>本项目免费、无任何付费墙，
        不支持也完全不影响使用 —— 所有功能对所有人一样开放。
      </p>
      <p>
        维护它需要时间：算法调优、实测案例的偏差分析、问题排查，
        大多在下班后和周末。如果它帮你省了时间、或者少出了一次差错，
        下面任选其一支持一下。
      </p>
      <div class="donate-row">
        <figure v-for="d in DONATE" :key="d.file" class="donate-item">
          <figcaption>{{ d.label }}</figcaption>
          <!--
            **刻意不裁剪、不缩放、不转格式**：
            收款码是 JPEG（有损），任何再处理都可能让二维码扫不出来，
            而我无法解码验证 —— 扫不出来比页面不好看严重得多。
            用 CSS max-width 控制显示尺寸即可：那是浏览器缩放，不改动文件本身。
            图片缺失时走 onError 占位，避免留一个碎图框。
          -->
          <img
            v-if="!imgFailed[d.file]"
            :src="d.src"
            :alt="`${d.label}收款码`"
            @error="onImgError(d.file)"
          />
          <div v-else class="donate-missing">收款码图片未找到</div>
        </figure>
      </div>
    </el-card>

    <div class="foot">LoadExpert Web · Vue 3 + TypeScript 全栈 · 算法引擎与界面均为本项目实现</div>
  </div>
</template>

<script setup lang="ts">
import { reactive } from 'vue';

/**
 * 支持作者：收款码
 *
 * ## 图片路径必须用 BASE_URL 拼，不能写死 `/donate-xxx.jpg`
 *
 * 静态版 `base: './'`（为了能部署到任意子路径），所以 index.html 里的资源引用
 * 是相对**当前 HTML 所在目录**的。若在模板里写 `/donate-alipay.jpg`，
 * 浏览器会解析到域名根目录 —— 线上就是
 * `https://kylinlin2020.github.io/donate-alipay.jpg` → **404**，
 * 而本地 `vite dev` 下 `/donate-alipay.jpg` 恰好能正常返回。
 *
 * 也就是说：**本地怎么测都是好的，一部署就坏，且不会报任何构建错误。**
 * `import.meta.env.BASE_URL` 随 base 变化，两套构建都对，故一律用它。
 *
 * ## 为什么不 import 图片
 *
 * `import img from '@/assets/x.jpg'` 由 Vite 打包，路径也正确，
 * 但图会被塞进 `src/assets/` 并带内容哈希。换收款码要改代码 + 重新构建，
 * 而放 `public/` 只需覆盖同名文件 —— 对"码可能要用几年"这件事，后者更省事。
 *
 * 代价是 public/ 下的文件**不进产物自检**（`check-static-bundle.mjs` 只看 JS），
 * 所以额外加了运行时 `onError` 占位兜底。
 */
const DONATE = [
  {
    label: '微信支付',
    file: 'donate-wechat.jpg',
    // 静态版 BASE_URL = './' → './donate-wechat.jpg'；服务端版 = '/' → '/donate-wechat.jpg'
    src: `${import.meta.env.BASE_URL}donate-wechat.jpg`,
  },
  {
    label: '支付宝',
    file: 'donate-alipay.jpg',
    src: `${import.meta.env.BASE_URL}donate-alipay.jpg`,
  },
];

/** 记录加载失败的图片，避免碎图框 */
const imgFailed = reactive<Record<string, boolean>>({});
function onImgError(file: string): void {
  imgFailed[file] = true;
  // 只记一次：开发时会刷屏，而线上没有 console 可看
  if (import.meta.env.DEV) console.warn(`[AboutView] 收款码图片未找到：${file}`);
}

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
 *
 * ## 为什么要显式显示"当前是哪一套版本"
 *
 * 纯静态版把数据存在浏览器的 IndexedDB 里。两套版本界面一模一样，
 * 不标出来的话很容易误以为两边是同一份数据 —— 而实际上它们完全独立。
 * 更严重的是"以为数据在服务器上有备份"，于是随手清一次浏览器数据就全没了。
 * 这个代价是不可逆的，所以必须在界面上讲明白，而不是只写在文档里。
 */
import { STRATEGY_NAMES, STRATEGY_HINTS } from '../../algorithm/candidate-blocks';
import { IS_STATIC_BUILD as isStaticBuild } from '../api/client';
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

/* ───────────── 支持作者 ───────────── */

/*
 * 两张收款码并排。
 *
 * **断点取 600px 而不是全局的 991px**：这页其余部分是长文档 + 宽表格，
 * 窄屏下靠横向滚动解决（重排一张 8 列报表毫无意义）。
 * 但这两张图并排只需要 2×240px，600px 以上就该并排 ——
 * 沿用 991px 会让 768px 的平板白占一大片竖向空间。
 */
.donate-row {
  display: flex;
  gap: 20px;
  justify-content: center;
  flex-wrap: wrap;
  margin-top: 14px;
}

.donate-item {
  margin: 0;
  text-align: center;
}

.donate-item figcaption {
  font-size: 12px;
  color: #909399;
  margin-bottom: 6px;
}

.donate-item img {
  /* 用 max-width 而非固定 width：图片没到位时不会撑破布局 */
  max-width: 240px;
  height: auto;
  border: 1px solid #ebeef5;
  border-radius: 6px;
  background: #fff;
  display: block;
}

.donate-missing {
  width: 240px;
  padding: 40px 12px;
  border: 1px dashed #dcdfe6;
  border-radius: 6px;
  font-size: 12px;
  color: #909399;
  background: #f5f7fa;
}

@media (max-width: 600px) {
  .donate-row {
    gap: 12px;
  }
  .donate-item img,
  .donate-missing {
    max-width: 100%;
    width: 220px;
  }
}
</style>