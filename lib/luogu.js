// 洛谷题库抓取。
//
// 为什么不做「全库爬」：洛谷 P 题有 1.6 万道、328 页，连着跑八分钟没必要，
// 也更容易触发风控。这里改成**按难度档等距抽页**：每一档先读一次总页数，
// 再均匀抽若干页（默认每档 8 页 = 400 题），单线程 + 1.2 秒间隔 + 单次请求上限。
// 实测（2026-09）：连续 12 次翻页、间隔 350ms 全部 200，没有 403/429；
// 这里取 1.2 秒更保守，一次完整同步（3 档 × 8 页）约 25 个请求、40 秒左右。
//
// 抽页而不是只取头几页：默认排序下前面几页都是老题（P1000 开头那批），
// 只抓头几页会让题单里全是十几年前的题——这点和 CF 题库那边同一个道理。

import { fetchLuoguText } from './platforms.js';

/** 单次同步最多发多少个请求。超了就报「这次只抓了一部分」，下次接着跑。 */
export const REQUEST_BUDGET = 60;
/** 每次请求之间的间隔：洛谷匿名浏览是正常用法，但没必要贴着人家的线跑。 */
const MIN_GAP_MS = 1200;

/**
 * 难度档。名字和配色跟洛谷主页的「难度统计」一致，共 9 档（0-8）。
 * 第 3 档「普及」和第 5 档「提高」是洛谷后加的档位，老资料里没有。
 */
export const LUOGU_LEVELS = {
  0: '暂无评定',
  1: '入门',
  2: '普及−',
  3: '普及',
  4: '普及+/提高−',
  5: '提高',
  6: '提高+/省选−',
  7: '省选/NOI−',
  8: 'NOI/NOI+/CTSC',
};

/** 「普及档」= 名字里带普及的三档，用户说的「先爬普及」就是这个范围。 */
export const LUOGU_POPULAR_LEVELS = [2, 3, 4];

/**
 * 难度档 → 对应的分数段（左闭右开，按 50 分对齐）。
 *
 * 洛谷只给 9 档，一个档内部能差两三百分。如果整档都写成一个分值（比如提高全是 1650），
 * 「每天四档」的梯度就废了——一天里排两道洛谷题会直接跨度为 0，自检里那条
 * 「多题日跨度 ≥ 100」也会报警。所以档内再摊一次：用通过人数当相对难度的代理，
 * 通过得多的排低分、通过得少的排高分（实测同一个档里通过数能差两个数量级）。
 *
 * 档位边界是按各档的公认难度区间取的，和 CF rating 大致对齐：
 * 入门 800 起、普及 1100~1300、提高 1550~1850、省选 2100~2350、NOI 2350 起。
 */
export const LEVEL_BANDS = {
  1: [800, 950],
  2: [900, 1100],
  3: [1100, 1300],
  4: [1300, 1550],
  5: [1550, 1850],
  6: [1850, 2100],
  7: [2100, 2350],
  8: [2350, 2800],
};

/**
 * 把同一档的题按通过人数摊到这一档的分数段里。
 * 传进来的 rows 就是这一档抽到的题（含 accepted），就地写回 rating。
 */
export function assignRatings(rows) {
  const band = LEVEL_BANDS[rows[0]?.level];
  if (!band) return;
  const [lo, hi] = band;
  const sorted = [...rows].sort((a, b) => (b.accepted ?? 0) - (a.accepted ?? 0));
  const last = Math.max(1, sorted.length - 1);
  sorted.forEach((row, index) => {
    // 通过人数多的排在前 → 分低；用位置的比例而不是名次，题量少的时候也不会挤在两端
    const ratio = sorted.length === 1 ? 0.5 : index / last;
    row.rating = Math.max(lo, Math.min(hi, Math.round((lo + ratio * (hi - lo)) / 50) * 50));
  });
}

/**
 * 洛谷标签 → Codeforces 官方标签。
 *
 * 转成 CF 的标签名是因为「八方向画像」和「单个标签占比上限」都按 CF 那 35 个标签统计，
 * 直接塞中文名会让「动态规划 DP」和 CF 的「dp」变成两个标签，占比上限就形同虚设。
 * 没有对应标签的（前缀和、差分、离散化这种实现技巧）保留中文名，
 * knowledge.js 的中文兜底规则能把它们归到方向里。
 */
const TAG_TO_CF = {
  1: 'implementation', // 模拟
  2: 'strings',
  3: 'dp',
  4: 'dfs and similar',
  5: 'math',
  6: 'graphs',
  7: 'greedy',
  8: 'geometry',
  9: 'data structures', // 暴力数据结构
  10: 'math', // 高精度
  11: 'data structures', // 树形数据结构
  12: 'dp', // 递推
  13: 'games',
  41: 'data structures', // 莫队
  42: 'data structures', // 线段树
  43: 'data structures', // 倍增
  44: 'data structures', // 线性数据结构
  45: 'binary search',
  47: 'dsu',
  49: 'divide and conquer', // 点分治
  50: 'data structures', // 平衡树
  51: 'data structures', // 堆
  53: 'data structures', // 树状数组
  54: 'implementation', // 递归
  56: 'data structures', // 单调队列
  67: 'ternary search',
  71: 'matrices',
  72: 'number theory',
  78: 'implementation', // 离散化
  79: 'flows',
  100: 'divide and conquer', // cdq 分治
  101: 'string suffix structures', // 后缀自动机
  110: 'implementation', // 基础算法
  111: 'brute force', // 枚举
  112: 'divide and conquer',
  113: 'sortings',
  122: 'math', // 信息论
  126: 'dfs and similar', // BFS
  127: 'dfs and similar',
  128: 'dfs and similar', // 剪枝
  129: 'dp', // 记忆化搜索
  131: 'dfs and similar', // 迭代加深
  139: 'dp', // 背包 DP
  141: 'dp', // 数位 DP
  144: 'dp', // 区间 DP
  146: 'dp',
  148: 'data structures', // 优先队列
  150: 'dp', // 斜率优化
  152: 'dp', // 树形 DP
  154: 'dp',
  155: 'graphs',
  158: 'graphs',
  159: 'graphs', // 拓扑排序
  160: 'shortest paths',
  166: 'graphs', // 生成树
  173: 'graphs',
  174: 'graphs',
  175: 'graphs', // 连通块
  176: '2-sat',
  179: 'graphs', // 强连通分量
  180: 'graphs', // Tarjan
  181: 'graphs',
  182: 'graphs', // 欧拉回路
  185: 'shortest paths', // 差分约束
  186: 'graphs',
  187: 'graphs', // 二分图
  189: 'graphs',
  198: 'flows', // 最小割
  202: 'binary search', // 分数规划
  204: 'flows',
  208: 'trees',
  211: 'trees', // LCA
  213: 'trees', // 树的直径
  215: 'data structures', // 可并堆
  228: 'trees', // 树链剖分
  229: 'data structures', // LCT
  230: 'trees',
  232: 'data structures', // 树套树
  233: 'data structures', // 可持久化线段树
  234: 'data structures',
  235: 'hashing',
  239: 'number theory',
  241: 'number theory',
  242: 'number theory',
  243: 'number theory',
  249: 'trees', // 虚树
  250: 'chinese remainder theorem',
  251: 'number theory', // 莫比乌斯反演
  252: 'combinatorics',
  253: 'combinatorics',
  254: 'data structures', // 前缀和
  255: 'combinatorics',
  258: 'combinatorics',
  259: 'combinatorics',
  260: 'math', // Fibonacci
  261: 'combinatorics', // Catalan
  262: 'combinatorics', // Stirling
  263: 'dfs and similar', // A*
  266: 'probabilistic',
  270: 'probabilistic',
  271: 'matrices',
  272: 'matrices',
  273: 'matrices',
  274: 'matrices', // 高斯消元
  276: 'number theory', // 逆元
  277: 'math', // 线性基
  283: 'geometry',
  286: 'geometry', // 向量
  287: 'data structures', // 栈
  288: 'data structures', // 队列
  289: 'data structures', // 分块
  290: 'data structures', // ST 表
  291: 'geometry', // 凸包
  292: 'geometry', // 叉积
  293: 'geometry',
  295: 'geometry',
  298: 'geometry', // 扫描线
  299: 'geometry', // 旋转卡壳
  300: 'strings', // 字典树
  301: 'strings', // AC 自动机
  302: 'strings', // KMP
  303: 'string suffix structures', // 后缀数组
  309: 'probabilistic', // 随机化
  313: 'fft',
  314: 'bitmasks',
  316: 'binary search', // 整体二分
  318: 'constructive algorithms', // 构造
  320: 'trees', // 基环树
  322: 'combinatorics', // Lucas
  323: 'dp', // 轮廓线 DP
  324: 'fft',
  326: 'fft',
  327: 'fft',
  329: 'strings', // Manacher
  330: 'data structures', // 差分
  345: 'two pointers',
  350: 'trees', // 圆方树
  353: 'implementation', // 顺序结构
  354: 'implementation',
  355: 'implementation',
  356: 'implementation', // 数组
  357: 'strings',
  358: 'implementation', // 结构体
  359: 'implementation', // 函数与递归
  360: 'data structures', // 链表
  364: 'combinatorics', // Dilworth
  365: 'constructive algorithms', // Ad-hoc
  368: 'trees', // 笛卡尔树
  370: 'games', // Nim
  376: 'constructive algorithms', // 分类讨论
  380: 'meet-in-the-middle',
  385: 'data structures', // 单调栈
  410: 'trees', // Prüfer 序列
  435: 'dp',
  443: 'dp',
  444: 'dp',
  445: 'games', // SG 函数
  446: 'divide and conquer', // 线段树分治
  447: 'data structures', // 离线处理
  448: 'number theory', // 整除分块
  449: 'geometry', // 极角排序
  452: 'number theory', // 大步小步算法 BSGS
  453: 'number theory', // 二次剩余
  454: 'matrices', // 行列式
  461: 'number theory', // 杜教筛
  462: 'number theory', // 欧拉函数
  464: 'dp', // 状压 DP
  465: 'bitmasks', // bitset
  471: 'flows',
  472: 'data structures', // 全局平衡二叉树
  473: 'hashing', // 哈希表
  474: 'strings', // Z 函数
  475: 'number theory', // 线性筛法
  476: 'shortest paths', // Floyd
  477: 'dsu', // 启发式合并
  482: 'geometry',
  483: 'trees', // 树的重心
  504: 'data structures', // STL
  507: 'data structures',
  508: 'dp', // 斜率维护技巧 slope trick
  524: 'greedy', // 反悔贪心
};

export class LuoguError extends Error {
  constructor(message, retryable = false) {
    super(message);
    this.name = 'LuoguError';
    this.retryable = retryable;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let lastCallAt = 0;

async function throttle() {
  const wait = lastCallAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

/** 抓一次页面，带 cookie 挑战的处理和限速。 */
async function loadPage(params) {
  await throttle();
  const query = new URLSearchParams(params).toString();
  const html = await fetchLuoguText(`https://www.luogu.com.cn/problem/list?${query}`);
  const block = html.match(/<script id="lentille-context" type="application\/json">([\s\S]*?)<\/script>/);
  if (!block) throw new LuoguError('洛谷返回的页面里没有题目数据，可能被风控拦了，过一会儿再试');
  let context;
  try {
    context = JSON.parse(block[1]);
  } catch {
    throw new LuoguError('洛谷返回的数据解析失败');
  }
  const problems = context?.data?.problems;
  if (!problems) throw new LuoguError('洛谷返回的数据里没有题目列表');
  return problems;
}

/**
 * 标签表：id → 名字，外加一个「哪些是算法标签」的集合。
 *
 * 洛谷题目的 tags 字段里混了好几类标签：算法（type=2）、比赛来源（NOIP 普及组）、
 * 年份（2005）、评测提示（O2 优化、Special Judge）。只有算法标签能进训练计划，
 * 剩下的会被当成「标签」参与占比统计，把数据弄脏。
 */
export async function fetchTags() {
  await throttle();
  const html = await fetchLuoguText('https://www.luogu.com.cn/_lfe/tags');
  let payload;
  try {
    payload = JSON.parse(html);
  } catch {
    throw new LuoguError('洛谷标签表解析失败');
  }
  const names = new Map();
  const algorithm = new Set();
  for (const tag of payload?.tags ?? []) {
    if (tag?.id == null || !tag?.name) continue;
    names.set(Number(tag.id), String(tag.name));
    if (Number(tag.type) === 2) algorithm.add(Number(tag.id));
  }
  return { names, algorithm };
}

/**
 * 洛谷一个标签 id → 本工具用的标签名。
 * 优先翻成 CF 官方标签（八方向画像、标签占比都按 CF 那套算）；
 * 没有对应关系的算法标签保留中文名，让 knowledgeAxis 的中文规则去归类；
 * 不是算法标签的直接丢掉。
 */
export function luoguTagName(id, tags) {
  const cf = TAG_TO_CF[Number(id)];
  if (cf) return cf;
  if (!tags?.algorithm?.has(Number(id))) return null;
  return tags.names.get(Number(id)) ?? null;
}

/**
 * 抽页清单：先看这一档有多少页，再等距抽 count 页，第一页和最后一页都留一个。
 * 等距抽是为了别把题单塞满十几年前的老题（默认排序下前面都是老题）。
 */
function pickPages(totalPages, count) {
  if (totalPages <= count) return Array.from({ length: totalPages }, (_, i) => i + 1);
  const step = totalPages / count;
  const pages = new Set();
  for (let i = 0; i < count; i += 1) pages.add(Math.min(totalPages, Math.floor(i * step) + 1));
  pages.add(totalPages);
  return [...pages].sort((a, b) => a - b);
}

/**
 * 按难度档抓题库。
 *
 * levels：要抓的难度档，默认普及档（普极−/普及/普及+/提高−）。
 * pagesPerLevel：每档抽几页（一页 50 题）。
 * budget：这次最多发多少个请求，用完就停，剩下的下次跑。
 */
export async function fetchCatalog({
  levels = LUOGU_POPULAR_LEVELS,
  pagesPerLevel = 8,
  budget = REQUEST_BUDGET,
  onProgress,
} = {}) {
  let used = 0;
  const spend = () => {
    if (used >= budget) throw new LuoguError('这次请求数用完了，剩下的下次再抓');
    used += 1;
  };

  onProgress?.('正在读取标签表…');
  spend();
  const tagTable = await fetchTags();

  const rows = [];
  const perLevel = [];
  let failures = 0;
  for (const level of levels) {
    const label = LUOGU_LEVELS[level] ?? `难度 ${level}`;
    // 单档失败不要连坐：一档翻不动就跳过这一档，别的档接着抓。
    // 抓了一大半再报错、把已经拿到的几百道题全丢掉很浪费。
    let first;
    try {
      spend();
      first = await loadPage({ page: 1, type: 'P', difficulty: String(level) });
    } catch (error) {
      failures += 1;
      onProgress?.(`${label}：第 1 页没抓到（${error.message}），跳过这一档`);
      perLevel.push({ level, label, total: 0, pages: 0, taken: 0, failed: 1 });
      continue;
    }
    const total = Number(first.count ?? 0);
    const perPage = Number(first.perPage ?? 50) || 50;
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const pages = pickPages(totalPages, pagesPerLevel);
    onProgress?.(`${label}：共 ${total} 题 / ${totalPages} 页，抽 ${pages.length} 页…`);

    let taken = 0;
    let failed = 0;
    // 这一档抽到的题先攒在一起，出这一档的时候再统一摊分值（见 assignRatings）
    const levelRows = [];
    for (const page of pages) {
      let data = page === 1 ? first : null;
      if (!data) {
        try {
          spend();
          data = await loadPage({ page, type: 'P', difficulty: String(level) });
        } catch (error) {
          failed += 1;
          continue;
        }
      }
      for (const item of data.result ?? []) {
        const pid = String(item?.pid ?? '');
        const difficulty = Number(item?.difficulty);
        if (!pid || !Number.isFinite(difficulty)) continue;
        if (!LEVEL_BANDS[difficulty]) continue;
        const tags = [
          ...new Set(
            (item?.tags ?? []).map((id) => luoguTagName(id, tagTable)).filter(Boolean),
          ),
        ];
        levelRows.push({
          nativeId: pid,
          name: String(item?.name ?? ''),
          level: difficulty,
          rating: LEVEL_BANDS[difficulty][0],
          tags,
          accepted: Number(item?.totalAccepted ?? 0),
        });
        taken += 1;
      }
    }
    assignRatings(levelRows);
    rows.push(...levelRows);
    failures += failed;
    perLevel.push({ level, label, total, pages: pages.length, taken, failed });
  }

  return { rows, perLevel, requests: used, failures };
}
