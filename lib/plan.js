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

/**
 * AtCoder 题在题单里占的比例。
 * 0.25 是按「一天四题里正好一道」定的：四档各一道的话 AtCoder 占其中一道，
 * 每天都有 AtCoder 的手感，CF 的练习量也不会被压下去。
 * 题量少的时候按比例发（一周 10 题大约两三天来一道）。
 */
export const ATCODER_SHARE = 0.25;

/** 一天最多几道 AtCoder 题：四档里塞两道以上就会挤掉 CF 的练习。 */
export const ATCODER_PER_DAY = 1;

/**
 * 洛谷题在题单里占的比例，同样按「一天四题里一道」定。
 * 洛谷有两个特点：一档的题折算成同一个分值（提高全是 1650），23% 的题洛谷自己没打标签，
 * 所以洛谷那部分名额是「有标签的走方向配额、没标签的只按难度」，再靠一天一道控制节奏。
 */
export const LUOGU_SHARE = 0.25;

/** 一天最多几道洛谷题。 */
export const LUOGU_PER_DAY = 1;

const PROBLEMS_PER_100_RATING = 60;
const MAX_STAGES = 6;
const RATING_FLOOR = 800;
const FOCUS_TAG_COUNT = 5;

/**
 * 每日难度阶梯：四档，间距 200 分，相对「这一阶段的中心」。
 *
 * 用户的原话：1600 练手、1800 进阶、2000 提升、2200~2300 学习。
 * 他当时 1600 分、目标 1900，第一阶段中心正好是 1750，所以这四档就是
 * center-150 / +50 / +250 / +450 —— 四档平均 (1600+1800+2000+2200)/4 = 1900，
 * 正好压在他自己定的目标分上。
 *
 * 一天几题就把这四档轮着发：四题就是各一道；两题则是
 * 「练手+进阶 → 进阶+提升 → 提升+学习 → 学习+练手」循环，长期下来每档一样多。
 */
const LADDER_TIER_OFFSETS = [-150, 50, 250, 450];
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
function scoreCandidate(problem, { tiers, weakWeights, contestDates, now, solveRate }) {
  // 离最近的那一档有多远（四档 = 每日阶梯的四个位置）
  const nearestTierGap = Math.min(
    ...tiers.map((target) => Math.abs((problem.rating ?? 0) - target)),
  );

  // 1. 命中短板标签的程度（取最强的两个加权，避免标签多的题一律占优）
  const hits = problem.tags
    .map((tag) => weakWeights.get(tag) ?? 0)
    .sort((a, b) => b - a);
  const weakScore = Math.min(2, (hits[0] ?? 0) + (hits[1] ?? 0)) * 45;

  // 2. 题目热度：被大量人做过的题通常质量稳定、套路清晰，更适合训练
  const popularity = (Math.min(problem.solvedCount, 15000) / 15000) * 30;

  // 3. 难度是否合适。两种算法：
  //    没有模型时看它离每日阶梯的某一档有多近（四档都要，所以四个难度带都算满分）；
  //    有模型时直接用它算出来的「你现在做出这道题的概率」，命中 0.55 附近给满分。
  const probability = solveRate?.(problem);
  const fit =
    probability == null
      ? 25 * Math.max(0, 1 - nearestTierGap / 150)
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
 * 把一个方向的候选题按四个难度档轮流排开。
 *
 * 只按得分取的话，取到的会全挤在同一个难度上（用户实测：1600 分的人，
 * 一天两道都是 1600~1700，一秒钟做完）。先按「离哪一档最近」归堆，
 * 再一档一道轮着取，这个方向的名额就会均匀落在四个难度上。
 */
/**
 * 挑没有算法标签的题（目前只有 AtCoder）。
 *
 * 这些题进不了八方向配额——AtCoder 官方不给标签，硬塞一个「方向」只会把
 * 能力画像喂脏。所以它们只按难度档铺开：先按得分排序（热度、年份、离四档
 * 的距离），再按四档分堆轮着取，一天里的坡度仍然由四档保证。
 */
function pickUntagged(list, count, { tiers, contestDates, now, preferred, exclude }) {
  if (count <= 0) return [];
  const ranked = list
    .filter((problem) => !exclude?.has(problemKey(problem.contestId, problem.index)))
    .map((problem) => ({
      problem,
      score: scoreCandidate(problem, {
        tiers,
        weakWeights: new Map(),
        contestDates,
        now,
        solveRate: null,
      }),
    }))
    .sort((a, b) => {
      const pinA = preferred?.get(problemKey(a.problem.contestId, a.problem.index));
      const pinB = preferred?.get(problemKey(b.problem.contestId, b.problem.index));
      if (pinA !== undefined && pinB !== undefined) return pinA - pinB;
      if (pinA !== undefined) return -1;
      if (pinB !== undefined) return 1;
      return b.score - a.score;
    });

  // 一档一道轮着取，取出来再按难度排；直接按分数切会全挤在同一档上
  return interleaveBuckets(tierBuckets(ranked, tiers))
    .slice(0, count)
    .map((row) => row.problem);
}

/**
 * 每个平台一天最多几道（现在 AtCoder 和洛谷各一道）。
 *
 * 分层发牌是按难度切的，别的平台的题可能两三天挤在同一天、另外几天一道没有。
 * 这里按「天」做交换：把多出来的题换到还有名额的那天，交换时挑难度差最小的一对，
 * 日程的难度曲线基本不动。换进来的题如果属于另一个有名额限制的平台，
 * 还要看它在被换出的那天有没有位置（不然会把那个平台顶爆）。
 */
function spreadPlatformsByDay(list, perDay, caps) {
  // caps 是普通对象：{ atcoder: 1, luogu: 1 }
  const limited = Object.entries(caps ?? {}).filter(([, cap]) => Number(cap) > 0);
  const size = Math.max(1, Math.min(perDay, list.length));
  if (!limited.length || list.length <= size) return list;

  const days = [];
  for (let index = 0; index < list.length; index += size) {
    days.push(list.slice(index, index + size));
  }

  const platformOf = (problem) => problem.platform ?? 'codeforces';
  const countOf = (day, platform) =>
    day.reduce((total, problem) => total + (platformOf(problem) === platform ? 1 : 0), 0);

  const moved = new Set();
  for (const day of days) {
    for (const [platform, cap] of limited) {
      while (countOf(day, platform) > cap) {
        let fromIndex = -1;
        for (let index = day.length - 1; index >= 0; index -= 1) {
          if (platformOf(day[index]) === platform && !moved.has(day[index])) {
            fromIndex = index;
            break;
          }
        }
        if (fromIndex < 0) break;
        const mover = day[fromIndex];

        // 找一天：它在 mover 这个平台上还有名额，而且换过来的题不会把本天顶爆
        let best = null;
        for (const other of days) {
          if (other === day) continue;
          if (countOf(other, platform) >= cap) continue;
          for (let index = 0; index < other.length; index += 1) {
            const candidate = other[index];
            if (moved.has(candidate)) continue;
            const candidatePlatform = platformOf(candidate);
            if (candidatePlatform === platform) continue;
            const candidateCap = caps[candidatePlatform];
            if (candidateCap != null && countOf(day, candidatePlatform) >= candidateCap) continue;
            const cost = Math.abs((candidate.rating ?? 0) - (mover.rating ?? 0));
            // 换太远的题会把那一天的坡拉平（自检里的跨度检查要求 ≥100 分）
            if (cost > 150) continue;
            if (!best || cost < best.cost) best = { other, index, candidate, cost };
          }
        }
        if (!best) break;

        best.other[best.index] = mover;
        day[fromIndex] = best.candidate;
        moved.add(mover);
        moved.add(best.candidate);
      }
    }
  }
  // 交换会把题插到原来那道题的位置上，顺序可能变成「难的在前」。
  // 每天仍然按难度从小到大排，日程才符合「从易到难」这个前提。
  return days.map((dayProblems) => [...dayProblems].sort((a, b) => (a.rating ?? 0) - (b.rating ?? 0))).flat();
}

/** 把一批题按「离哪一档最近」分堆（堆内保持原来的顺序）。 */
function tierBuckets(list, tiers) {
  const buckets = tiers.map(() => []);
  for (const row of list) {
    let best = 0;
    let bestGap = Infinity;
    tiers.forEach((target, index) => {
      const gap = Math.abs((row.problem.rating ?? 0) - target);
      if (gap < bestGap) {
        bestGap = gap;
        best = index;
      }
    });
    buckets[best].push(row);
  }
  return buckets;
}

/** 把几堆题轮流交错成一条顺序：一档一道，四档题量尽量一样。 */
function interleaveBuckets(buckets) {
  const ordered = [];
  const longest = Math.max(...buckets.map((bucket) => bucket.length));
  for (let round = 0; round < longest; round += 1) {
    for (const bucket of buckets) if (round < bucket.length) ordered.push(bucket[round]);
  }
  return ordered;
}

function interleaveByTier(list, tiers) {
  if (!tiers?.length) return list;
  return interleaveBuckets(tierBuckets(list, tiers));
}

/**
 * 把这一阶段的题排成「每天一套：练手 → 进阶 → 提升 → 学习」。
 *
 * 以前是把打分排序的结果直接按天发下去，前几十天全是这一阶段里最简单的题：
 * 实测 DB_SLSQ（1635 分、目标 1900）前十天是 1500/1500/1500……，
 * 平均每天难度跨度只有 6 分，等于天天在秒签到题。
 *
 * 现在按难度排好之后**分层发牌**：把这一阶段的题按难度切成「每天几题」那么多层，
 * 第 i 天拿每一层的第 i 个。一天四题就是四层各一道（正好对应四个档位），
 * 一天两题就是「偏易那层的一道 + 偏难那层的一道」。
 *
 * 为什么不按「离目标档最近的那道」发：各档的题源数量不一样（实测 25/21/14/19），
 * 最少的那档用完以后，后面的天只能拿剩下的中间题，于是出现「一天两道 1700、
 * 一天两道 1900」这种塌陷（用户实测反馈）。分层发牌每层题数一样，
 * 从第一天到最后一天跨度都稳定。
 */
function orderByDailyLadder(picked, perDay) {
  const byRating = (a, b) => (a.rating ?? 0) - (b.rating ?? 0);
  const sorted = [...picked].sort(byRating);
  if (sorted.length <= 1) return sorted;

  const perDayCount = Math.max(1, Math.min(perDay, sorted.length));
  const perLayer = Math.ceil(sorted.length / perDayCount);
  const layers = [];
  for (let index = 0; index < perDayCount; index += 1) {
    layers.push(sorted.slice(index * perLayer, (index + 1) * perLayer));
  }

  const ordered = [];
  for (let i = 0; i < perLayer; i += 1) {
    const row = layers.map((layer) => layer[i]).filter(Boolean);
    // 一天之内从易到难
    row.sort(byRating);
    ordered.push(...row);
  }
  return ordered;
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
  { tiers, weakWeights, exclude, contestDates, now, tagShare, solveRate, axisIntensity, axesOf, preferred },
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
      score: scoreCandidate(problem, { tiers, weakWeights, contestDates, now, solveRate }),
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

  // 每个方向内部先按四档分堆，再交错成一条顺序：
  // 这个方向的名额会均匀铺在四个难度上，而不是全挤在某一档。
  const axisTiers = new Map([...buckets].map(([axis, list]) => [axis, tierBuckets(list, tiers)]));
  const orderedBuckets = new Map(
    [...axisTiers].map(([axis, tierLists]) => [axis, interleaveBuckets(tierLists)]),
  );

  const quota = allocateQuota(
    [...buckets.entries()]
      .filter(([axis]) => axis !== '__other__')
      .map(([axis, list]) => ({ key: axis, intensity: axisIntensity?.get(axis) ?? 0, size: list.length })),
    count,
  );

  // 先把「上一份计划里已经有」的题原样收下，再按配额挑新的补满。
  // 钉住的题不占配额：它们本来就该在这一阶段里，现在做完了也要留在原位显示成已完成。
  const pinnedPerAxis = new Map();
  // 全局记一下四个档各取了几道：名额少的时候（比如洛谷只占十几道、方向却有八个，
  // 每个方向只分到一两道）按 0→3 的顺序发，会全堆在最简单的那两档上。
  // 每次都从「全局用得最少的那档」开始发，四档才会真的均分。
  const tierUsed = tiers.map(() => 0);
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
  for (const [axis, list] of orderedBuckets) {
    if (picked.length >= count) break;
    // 钉住的题已经占掉了这个方向的名额，剩下的才按配额挑
    const wanted =
      axis === '__other__' ? 0 : Math.max(0, (quota.get(axis) ?? 0) - (pinnedPerAxis.get(axis) ?? 0));
    let taken = 0;
    // 先按档发：这个方向的名额平均分给四个档，一次只从当前那一档里挑，
    // 某档被标签上限刷光了才会轮到下一档，不会整条滑到最难的档上。
    // 关键是「哪几档拿到名额」：按全局用得最少的档往下发，而不是固定的前几档——
    // 一分题单里别的平台只占十几道、方向却有八个，每个方向只分到一两道，
    // 按 0→3 发会让所有方向都挤在最简单那两档（实测能到 9/6/1/0）。
    const tierLists = axisTiers.get(axis) ?? [];
    const tierOrder = tiers
      .map((_, index) => index)
      .sort((a, b) => tierUsed[a] - tierUsed[b] || a - b);
    const tierQuota = tiers.map(() => 0);
    for (let unit = 0; unit < wanted; unit += 1) {
      tierQuota[tierOrder[unit % tiers.length]] += 1;
    }
    for (const tierIndex of tierOrder) {
      if (taken >= wanted) break;
      let takenInTier = 0;
      for (const { problem } of tierLists[tierIndex]) {
    if (takenInTier >= tierQuota[tierIndex] || taken >= wanted) break;
        if (pickedKeys.has(problemKey(problem.contestId, problem.index))) continue;
        if (problem.tags.some((tag) => (tagCount.get(tag) ?? 0) >= maxPerTag)) continue;
        take(problem);
        tierUsed[tierIndex] += 1;
        takenInTier += 1;
        taken += 1;
      }
    }
    // 名额还没够，两种常见原因：某一档里这个方向没有候选（洛谷按分数段分档，
    // 这种情况很多），或者题大多带着已经顶格的标签。补齐的时候**还是按档轮流**，
    // 不能一股脑塞回最简单那档，否则四档分布会被拉歪。
    if (taken < wanted) {
      for (const tierIndex of tierOrder) {
        if (taken >= wanted) break;
        for (const { problem } of tierLists[tierIndex] ?? []) {
          if (taken >= wanted) break;
          if (pickedKeys.has(problemKey(problem.contestId, problem.index))) continue;
          take(problem);
          tierUsed[tierIndex] += 1;
          taken += 1;
        }
      }
    }
    // 还是不够（这个方向的候选里确实没有别的档）：优先保证方向均衡——毕竟
    // 「每个方向都能练到」比「某个标签刚好卡在 40%」更重要；全局占比仍由设置约束。
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
      for (const [axis, list] of orderedBuckets) {
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

  // 最后的兜底：连放宽标签上限都不够，就把题量凑齐。
  // 这里必须按四个难度档轮流取，不能纯按分数：难题标签多、短板得分高，
  // 纯按分数会让半个计划堆在最高那一档（实测 99 题里 48 道挤在 2300 分）。
  if (picked.length < count) {
    for (const { problem } of interleaveByTier(ranked, tiers)) {
      if (picked.length >= count) break;
      if (pickedKeys.has(problemKey(problem.contestId, problem.index))) continue;
      take(problem);
    }
  }

  const axisPlan = [...axisCount]
    .filter(([axis]) => axis !== '__other__')
    .map(([axis, n]) => ({ axis, count: n }))
    .sort((a, b) => b.count - a.count || a.axis.localeCompare(b.axis));

  // 排查「每天难度不对劲」时用：ACM_PLAN_DEBUG=1 会打出四个档位各挑到多少题
  if (process.env.ACM_PLAN_DEBUG) {
    const nearestTier = (problem) => {
      let best = 0;
      tiers.forEach((target, index) => {
        if (
          Math.abs((problem.rating ?? 0) - target) <
          Math.abs((problem.rating ?? 0) - tiers[best])
        ) {
          best = index;
        }
      });
      return best;
    };
    const pickedCounts = tiers.map(() => 0);
    for (const problem of picked) pickedCounts[nearestTier(problem)] += 1;
    const candidateCounts = tiers.map(() => 0);
    for (const row of ranked) candidateCounts[nearestTier(row.problem)] += 1;
    console.error(
      `[plan] 档位 ${tiers.join('/')}｜候选 ${candidateCounts.join('/')}｜取到 ${pickedCounts.join('/')}（要 ${count} 题，实际 ${picked.length}）`,
    );
  }

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
  // AtCoder 题在题单里的占比：0 表示这份计划全用 CF 题（设置里没勾就是 0）
  atcoderShare = 0,
  // 洛谷题在题单里的占比：同样 0 表示不排洛谷题
  luoguShare = 0,
  now = Date.now() / 1000,
}) {
  const share = Number.isFinite(atcoderShare) ? Math.max(0, Math.min(0.5, atcoderShare)) : 0;
  const lgShare = Number.isFinite(luoguShare) ? Math.max(0, Math.min(0.5, luoguShare)) : 0;
  const rated = problems.filter(
    (problem) =>
      problem.type === 'PROGRAMMING' &&
      typeof problem.rating === 'number' &&
      problem.rating >= RATING_FLOOR &&
      // 平台开关：CF 一直参与；AtCoder 和洛谷都是勾了才进池，
      // 没勾的时候连难度统计、补题队列都不算它们。
      ((problem.platform ?? 'codeforces') === 'codeforces' ||
        (problem.platform === 'atcoder' && share > 0) ||
        (problem.platform === 'luogu' && lgShare > 0)),
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
  // 每天大概几题，用来把每个阶段的题摊成「一天一组」。每周 10 题时实际是
  // 一天 1~2 题，这里按 2 算：多题日正好一天一组，单题日就跨两天吃掉一组，
  // 顺序仍然是先易后难。
  const ladderPerDay = weekly <= 7 ? 1 : Math.max(2, Math.round(weekly / 7));

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
    // 区间要装得下每日阶梯的四档：最低一档（练手）在 center-150，最高一档在 center+450，
    // 所以区间取 [center-150, center+500]。下限不用再往下探——比练手档还简单的题
    // 对用户没意义（原话：1600 基本都能秒），留着只会把每天的坡压扁。
    const lo = Math.max(RATING_FLOOR, roundTo(stageTarget - 150 + bandShift, 50));
    const hi = roundTo(stageTarget + 500 + bandShift, 50);
    const band = [lo, hi];
    const bandCenter = stageTarget;
    // 这一阶段的四个难度档：练手 / 进阶 / 提升 / 学习
    const tiers = LADDER_TIER_OFFSETS.map((offset) =>
      Math.max(RATING_FLOOR, roundTo(stageTarget + offset + bandShift, 50)),
    );

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
    // ---- 平台分配 ----
    // 先把 AtCoder 和洛谷的名额挑出来，剩下的题量交给原来的方向配额算法（CF 为主）。
    // 三个平台最后合成一份题单，再按「一天最多一道」把它们摊到各天。
    const atcoderCandidates =
      share > 0 ? candidates.filter((problem) => problem.platform === 'atcoder') : [];
    const cfCandidates =
      share > 0 || lgShare > 0
        ? candidates.filter(
            (problem) => problem.platform !== 'atcoder' && problem.platform !== 'luogu',
          )
        : candidates;

    const luoguCandidates =
      lgShare > 0 ? candidates.filter((problem) => problem.platform === 'luogu') : [];
    // 洛谷有标签的题走方向配额（标签已经翻成 CF 的名字），没标签的只按难度档铺开。
    // 名额按两边候选数的比例分，免得 23% 没标签的题被完全压在后面。
    const luoguTagged = luoguCandidates.filter((problem) => problem.tags?.length);
    const luoguUntagged = luoguCandidates.filter((problem) => !problem.tags?.length);
    const luoguWanted = Math.min(luoguCandidates.length, Math.round(count * lgShare));
    const untaggedWanted = luoguUntagged.length
      ? Math.min(
          luoguUntagged.length,
          Math.round((luoguWanted * luoguUntagged.length) / Math.max(1, luoguCandidates.length)),
        )
      : 0;
    const luoguPicked = untaggedWanted
      ? pickUntagged(luoguUntagged, untaggedWanted, {
          tiers,
          contestDates,
          now,
          preferred,
          exclude: assigned,
        })
      : [];
    const luoguTaggedWanted = Math.max(0, luoguWanted - luoguPicked.length);
    if (luoguTaggedWanted > 0 && luoguTagged.length) {
      const { picked: taggedPicked } = pickProblems(luoguTagged, luoguTaggedWanted, {
        tiers,
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
      luoguPicked.push(...taggedPicked);
    }
    for (const problem of luoguPicked) {
      assigned.add(problemKey(problem.contestId, problem.index));
    }

    const atcoderWanted = Math.min(atcoderCandidates.length, Math.round(count * share));
    const atcoderPicked = pickUntagged(atcoderCandidates, atcoderWanted, {
      tiers,
      contestDates,
      now,
      preferred,
      exclude: assigned,
    });
    for (const problem of atcoderPicked) assigned.add(problemKey(problem.contestId, problem.index));

    const reserved = atcoderPicked.length + luoguPicked.length;
    const { picked: cfPicked, axisPlan } = pickProblems(cfCandidates, count - reserved, {
      tiers,
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
    let picked = [...atcoderPicked, ...luoguPicked, ...cfPicked];

    // CF 那边凑不满（区间里题少、或者你差不多做完了），缺的名额用剩下的
    // AtCoder / 洛谷题补，题量该是多少还是多少，不会因为换了平台就缩水
    if (picked.length < count) {
      const rest = atcoderCandidates.filter(
        (problem) => !assigned.has(problemKey(problem.contestId, problem.index)),
      );
      const extra = pickUntagged(rest, count - picked.length, {
        tiers,
        contestDates,
        now,
        preferred,
        exclude: assigned,
      });
      for (const problem of extra) assigned.add(problemKey(problem.contestId, problem.index));
      picked = [...picked, ...extra];
    }
    if (picked.length < count) {
      const rest = luoguCandidates.filter(
        (problem) => !assigned.has(problemKey(problem.contestId, problem.index)),
      );
      const extra = pickUntagged(rest, count - picked.length, {
        tiers,
        contestDates,
        now,
        preferred,
        exclude: assigned,
      });
      for (const problem of extra) assigned.add(problemKey(problem.contestId, problem.index));
      picked = [...picked, ...extra];
    }
    for (const problem of cfPicked) assigned.add(problemKey(problem.contestId, problem.index));

    const atcoderCount = picked.filter((problem) => problem.platform === 'atcoder').length;
    const luoguCount = picked.filter((problem) => problem.platform === 'luogu').length;

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
      // 这一阶段里有几道 AtCoder 题。AtCoder 没有标签，不参与上面的方向配额，
      // 单独报一个数，免得「方向题数加起来不等于总数」看着像少了题
      atcoderCount,
      // 洛谷题数同理：有标签的进了方向配额，没标签的没有，所以单独报一个数
      luoguCount,
      supply: inBand.length,
      unsolvedSupply: candidates.length,
      // 按「每天从简单到难」的顺序发下去（日程是按这个顺序切的），
      // 再把 AtCoder 和洛谷的题摊开：各自一天最多一道。
      problems: spreadPlatformsByDay(orderByDailyLadder(picked, ladderPerDay), ladderPerDay, {
        atcoder: ATCODER_PER_DAY,
        luogu: LUOGU_PER_DAY,
      }).map(toClientProblem),
      review,
    });
  }

  // 这份计划里排了几道别的平台的题，说明里要讲清楚（勾了开关但一道都没排上也要说）
  const atcoderTotal = stageList.reduce((sum, stage) => sum + (stage.atcoderCount ?? 0), 0);
  const luoguTotal = stageList.reduce((sum, stage) => sum + (stage.luoguCount ?? 0), 0);

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
      share > 0 && atcoderTotal > 0
        ? `这份计划里有 ${atcoderTotal} 道 AtCoder 题（ABC/ARC/AGC），按 Kenkoooo 难度折成练习区间里的分值，每天最多一道。AtCoder 没有官方算法标签，所以它们只参与难度分配，不进八个方向的配额，也不算进能力画像。`
        : null,
      share > 0 && atcoderTotal === 0
        ? '设置里勾了「加入 AtCoder 题」，但这份计划里一道都没排上：要么还没同步 AtCoder 用户名，要么这个练习区间里没有合适的 AtCoder 题。去设置里同步一次就能用。'
        : null,
      lgShare > 0 && luoguTotal > 0
        ? `这份计划里有 ${luoguTotal} 道洛谷题，每天最多一道。洛谷只给 9 档难度，档内的题是按通过人数摊开的近似（通过得多的排低分、通过得少的排高分），所以那个分值是个估计值，界面上鼠标停在「洛谷」角标上能看到真实档位。有算法标签的题照样进八方向配额，没标签的（洛谷自己没打）只按难度进池。`
        : null,
      lgShare > 0 && luoguTotal === 0
        ? '设置里勾了「加入洛谷题」，但这份计划里一道都没排上：这个练习区间里没有合适的洛谷题，或者洛谷题库还没抓。到设置里抓一次题库就能用。'
        : null,
    ].filter(Boolean),
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
    // 题目来源：codeforces / atcoder。界面靠它显示来源角标、拼对的链接
    platform: problem.platform ?? 'codeforces',
    // 界面上显示的题号：CF 是 1234A，AtCoder 是 ABC300E
    code: problemCode(problem),
    // AtCoder 自己的题号和难度（Kenkoooo difficulty），鼠标悬停能看见
    nativeId: problem.nativeId ?? null,
    nativeContest: problem.nativeContest ?? null,
    nativeRating: problem.nativeRating ?? null,
    url: problemUrl(problem),
  };
}

/**
 * 题目链接。
 * 传题目对象时按平台分派；传 (contestId, index) 时按 CF 处理，
 * 这样老调用点（虚拟参赛、比赛题目列表那些）不用改。
 */
export function problemUrl(problem, index) {
  if (problem && typeof problem === 'object') {
    if (problem.platform === 'atcoder' && problem.nativeContest && problem.nativeId) {
      return `https://atcoder.jp/contests/${problem.nativeContest}/tasks/${problem.nativeId}`;
    }
    if (problem.platform === 'luogu' && problem.nativeId) {
      return `https://www.luogu.com.cn/problem/${problem.nativeId}`;
    }
    return problemUrl(problem.contestId, problem.index);
  }
  const contestId = problem;
  return contestId >= 100000
    ? `https://codeforces.com/gym/${contestId}/problem/${index}`
    : `https://codeforces.com/problemset/problem/${contestId}/${index}`;
}

/** 界面上显示的题号：CF 用「比赛号 + 题号」，AtCoder 用「比赛名 + 题号」。 */
export function problemCode(problem) {
  if (problem.platform === 'atcoder' && problem.nativeContest) {
    return `${String(problem.nativeContest).toUpperCase()}${problem.index}`;
  }
  // 洛谷的题号本身就是 P1001 这种，直接用
  if (problem.platform === 'luogu' && problem.nativeId) return String(problem.nativeId);
  return `${problem.contestId}${problem.index}`;
}
