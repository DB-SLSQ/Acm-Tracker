// 知识点建模。
//
// 设计参考了 OJ_Insight（Whalica，MIT）的知识轴思路：把各个平台五花八门的原始
// tag 归成 8 个大方向，并且用「加权分位数 + 样本置信度」来衡量一个专题的真实水平，
// 而不是简单取最大值——否则偶尔蹭过一道难题就会把弱项伪装成强项。

export const KNOWLEDGE_AXES = [
  '基础与模拟',
  '数据结构',
  '图论与树',
  '动态规划',
  '数学',
  '字符串',
  '搜索与构造',
  '贪心与思维',
];

// Codeforces 目前全部 35 个官方 tag，每个归到唯一的主方向，保证统计口径不重叠
const TAG_TO_AXIS = new Map(
  Object.entries({
    implementation: '基础与模拟',
    'brute force': '基础与模拟',
    sortings: '基础与模拟',
    'expression parsing': '基础与模拟',
    schedules: '基础与模拟',

    'data structures': '数据结构',
    dsu: '数据结构',
    hashing: '数据结构',
    'divide and conquer': '数据结构',

    graphs: '图论与树',
    trees: '图论与树',
    'dfs and similar': '图论与树',
    'shortest paths': '图论与树',
    flows: '图论与树',
    '2-sat': '图论与树',

    dp: '动态规划',
    'meet-in-the-middle': '动态规划',

    math: '数学',
    'number theory': '数学',
    combinatorics: '数学',
    geometry: '数学',
    probabilistic: '数学',
    matrices: '数学',
    'chinese remainder theorem': '数学',
    fft: '数学',
    games: '数学',
    'ternary search': '数学',

    strings: '字符串',
    'string suffix structures': '字符串',

    'binary search': '搜索与构造',
    'constructive algorithms': '搜索与构造',
    interactive: '搜索与构造',
    communication: '搜索与构造',

    greedy: '贪心与思维',
    'two pointers': '贪心与思维',
    bitmasks: '贪心与思维',
  }),
);

/**
 * Codeforces 会给需要特判的题打上 `*special` 这种星号标记，
 * 它不是算法专题，参与分析只会污染弱项列表，这里统一过滤。
 */
export function isNoiseTag(tag) {
  return !tag || String(tag).startsWith('*');
}

/** 原始 tag → 知识大方向。未知 tag 用关键字兜底，返回 null 表示无法归类。 */
export function knowledgeAxis(rawTag) {
  const tag = String(rawTag ?? '').trim().toLowerCase();
  if (!tag) return null;
  const exact = TAG_TO_AXIS.get(tag);
  if (exact) return exact;

  const rules = [
    // 中文部分是给洛谷标签兜底的：洛谷有 262 个算法标签，lib/luogu.js 里把常见的
    // 转成了 CF 官方标签，剩下没对应关系的（差分、前缀和、离线处理这类）走这里归类。
    // 数据结构的规则要排在「图论与树」前面：不然「线段树」会先被「树」这个字抓走
    [
      /data structure|segment|fenwick|heap|stack|queue|数据结构|线段树|树状数组|并查集|平衡树|堆|栈|队列|分块|莫队|树链剖分|离散化|前缀和|差分|倍增|链表|bitset|STL|单调/,
      '数据结构',
    ],
    [/graph|tree|path|flow|dsu|连通|图|树|最短路|生成树|拓扑|强连通|网络流|二分图|仙人掌/, '图论与树'],
    [/dp|dynamic programming|动态规划|递推|背包|状压/, '动态规划'],
    [/string|trie|字符串|回文|后缀|自动机|KMP/, '字符串'],
    [/search|binary|construct|构造|搜索|二分|三分|剪枝|迭代加深|启发式|分类讨论|Ad-hoc|随机化|模拟退火|爬山/, '搜索与构造'],
    [/greedy|two pointer|贪心|双指针|博弈|Nim|SG/, '贪心与思维'],
    [/math|number|combin|geometry|probab|数学|几何|数论|组合|期望|概率|矩阵|线性|多项式|整除|素数|逆元|信息论/, '数学'],
    [/implement|simulat|basic|模拟|基础|高精度|递归|排序|循环|数组|结构体|函数|语言入门/, '基础与模拟'],
  ];
  for (const [pattern, axis] of rules) if (pattern.test(tag)) return axis;
  return null;
}

/** rating → 0~100 的难度刻度，方便不同量级放一起比较。 */
export function ratingToDifficulty(rating) {
  if (rating == null) return null;
  return Math.max(5, Math.min(95, 20 + 0.05 * (rating - 800)));
}

/** 加权分位数：比最大值稳健，不会被一两道超纲题带偏。 */
export function weightedQuantile(items, quantile = 0.75) {
  const sorted = items.filter((item) => item.weight > 0).sort((a, b) => a.value - b.value);
  if (!sorted.length) return null;
  const total = sorted.reduce((sum, item) => sum + item.weight, 0);
  const target = total * quantile;
  let seen = 0;
  for (const item of sorted) {
    seen += item.weight;
    if (seen >= target) return item.value;
  }
  return sorted[sorted.length - 1].value;
}

/** 样本越少，结论越不可信：置信度用于给弱项分数打折。 */
export function confidenceOf(count, prior = 4) {
  return count / (count + prior);
}

/**
 * 时间衰减权重：越久以前做出来的题，越不能代表你现在的水平。
 * 半衰期默认 2 年——两年前做出来的题，权重只有一半。
 * 技能会退化，题目难度标准也在变，所以旧记录要打折。
 */
export function recencyWeight(solvedAtSeconds, nowSeconds, halfLifeYears = 2) {
  if (!solvedAtSeconds) return 1;
  const years = Math.max(0, (nowSeconds - solvedAtSeconds) / (365.25 * 24 * 3600));
  return Math.pow(0.5, years / halfLifeYears);
}

/**
 * 每个原始 tag 的水平画像（用于挑题和弱项详情）。
 *
 * floor 是难度下限：低于它的题不计入统计。
 * 这一条很关键——签到题（人人都会做、只是恰好带了这个标签）会把分位数整体拖低。
 * 实测一个 1635 分的账号，greedy 标签做过 204 道，75 分位是 1600，
 * 排除 1400 以下之后是 1800。不排除的话，强项会被误判成弱项。
 */
export function buildTagProfile(
  solvedProblems,
  { floor = 0, now = Date.now() / 1000, halfLifeYears = 2 } = {},
) {
  const itemsByTag = new Map();

  for (const problem of solvedProblems) {
    if (problem.rating == null || problem.rating < floor) continue;
    const weight = recencyWeight(problem.solvedAt, now, halfLifeYears);
    for (const tag of problem.tags) {
      if (isNoiseTag(tag)) continue;
      const list = itemsByTag.get(tag) ?? [];
      list.push({ value: problem.rating, weight });
      itemsByTag.set(tag, list);
    }
  }

  const profile = [];
  for (const [tag, items] of itemsByTag) {
    const ratings = items.map((item) => item.value).sort((a, b) => a - b);
    profile.push({
      tag,
      axis: knowledgeAxis(tag),
      count: ratings.length,
      representative: weightedQuantile(items, 0.75),
      median: weightedQuantile(items, 0.5),
      maxRating: ratings[ratings.length - 1],
      avgRating: Math.round(ratings.reduce((sum, value) => sum + value, 0) / ratings.length),
      confidence: confidenceOf(ratings.length),
    });
  }
  return profile;
}

/**
 * 8 大方向的整体画像。
 * 一道题同时属于多个大方向时按 1/n 计权，避免多标签题把某个方向的证据灌满。
 */
export function buildKnowledgeProfile(
  solvedProblems,
  tagProfile,
  { floor = 0, now = Date.now() / 1000, halfLifeYears = 2 } = {},
) {
  const byAxis = new Map();
  let allRatings = [];

  for (const problem of solvedProblems) {
    if (problem.rating == null || problem.rating < floor) continue;
    const axes = new Set(
      problem.tags.filter((tag) => !isNoiseTag(tag)).map(knowledgeAxis).filter(Boolean),
    );
    if (!axes.size) continue;
    allRatings.push(problem.rating);
    const weight = recencyWeight(problem.solvedAt, now, halfLifeYears);
    for (const axis of axes) {
      const items = byAxis.get(axis) ?? [];
      items.push({ value: problem.rating, weight: weight / axes.size });
      byAxis.set(axis, items);
    }
  }

  // 你自己的整体难度基准，用来判断某个方向是"真的弱"还是"本来就这样"
  const baseline = weightedQuantile(
    (allRatings.length ? allRatings : [0]).map((value) => ({ value, weight: 1 })),
    0.75,
  );

  const fromTags = new Map();
  for (const entry of tagProfile) {
    if (!entry.axis) continue;
    const list = fromTags.get(entry.axis) ?? [];
    list.push(entry);
    fromTags.set(entry.axis, list);
  }

  return KNOWLEDGE_AXES.map((axis) => {
    const items = byAxis.get(axis) ?? [];
    if (!items.length) {
      return {
        axis,
        count: 0,
        representative: null,
        level: null,
        gapVsSelf: null,
        confidence: 0,
        topTags: [],
      };
    }
    const representative = weightedQuantile(items, 0.75);
    const effective = Math.min(40, items.reduce((sum, item) => sum + item.weight, 0));
    return {
      axis,
      count: Math.round(items.reduce((sum, item) => sum + 1, 0)),
      representative,
      level: ratingToDifficulty(representative),
      gapVsSelf: representative - baseline,
      confidence: confidenceOf(effective),
      topTags: (fromTags.get(axis) ?? [])
        .sort((a, b) => b.count - a.count)
        .slice(0, 4)
        .map((entry) => entry.tag),
    };
  }).sort((a, b) => (a.count === 0 ? 1 : 0) - (b.count === 0 ? 1 : 0) || b.count - a.count);
}

/**
 * 一个 tag 相对某个练习区间的薄弱程度。
 *
 * 返回两个东西：
 *   score     —— 用于排序。完全没碰过的专题排在前面（盲区优先补）。
 *   intensity —— 0~1 的可比强度，用于挑题时加权，避免排序分数差几十倍把第二梯队压没。
 *
 * intensity 的口径很直白：你的 75 分位水平如果还在区间下沿以下，就是 1（够不着）；
 * 已经到区间中心，就是 0（这个方向不拖后腿）。中间线性过渡，再按样本量打折。
 */
export function tagWeakness(entry, bandLower, bandCenter) {
  if (!entry || entry.count === 0) {
    return { score: bandCenter * 0.5, intensity: 1, kind: 'untouched' };
  }
  const deficit = Math.max(0, bandLower - entry.representative);
  const soft = Math.max(0, bandCenter - entry.representative) * 0.4;
  const damping = 0.5 + 0.5 * entry.confidence;
  const span = Math.max(1, bandCenter - bandLower);
  const raw = (bandCenter - entry.representative) / span;
  return {
    score: (deficit + soft) * damping,
    intensity: Math.max(0, Math.min(1, raw)) * damping,
    kind: deficit > 0 ? 'weak' : soft > 0 ? 'slight' : 'strong',
  };
}
