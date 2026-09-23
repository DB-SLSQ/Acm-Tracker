// 训练计划生成：把「当前 rating → 目标 rating」拆成分阶段的可执行安排。
//
// 说明：下面的题量系数（每涨 100 分约 60 题）是经验启发式，不是官方数据。
// 它的作用是给出一个有节奏的、可调整的起点，而不是精确预测。

import {
  buildKnowledgeProfile,
  buildTagProfile,
  isNoiseTag,
  knowledgeAxis,
  tagWeakness,
} from './knowledge.js';
import { isModelUseful, predict } from './model.js';

const PROBLEMS_PER_100_RATING = 60;
const MAX_STAGES = 6;
const RATING_FLOOR = 800;
const FOCUS_TAG_COUNT = 5;
/**
 * 单个知识点标签在整个题单里的占比上限。
 * 不加限制时，打分靠前的标签会一路霸榜，一份「训练计划」变成同一类题刷十几遍，
 * 练不到别的方向。默认 40%，可以在设置里调低（题目更杂）或调高（更集中在几类题上）。
 */
const DEFAULT_TAG_SHARE = 0.4;
/**
 * 分析时忽略「比当前 rating 低多少分以内」的题。
 * 签到题人人都做，只是恰好带了某个标签，会把分位数整体拖低。
 * 400 这个值是按实测选的：一个 1635 分的账号，排除后各标签的平均估计
 * 从 1725 回到 1850，落在合理区间。可以在设置里调，填 0 表示不排除。
 */
const DEFAULT_FLOOR_GAP = 400;

export function problemKey(contestId, index) {
  return `${contestId}-${index}`;
}

/** 从提交记录推导出：哪些题过了、每题在首次通过前失败了几次、哪些题做过但没过。 */
export function deriveProgress(submissions) {
  const solved = new Map(); // key -> { at, attempts }
  const attempted = new Map(); // key -> 失败次数（仅针对没过的题）

  for (const submission of submissions) {
    const key = problemKey(submission.contestId, submission.index);
    if (submission.verdict === 'OK') {
      if (!solved.has(key)) {
        solved.set(key, { at: submission.createdAt, attempts: attempted.get(key) ?? 0 });
      }
    } else if (!solved.has(key)) {
      attempted.set(key, (attempted.get(key) ?? 0) + 1);
    }
  }

  return { solved, attempted };
}

function roundTo(value, step) {
  return Math.round(value / step) * step;
}

/**
 * 按练习区间给所有相关 tag 排短板。
 * bandTags 里包含该区间题库里出现过的全部 tag，所以你完全没碰过的专题也会被列出来
 * ——这是原来实现漏掉的一类：没做过的东西最该补，但它不在"已做过"的统计里。
 */
export function rankFocusTags({ tagProfile, bandTags, bandLower, bandCenter }) {
  const known = new Map(tagProfile.map((entry) => [entry.tag, entry]));
  return [...bandTags]
    .map((tag) => {
      const entry = known.get(tag) ?? { tag, count: 0 };
      const { score, intensity, kind } = tagWeakness(entry, bandLower, bandCenter);
      return { tag, entry, score, intensity, kind };
    })
    .sort((a, b) => b.score - a.score || a.tag.localeCompare(b.tag));
}

/**
 * 一个候选题的综合得分。
 *
 * 注意第 4 项：老题在「做过的总人数」上占了大便宜（积累了十几年），
 * 而且题目风格和现在的比赛差别不小，所以这里额外给近几年的题加权。
 * 实测不加这项时，推荐列表里 43% 是 2016 年及以前的题。
 */
function scoreCandidate(problem, { band, weakWeights, contestDates, now, solveRate }) {
  const [lo, hi] = band;
  const span = Math.max(1, hi - lo);

  // 1. 命中短板标签的程度（取最强的两个加权，避免标签多的题一律占优）
  const hits = problem.tags
    .map((tag) => weakWeights.get(tag) ?? 0)
    .sort((a, b) => b - a);
  const weakScore = Math.min(2, (hits[0] ?? 0) + (hits[1] ?? 0)) * 45;

  // 2. 题目热度：被大量人做过的题通常质量稳定、套路清晰，更适合训练
  const popularity = (Math.min(problem.solvedCount, 15000) / 15000) * 30;

  // 3. 难度是否合适。两种算法：
  //    没有模型时按「题在这个区间里的相对位置」估；有模型时直接用它算出来的
  //    「你现在做出这道题的概率」，命中 0.55 附近（有点挑战但做得出来）给满分。
  const probability = solveRate?.(problem);
  const fit =
    probability == null
      ? 25 * Math.max(0, 1 - Math.abs((problem.rating - lo) / span - 0.65) / 0.65)
      : 25 * Math.exp(-(((probability - 0.55) / 0.28) ** 2));

  // 4. 年份偏好：越新的题越靠前。新题约 25 分，10 年前的降到 9 分，15 年以上归 0
  const startTime = contestDates?.get(problem.contestId);
  const yearsOld = startTime ? (now - startTime) / (365.25 * 24 * 3600) : null;
  const recency = yearsOld == null ? 12 : Math.max(0, 25 - yearsOld * 1.6);

  return weakScore + popularity + fit + recency;
}

/**
 * 按知识方向分配题量：各方向差不多，弱项稍微多一点。
 *
 * 只用「单个标签不超过 X%」这种上限，只能防住霸榜，分配本身还是偏的
 * （实测会跑出 40%/25%/15% 这种）。改成配额制以后，50 题 6 个方向会分到
 * 11/9/8/8/7/7 这种分布：弱项多一两道，其余均摊。
 *
 * 权重用 1 + 1.2 × 强度，再按最大余数法取整，每个方向至少 1 题。
 */
export function allocateQuota(entries, count) {
  const quotas = new Map();
  if (!entries.length || count <= 0) return quotas;

  // 题量比方向还少：谁弱谁上，一个方向最多一题
  if (count <= entries.length) {
    [...entries]
      .sort((a, b) => (b.intensity ?? 0) - (a.intensity ?? 0))
      .slice(0, count)
      .forEach((entry) => quotas.set(entry.key, 1));
    return quotas;
  }

  // 弱项最多比平均多拿 40%（强度 1 → 权重 1.4，强度 0 → 1.0）：
  // 太少看不出差别，太多又变成押注单一方向了。
  const weights = entries.map((entry) => 1 + 0.4 * Math.max(0, Math.min(1, entry.intensity ?? 0)));
  const total = weights.reduce((sum, value) => sum + value, 0);
  const exact = weights.map((weight) => (weight / total) * count);
  const quota = exact.map((value, index) => Math.max(1, Math.floor(value)));
  let used = quota.reduce((sum, value) => sum + value, 0);

  // 多的先补小数部分大的（也就是更弱的方向）
  const remainders = exact
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac);
  for (let i = 0; used < count; i += 1) {
    quota[remainders[i % remainders.length].index] += 1;
    used += 1;
  }

  // 少见的相反情况：Math.max(1, …) 把总数抬高了，从最不弱的方向扣回来
  const weakestFirst = [...entries.keys()].sort(
    (a, b) => (entries[a].intensity ?? 0) - (entries[b].intensity ?? 0),
  );
  for (let i = 0; used > count && i < count * 4; i += 1) {
    const index = weakestFirst[i % weakestFirst.length];
    if (quota[index] > 1) {
      quota[index] -= 1;
      used -= 1;
    }
  }

  entries.forEach((entry, index) => quotas.set(entry.key, quota[index]));
  return quotas;
}

/**
 * 在候选集中挑题。
 *
 * 两步：先按知识方向分名额（弱项多一点，其余均摊），再在每个方向内部按
 * 综合得分挑题，同时限制单个标签的占比，避免某个方向内部又被同一个 tag 刷屏。
 * exclude 里是已经推荐给其他阶段的题，保证整个计划不重复。
 */
function pickProblems(
  candidates,
  count,
  { band, weakWeights, exclude, contestDates, now, tagShare, solveRate, axisIntensity, axesOf, preferred },
) {
  const share = Number.isFinite(tagShare) ? Math.min(0.9, Math.max(0.1, tagShare)) : DEFAULT_TAG_SHARE;
  // 题量少的时候（比如一周只有 3 题）至少留 2 道，否则上限会压到 1 题，等于没法选题
  const capFor = (factor = 1) => Math.max(2, Math.ceil(count * share * factor));
  let maxPerTag = capFor();
  const tagCount = new Map();
  const axisCount = new Map();
  const picked = [];
  const pickedKeys = new Set();

  const ranked = candidates
    .filter((problem) => !exclude.has(problemKey(problem.contestId, problem.index)))
    .map((problem) => ({
      problem,
      score: scoreCandidate(problem, { band, weakWeights, contestDates, now, solveRate }),
    }))
    .sort((a, b) => {
      // 已经在计划里的题排在最前面，并且按原顺序——这样刷新页面、重新打开程序，
      // 计划不会突然换个样子，日程也不会跟着跳。
      const pinA = preferred?.get(problemKey(a.problem.contestId, a.problem.index));
      const pinB = preferred?.get(problemKey(b.problem.contestId, b.problem.index));
      if (pinA !== undefined && pinB !== undefined) return pinA - pinB;
      if (pinA !== undefined) return -1;
      if (pinB !== undefined) return 1;
      return b.score - a.score;
    });

  const take = (problem) => {
    picked.push(problem);
    pickedKeys.add(problemKey(problem.contestId, problem.index));
    for (const tag of problem.tags) tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1);
    const axis = axisOfProblem(problem);
    axisCount.set(axis, (axisCount.get(axis) ?? 0) + 1);
  };

  // 每道题归到「它命中的方向里最强的那一个」，这样配额不会重复计数
  const bucketOf = new Map();
  const axisOfProblem = (problem) => {
    const key = problemKey(problem.contestId, problem.index);
    if (bucketOf.has(key)) return bucketOf.get(key);
    const problemAxes = axesOf(problem);
    let best = null;
    let bestIntensity = -1;
    for (const axis of problemAxes) {
      const intensity = axisIntensity?.get(axis) ?? 0;
      if (intensity > bestIntensity) {
        bestIntensity = intensity;
        best = axis;
      }
    }
    const value = best ?? '__other__';
    bucketOf.set(key, value);
    return value;
  };

  const buckets = new Map();
  for (const row of ranked) {
    const axis = axisOfProblem(row.problem);
    const list = buckets.get(axis) ?? [];
    list.push(row);
    buckets.set(axis, list);
  }

  const quota = allocateQuota(
    [...buckets.entries()]
      .filter(([axis]) => axis !== '__other__')
      .map(([axis, list]) => ({ key: axis, intensity: axisIntensity?.get(axis) ?? 0, size: list.length })),
    count,
  );

  // 先把「上一份计划里已经有」的题原样收下，再按配额挑新的补满。
  // 钉住的题不占配额：它们本来就该在这一阶段里，现在做完了也要留在原位显示成已完成。
  const pinnedPerAxis = new Map();
  if (preferred?.size) {
    const pinned = ranked
      .filter((row) => preferred.has(problemKey(row.problem.contestId, row.problem.index)))
      .sort(
        (a, b) =>
          preferred.get(problemKey(a.problem.contestId, a.problem.index)) -
          preferred.get(problemKey(b.problem.contestId, b.problem.index)),
      );
    for (const row of pinned) {
      if (picked.length >= count) break;
      take(row.problem);
      const axis = axisOfProblem(row.problem);
      pinnedPerAxis.set(axis, (pinnedPerAxis.get(axis) ?? 0) + 1);
    }
  }

  // 第一轮：每个方向按名额挑，方向内部仍然守标签上限
  for (const [axis, list] of buckets) {
    if (picked.length >= count) break;
    // 钉住的题已经占掉了这个方向的名额，剩下的才按配额挑
    const wanted =
      axis === '__other__' ? 0 : Math.max(0, (quota.get(axis) ?? 0) - (pinnedPerAxis.get(axis) ?? 0));
    let taken = 0;
    for (const { problem } of list) {
      if (taken >= wanted) break;
      if (pickedKeys.has(problemKey(problem.contestId, problem.index))) continue;
      if (problem.tags.some((tag) => (tagCount.get(tag) ?? 0) >= maxPerTag)) continue;
      take(problem);
      taken += 1;
    }
    // 名额还没够：说明这个方向的题大多带着已经顶格的标签（比如字符串题常常
    // 也带 implementation）。这时候优先保证方向均衡——毕竟「每个方向都能练到」
    // 比「某个标签刚好卡在 40%」更重要；全局占比仍然由设置里的上限约束。
    if (taken < wanted) {
      for (const { problem } of list) {
        if (taken >= wanted) break;
        if (pickedKeys.has(problemKey(problem.contestId, problem.index))) continue;
        take(problem);
        taken += 1;
      }
    }
  }

  // 取某个方向里下一个还能要的题
  const nextInList = (list, cap) => {
    for (const { problem } of list) {
      if (pickedKeys.has(problemKey(problem.contestId, problem.index))) continue;
      if (problem.tags.some((tag) => (tagCount.get(tag) ?? 0) >= cap)) continue;
      return problem;
    }
    return null;
  };

  // 第二轮：有方向没凑够名额（题不够、或被标签上限卡住），把缺的名额补上。
  // 关键点：这里是**轮流**给每个方向补一道，而不是按总分从高到低堆——
  // 后者会让候选最多的那几个方向（greedy/implementation/math）一口气吃满，
  // 实测能把贪心顶到 45%，等于把配额制废掉了。
  const fillByRotation = (cap) => {
    let progressed = true;
    while (picked.length < count && progressed) {
      progressed = false;
      for (const [axis, list] of buckets) {
        if (picked.length >= count) break;
        if (axis === '__other__') continue;
        const next = nextInList(list, cap);
        if (!next) continue;
        take(next);
        progressed = true;
      }
    }
  };

  fillByRotation(maxPerTag);

  // 第三轮：还是凑不满（题库里确实没别的了），才逐级放宽标签上限
  for (const factor of [1.25, 1.6, 2.2]) {
    if (picked.length >= count) break;
    maxPerTag = capFor(factor);
    fillByRotation(maxPerTag);
  }

  // 最后的兜底：连放宽上限都不够，那就按分数把题量凑齐
  if (picked.length < count) {
    for (const { problem } of ranked) {
      if (picked.length >= count) break;
      if (pickedKeys.has(problemKey(problem.contestId, problem.index))) continue;
      take(problem);
    }
  }

  // 最后的兜底：题库里确实没有别的题了，那就先把题量凑够
  if (picked.length < count) {
    for (const { problem } of ranked) {
      if (picked.length >= count) break;
      if (pickedKeys.has(problemKey(problem.contestId, problem.index))) continue;
      take(problem);
    }
  }

  const axisPlan = [...axisCount]
    .filter(([axis]) => axis !== '__other__')
    .map(([axis, n]) => ({ axis, count: n }))
    .sort((a, b) => b.count - a.count || a.axis.localeCompare(b.axis));

  return {
    picked: picked.sort((a, b) => a.rating - b.rating || a.contestId - b.contestId),
    axisPlan,
  };
}

export function buildPlan({
  user,
  solved,
  attempted,
  problems,
  target,
  weekly,
  floorGap,
  tagShare,
  model,
  contestDates,
  blocked,
  // 上一份计划里的题号（key -> 顺序）。有它就不会每次重算都换一批题：
  // 做过的题留在原位显示成已完成，只有被屏蔽或题库里没有了的才补新题。
  preferred = null,
  // 练习区间整体上下挪多少分（难度自适应算出来的，见 server.js 的 evaluateBandAdjustment）
  bandShift = 0,
  now = Date.now() / 1000,
}) {
  const rated = problems.filter(
    (problem) =>
      problem.type === 'PROGRAMMING' && typeof problem.rating === 'number' && problem.rating >= RATING_FLOOR,
  );
  // 带上通过时间：水平评估里旧题会按时间衰减打折
  const solvedProblems = rated
    .filter((problem) => solved.has(problemKey(problem.contestId, problem.index)))
    .map((problem) => ({
      ...problem,
      solvedAt: solved.get(problemKey(problem.contestId, problem.index)).at,
    }));

  const current = user.rating && user.rating > 0 ? user.rating : RATING_FLOOR;

  // 难度下限：低于它的题不参与水平评估（但仍然算「已做过」，不会被推荐）
  const floorDistance = Number.isFinite(floorGap) && floorGap >= 0 ? floorGap : DEFAULT_FLOOR_GAP;
  // 填 0 表示不排除。注意不能直接写 current - 0 再取整，那会变成「排除到当前分数」。
  const analysisFloor =
    floorDistance === 0
      ? RATING_FLOOR
      : Math.max(RATING_FLOOR, roundTo(current - floorDistance, 100));
  const excludedCount = solvedProblems.filter((problem) => problem.rating < analysisFloor).length;

  const gap = target - current;
  const stages = gap <= 0 ? 1 : Math.min(MAX_STAGES, Math.max(1, Math.ceil(gap / 200)));
  const totalNeeded = Math.max(60, Math.round((Math.max(gap, 0) / 100) * PROBLEMS_PER_100_RATING));
  const perWeek = Math.max(1, weekly);
  const weeks = Math.max(1, Math.ceil(totalNeeded / perWeek));

  const tagProfile = buildTagProfile(solvedProblems, { floor: analysisFloor });
  const axes = buildKnowledgeProfile(solvedProblems, tagProfile, { floor: analysisFloor });

  // 推题模型（如果训练过、而且确实比基线好）：用它算「你现在做出这道题的概率」
  const modelActive = Boolean(model && isModelUseful(model));
  const axesCache = new Map();
  // 一道题命中的知识方向（去重），配额分配和模型都用它
  const axesOf = (problem) => {
    const cacheKey = `${problem.contestId}-${problem.index}`;
    let problemAxes = axesCache.get(cacheKey);
    if (!problemAxes) {
      problemAxes = [
        ...new Set(
          problem.tags.filter((tag) => !isNoiseTag(tag)).map(knowledgeAxis).filter(Boolean),
        ),
      ];
      axesCache.set(cacheKey, problemAxes);
    }
    return problemAxes;
  };
  const solveRate = modelActive
    ? (problem) => {
        const startTime = contestDates?.get(problem.contestId);
        return predict(model.weights, {
          rating: current,
          problemRating: problem.rating,
          axes: axesOf(problem),
          yearsOld: startTime ? (now - startTime) / (365.25 * 24 * 3600) : 5,
          indexPos: problem.index.charCodeAt(0) - 64,
          fieldSize: false,
        });
      }
    : null;
  const basePerStage = Math.floor(totalNeeded / stages);
  const remainder = totalNeeded - basePerStage * stages;
  const assigned = new Set(); // 全计划去重：同一道题不会出现在两个阶段

  const stageList = [];
  for (let index = 1; index <= stages; index += 1) {
    const stageTarget = roundTo(current + (Math.max(gap, 0) * index) / stages, 50);
    // bandShift：难度自适应按最近几轮的表现整体上/下挪区间
    const lo = Math.max(RATING_FLOOR, roundTo(stageTarget - 250 + bandShift, 50));
    const hi = roundTo(stageTarget + 150 + bandShift, 50);
    const band = [lo, hi];
    const bandCenter = stageTarget;

    const inBand = rated.filter(
      (problem) => problem.rating >= lo && problem.rating <= hi,
    );

    const candidates = inBand.filter((problem) => {
      const key = problemKey(problem.contestId, problem.index);
      // 被手动屏蔽的题永远不出现
      if (blocked?.has(key)) return false;
      // 做过的题不再推荐——除非它已经在当前这份计划里：那种情况下要留着，
      // 界面靠它显示「这道我做过、已完成」
      return !solved.has(key) || Boolean(preferred?.has(key));
    });

    // 该阶段重点补的短板标签
    const bandTags = new Set();
    for (const problem of inBand) {
      for (const tag of problem.tags) if (!isNoiseTag(tag)) bandTags.add(tag);
    }
    const ranked = rankFocusTags({ tagProfile, bandTags, bandLower: lo, bandCenter });
    const focus = ranked.slice(0, FOCUS_TAG_COUNT);
    const weakWeights = new Map();
    // 打分的短板权重放宽到前 12 个 tag：配额制下每个方向都会被挑到，
    // 如果只认前 5 个 tag，其他方向内部就退化成纯按热度挑题了。
    for (const row of ranked.slice(0, 12)) weakWeights.set(row.tag, row.intensity);
    const focusTags = focus.map((row) => ({
      tag: row.tag,
      kind: row.kind,
      weakness: Math.round(row.intensity * 100),
    }));

    // 8 大方向在这个区间里的薄弱程度，用来分配题量（配额制）
    const axisIntensity = new Map();
    for (const axis of axes) {
      const entry = axis.count
        ? { representative: axis.representative, count: axis.count, confidence: axis.confidence }
        : null;
      axisIntensity.set(axis.axis, tagWeakness(entry, lo, stageTarget).intensity);
    }

    const count = basePerStage + (index <= remainder ? 1 : 0);
    const { picked, axisPlan } = pickProblems(candidates, count, {
      band,
      weakWeights,
      exclude: assigned,
      contestDates,
      now,
      tagShare,
      solveRate,
      axisIntensity,
      axesOf,
      preferred,
    });
    for (const problem of picked) assigned.add(problemKey(problem.contestId, problem.index));

    const review = inBand
      .filter((problem) => attempted.has(problemKey(problem.contestId, problem.index)))
      .filter((problem) => !assigned.has(problemKey(problem.contestId, problem.index)))
      .filter((problem) => !blocked?.has(problemKey(problem.contestId, problem.index)))
      .sort((a, b) => a.rating - b.rating)
      .slice(0, 5)
      .map((problem) => ({
        ...toClientProblem(problem),
        attempts: attempted.get(problemKey(problem.contestId, problem.index)),
      }));

    for (const problem of review) assigned.add(problemKey(problem.contestId, problem.index));

    stageList.push({
      index,
      label: `第 ${index} 阶段`,
      targetRating: stageTarget,
      band,
      count,
      weeks: Math.max(1, Math.round((count / totalNeeded) * weeks)),
      focusTags,
      // 各方向实际分到多少题，界面会显示这一行，让「均衡」看得见
      axisPlan,
      supply: inBand.length,
      unsolvedSupply: candidates.length,
      problems: picked.map(toClientProblem),
      review,
    });
  }

  // 面向目标区间的弱项清单：不只看"做过多少"，更看"做到过多难"
  const targetLower = Math.max(RATING_FLOOR, target - 250);
  const targetTags = new Set();
  for (const problem of rated) {
    if (problem.rating < targetLower || problem.rating > target + 150) continue;
    for (const tag of problem.tags) if (!isNoiseTag(tag)) targetTags.add(tag);
  }
  const weakTagReport = rankFocusTags({
    tagProfile,
    bandTags: targetTags,
    bandLower: targetLower,
    bandCenter: target,
  })
    .slice(0, 12)
    .map(({ tag, entry, intensity, kind }) => ({
      tag,
      axis: entry.axis ?? null,
      kind,
      solvedCount: entry.count ?? 0,
      representative: entry.representative ?? null,
      maxRating: entry.maxRating ?? null,
      avgRating: entry.avgRating ?? null,
      confidence: Math.round((entry.confidence ?? 0) * 100),
      weakness: Math.round(intensity * 100),
    }));

  return {
    current,
    target,
    gap,
    stages,
    totalNeeded,
    weekly: perWeek,
    weeks,
    solvedCount: solved.size,
    ratedSolvedCount: solvedProblems.length,
    ratedProblemCount: rated.length,
    axes,
    analysisFloor,
    excludedFromAnalysis: excludedCount,
    weakTags: weakTagReport,
    model: modelActive
      ? {
          active: true,
          auc: model.metrics?.auc ?? null,
          baselineAuc: model.baseline?.auc ?? null,
          samples: model.samples ?? null,
          contests: model.contests ?? null,
          trainedAt: model.trainedAt ?? null,
        }
      : { active: false, trained: Boolean(model), auc: model?.metrics?.auc ?? null },
    stageList,
    notes: [
      `题量估算采用经验系数：每提升 100 分约 ${PROBLEMS_PER_100_RATING} 题，实际情况因人而异。`,
      '每个阶段的练习区间是「目标分 -250 ~ +150」，这是公认效率较高的区间：既能巩固，也有适度挑战。',
      modelActive
        ? `难度是否合适，用的是从 ${model.samples ?? '数万'} 条真实比赛记录训练出来的模型：它估算你做出每道题的概率，优先挑「有点挑战但做得出来」的题（留出集 AUC ${(
            model.metrics?.auc ?? 0
          ).toFixed(3)}，比只看难度差的基线高 ${((model.metrics?.auc ?? 0) - (model.baseline?.auc ?? 0)).toFixed(
            3,
          )}）。`
        : model
          ? '本地训练出来的模型在留出集上没能明显超过「只看难度差」的基线，所以难度评估仍然用原来的规则，避免拿噪声当改进。'
          : '难度评估用的是内置规则（相对练习区间的难度位置）。累积过比赛数据后可以训练模型来替代它，见 README 的「训练推荐模型」。',
      `推荐列表会优先补你目前最薄弱的专题，同时限制单个标签的占比不超过 ${Math.round(
        (Number.isFinite(tagShare) ? Math.min(0.9, Math.max(0.1, tagShare)) : DEFAULT_TAG_SHARE) * 100,
      )}%，避免一份计划变成同一类题反复刷。这个上限可以在设置里调整。`,
      '题量按知识方向分配：八个方向差不多，弱项多分一两道，避免某个方向整份计划都练不到。阶段标题下面能看到各方向实际分到多少题。想在题单里藏掉标签、自己判断题目类型，勾选「隐藏标签」即可。',
      excludedCount > 0
        ? `评估水平时忽略了 ${excludedCount} 道低于 ${analysisFloor} 分的题——签到题人人都会做，只是恰好带了这个标签，算进来会把分位数整体拖低。可以在设置里调整这个下限。`
        : '评估水平时没有排除任何题目（当前设置的下限低于你做过的最简单题目）。',
    ],
  };
}

export function toClientProblem(problem) {
  return {
    contestId: problem.contestId,
    index: problem.index,
    name: problem.name,
    rating: problem.rating,
    tags: problem.tags,
    solvedCount: problem.solvedCount,
    url: problemUrl(problem.contestId, problem.index),
  };
}

/** gym 比赛的题目路径和普通题库不一样，这里统一处理。 */
export function problemUrl(contestId, index) {
  return contestId >= 100000
    ? `https://codeforces.com/gym/${contestId}/problem/${index}`
    : `https://codeforces.com/problemset/problem/${contestId}/${index}`;
}