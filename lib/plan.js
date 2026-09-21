// 训练计划生成：把「当前 rating → 目标 rating」拆成分阶段的可执行安排。
//
// 说明：下面的题量系数（每涨 100 分约 60 题）是经验启发式，不是官方数据。
// 它的作用是给出一个有节奏的、可调整的起点，而不是精确预测。

import {
  buildKnowledgeProfile,
  buildTagProfile,
  isNoiseTag,
  tagWeakness,
} from './knowledge.js';

const PROBLEMS_PER_100_RATING = 60;
const MAX_STAGES = 6;
const RATING_FLOOR = 800;
const FOCUS_TAG_COUNT = 5;
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
function scoreCandidate(problem, { band, weakWeights, contestDates, now }) {
  const [lo, hi] = band;
  const span = Math.max(1, hi - lo);

  // 1. 命中短板标签的程度（取最强的两个加权，避免标签多的题一律占优）
  const hits = problem.tags
    .map((tag) => weakWeights.get(tag) ?? 0)
    .sort((a, b) => b - a);
  const weakScore = Math.min(2, (hits[0] ?? 0) + (hits[1] ?? 0)) * 45;

  // 2. 题目热度：被大量人做过的题通常质量稳定、套路清晰，更适合训练
  const popularity = (Math.min(problem.solvedCount, 15000) / 15000) * 30;

  // 3. 难度位置：略高于区间中段最有利于进步，太简单和太难都低效
  const position = (problem.rating - lo) / span;
  const fit = 25 * Math.max(0, 1 - Math.abs(position - 0.65) / 0.65);

  // 4. 年份偏好：越新的题越靠前。新题约 25 分，10 年前的降到 9 分，15 年以上归 0
  const startTime = contestDates?.get(problem.contestId);
  const yearsOld = startTime ? (now - startTime) / (365.25 * 24 * 3600) : null;
  const recency = yearsOld == null ? 12 : Math.max(0, 25 - yearsOld * 1.6);

  return weakScore + popularity + fit + recency;
}

/**
 * 在候选集中挑题，并限制单个标签的占比，避免整份计划变成同一个专题。
 * exclude 里是已经推荐给其他阶段的题，保证整个计划不重复。
 */
function pickProblems(candidates, count, { band, weakWeights, exclude, contestDates, now }) {
  const maxPerTag = Math.max(2, Math.ceil(count * 0.35));
  const tagCount = new Map();
  const picked = [];
  const pickedKeys = new Set();

  const ranked = candidates
    .filter((problem) => !exclude.has(problemKey(problem.contestId, problem.index)))
    .map((problem) => ({
      problem,
      score: scoreCandidate(problem, { band, weakWeights, contestDates, now }),
    }))
    .sort((a, b) => b.score - a.score);

  const take = (problem) => {
    picked.push(problem);
    pickedKeys.add(problemKey(problem.contestId, problem.index));
    for (const tag of problem.tags) tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1);
  };

  // 第一轮：每个标签的占比上限从第一题起就严格生效，这是专题均衡的关键
  for (const { problem } of ranked) {
    if (picked.length >= count) break;
    if (problem.tags.some((tag) => (tagCount.get(tag) ?? 0) >= maxPerTag)) continue;
    take(problem);
  }

  // 第二轮：候选不够时放宽标签限制，保证计划一定能凑满题量
  if (picked.length < count) {
    for (const { problem } of ranked) {
      if (picked.length >= count) break;
      if (pickedKeys.has(problemKey(problem.contestId, problem.index))) continue;
      take(problem);
    }
  }

  return picked.sort((a, b) => a.rating - b.rating || a.contestId - b.contestId);
}

export function buildPlan({
  user,
  solved,
  attempted,
  problems,
  target,
  weekly,
  floorGap,
  contestDates,
  blocked,
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
  const basePerStage = Math.floor(totalNeeded / stages);
  const remainder = totalNeeded - basePerStage * stages;
  const assigned = new Set(); // 全计划去重：同一道题不会出现在两个阶段

  const stageList = [];
  for (let index = 1; index <= stages; index += 1) {
    const stageTarget = roundTo(current + (Math.max(gap, 0) * index) / stages, 50);
    const lo = Math.max(RATING_FLOOR, roundTo(stageTarget - 250, 50));
    const hi = roundTo(stageTarget + 150, 50);
    const band = [lo, hi];
    const bandCenter = stageTarget;

    const inBand = rated.filter(
      (problem) => problem.rating >= lo && problem.rating <= hi,
    );

    const candidates = inBand.filter((problem) => {
      const key = problemKey(problem.contestId, problem.index);
      // 做过的题不再推荐；被手动屏蔽的题也永远不出现
      return !solved.has(key) && !blocked?.has(key);
    });

    // 该阶段重点补的短板标签
    const bandTags = new Set();
    for (const problem of inBand) {
      for (const tag of problem.tags) if (!isNoiseTag(tag)) bandTags.add(tag);
    }
    const ranked = rankFocusTags({ tagProfile, bandTags, bandLower: lo, bandCenter });
    const focus = ranked.slice(0, FOCUS_TAG_COUNT);
    const weakWeights = new Map();
    for (const row of focus) weakWeights.set(row.tag, row.intensity);
    const focusTags = focus.map((row) => ({
      tag: row.tag,
      kind: row.kind,
      weakness: Math.round(row.intensity * 100),
    }));

    const count = basePerStage + (index <= remainder ? 1 : 0);
    const picked = pickProblems(candidates, count, {
      band,
      weakWeights,
      exclude: assigned,
      contestDates,
      now,
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
    stageList,
    notes: [
      `题量估算采用经验系数：每提升 100 分约 ${PROBLEMS_PER_100_RATING} 题，实际情况因人而异。`,
      '每个阶段的练习区间是「目标分 -250 ~ +150」，这是公认效率较高的区间：既能巩固，也有适度挑战。',
      '推荐列表会优先补你目前最薄弱的专题，同时限制单个专题占比，避免偏科。',
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
