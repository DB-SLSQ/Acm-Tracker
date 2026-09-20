// 比赛日历 + 虚拟参赛：推荐该打哪场、复盘打了怎么样。

import { problemKey, problemUrl } from './plan.js';

const MIN_DURATION_SECONDS = 5400; // 少于 1.5 小时的比赛不适合拿来练

/** 从比赛名里解析出组别，用于给"这场适不适合你"的建议。 */
export function parseContestInfo(name = '') {
  const lower = name.toLowerCase();

  if (/div\.\s*1\s*\+\s*div\.\s*2|div\.\s*1\s*\+\s*2/.test(lower)) {
    return { division: 'Div. 1+2', tone: 'combined' };
  }
  const div = lower.match(/div\.\s*(\d)/);
  if (div) return { division: `Div. ${div[1]}`, tone: 'div' };
  if (lower.includes('educational')) return { division: 'Educational', tone: 'educational' };
  if (lower.includes('global round')) return { division: 'Global Round', tone: 'combined' };
  if (lower.includes('codeforces round')) return { division: 'Codeforces Round', tone: 'round' };
  return { division: '其他', tone: 'other' };
}

// 各组别适合的 rating 区间（推荐区间 / 可以试的区间）
const FIT_TABLE = {
  'Div. 4': { recommend: [0, 1450], ok: [0, 1650] },
  'Div. 3': { recommend: [900, 1750], ok: [800, 1950] },
  'Div. 2': { recommend: [1250, 2150], ok: [1100, 2350] },
  Educational: { recommend: [1000, 2250], ok: [850, 2450] },
  'Div. 1+2': { recommend: [1950, 9999], ok: [1750, 9999] },
  'Global Round': { recommend: [1950, 9999], ok: [1750, 9999] },
  'Div. 1': { recommend: [2150, 9999], ok: [1950, 9999] },
  'Codeforces Round': { recommend: [1100, 2200], ok: [900, 2400] },
};

/** 这场比赛的组别对当前 rating 来说合不合适。 */
export function divisionFit(division, current) {
  const rule = FIT_TABLE[division];
  if (!rule) return { label: '组别不明确', tone: 'unknown' };

  const [recLow, recHigh] = rule.recommend;
  const [okLow, okHigh] = rule.ok;

  if (current >= recLow && current <= recHigh) return { label: '正合适', tone: 'good' };
  if (current >= okLow && current <= okHigh) {
    return current < recLow
      ? { label: '略有难度，可以试', tone: 'ok' }
      : { label: '偏简单，练手速', tone: 'ok' };
  }
  if (current < okLow) return { label: '偏难，先积累', tone: 'hard' };
  return { label: '偏简单，练手速', tone: 'easy' };
}

/**
 * 从已结束的比赛里挑适合虚拟参赛的场次。
 * 核心思路：一场好的训练赛 = 题目难度落在你的练习区间 + 覆盖你的薄弱专题 + 你还没做过。
 */
export function recommendVirtualContests({
  contests,
  problems,
  solved,
  weakTags,
  current,
  target,
  participatedContestIds,
  doneContestIds,
  limit = 6,
}) {
  const problemsByContest = new Map();
  for (const problem of problems) {
    if (problem.type !== 'PROGRAMMING' || problem.rating == null) continue;
    const list = problemsByContest.get(problem.contestId) ?? [];
    list.push(problem);
    problemsByContest.set(problem.contestId, list);
  }

  const lo = Math.max(800, target - 250);
  const hi = target + 150;
  const nowSeconds = Date.now() / 1000;
  const weakLimit = Math.max(1, Math.min(5, weakTags.size));

  const scored = [];

  for (const contest of contests) {
    if (contest.type !== 'CF') continue;
    if (contest.startTime == null || contest.duration < MIN_DURATION_SECONDS) continue;
    // 必须已经结束超过一天，避免刚打完还在 system test 的场次
    if (nowSeconds - (contest.startTime + contest.duration) < 86400) continue;
    if (participatedContestIds.has(contest.id) || doneContestIds.has(contest.id)) continue;

    const list = problemsByContest.get(contest.id);
    if (!list || list.length < 4 || list.length > 8) continue;

    const unsolved = list.filter((problem) => !solved.has(problemKey(problem.contestId, problem.index)));
    if ((list.length - unsolved.length) / list.length >= 0.4) continue; // 大半做过了，没有练的价值
    if (unsolved.length < 3) continue;

    const ratings = list.map((problem) => problem.rating).sort((a, b) => a - b);
    const minRating = ratings[0];
    const maxRating = ratings[ratings.length - 1];

    // 1. 有多少题正好落在你的练习区间
    const inBandCount = list.filter(
      (problem) => problem.rating >= lo && problem.rating <= hi,
    ).length;
    const fitScore = (inBandCount / list.length) * 35;

    // 2. 天花板够不够高：整场都比你现在水平简单，练不到东西
    const ceilingScore = maxRating >= current + 200 ? 20 : maxRating >= current ? 10 : 0;

    // 3. 第一题你能不能做——开赛就卡住是最劝退的
    const entryScore = minRating <= current ? 15 : minRating <= current + 400 ? 8 : 0;

    // 4. 覆盖面：这场比赛能碰到几个你的薄弱专题
    const covered = new Set();
    for (const problem of list) {
      for (const tag of problem.tags) if (weakTags.has(tag)) covered.add(tag);
    }
    const weakScore = Math.min(20, (covered.size / weakLimit) * 20);

    // 5. 稍微偏爱近几年的比赛：题目风格更贴近现在的赛场
    const yearsAgo = (nowSeconds - contest.startTime) / (365 * 24 * 3600);
    const recencyScore = Math.max(0, 10 - yearsAgo);

    const score = fitScore + ceilingScore + entryScore + weakScore + recencyScore;
    const info = parseContestInfo(contest.name);

    // 理由全部来自上面的实际计算，不写没有依据的话
    const reasons = [];
    reasons.push(
      inBandCount > 0
        ? `${list.length} 题里有 ${inBandCount} 题落在你的练习区间 ${lo}~${hi} 分`
        : `题目难度 ${minRating}~${maxRating}，不在当前练习区间，更适合当作挑战赛`,
    );
    if (maxRating >= current + 200) reasons.push(`最难题 ${maxRating} 分，高于你现在的水平`);
    else if (maxRating < current) reasons.push(`最难题 ${maxRating} 分，低于你现在的水平，主要练速度和稳定性`);
    reasons.push(
      minRating <= current
        ? `最简单的题 ${minRating} 分，开赛不会卡住`
        : `最简单的题 ${minRating} 分，比你现在水平高一些`,
    );
    if (covered.size >= 2) reasons.push(`会碰到你较弱的 ${covered.size} 个专题`);
    reasons.push(
      unsolved.length === list.length
        ? `这 ${list.length} 题你一道都没做过`
        : `${unsolved.length} 题你还没做过`,
    );

    scored.push({
      contestId: contest.id,
      name: contest.name,
      division: info.division,
      startTime: contest.startTime,
      durationSeconds: contest.duration,
      problemCount: list.length,
      minRating,
      maxRating,
      unsolvedCount: unsolved.length,
      coveredWeakTags: [...covered].slice(0, 5),
      score: Math.round(score),
      reasons,
      url: `https://codeforces.com/contest/${contest.id}`,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/** 复盘：把一次虚拟赛的提交记录整理成"哪些题解了、花了多久、卡在哪"。 */
export function analyzeVirtualSession({ session, contest, problems, submissions, current, target }) {
  const startSeconds = Math.floor(session.startedAt / 1000);
  const endSeconds = Math.floor(
    (session.finishedAt ?? session.startedAt + session.durationSeconds * 1000) / 1000,
  );

  const relevant = submissions.filter(
    (submission) =>
      submission.contestId === contest.id &&
      submission.createdAt >= startSeconds - 120 &&
      submission.createdAt <= endSeconds + 120,
  );

  const perProblem = new Map();
  for (const submission of relevant) {
    const key = problemKey(submission.contestId, submission.index);
    const entry = perProblem.get(key) ?? { attempts: 0, fails: 0, firstAcAt: null, lastVerdict: null };
    entry.attempts += 1;
    entry.lastVerdict = submission.verdict;
    if (submission.verdict === 'OK') {
      if (entry.firstAcAt == null) entry.firstAcAt = submission.createdAt;
    } else {
      entry.fails += 1;
    }
    perProblem.set(key, entry);
  }

  const rows = [...problems]
    .sort((a, b) => a.index.localeCompare(b.index))
    .map((problem) => {
      const entry = perProblem.get(problemKey(problem.contestId, problem.index));
      const solvedFlag = entry?.firstAcAt != null;
      return {
        contestId: problem.contestId,
        index: problem.index,
        name: problem.name,
        rating: problem.rating,
        tags: problem.tags,
        url: problemUrl(problem.contestId, problem.index),
        status: solvedFlag ? 'solved' : entry ? 'attempted' : 'untouched',
        attempts: entry?.attempts ?? 0,
        fails: entry?.fails ?? 0,
        elapsedSeconds: solvedFlag ? entry.firstAcAt - startSeconds : null,
      };
    });

  const solvedRows = rows.filter((row) => row.status === 'solved');
  const stuckRows = rows
    .filter((row) => row.status === 'attempted')
    .sort((a, b) => b.fails - a.fails);

  const lastSubmission = relevant.length
    ? Math.max(...relevant.map((submission) => submission.createdAt))
    : null;
  const submissionCount = relevant.length;

  const highlights = [];
  if (submissionCount === 0) {
    highlights.push(
      '这场比赛没有抓到你任何提交记录。如果你确实在 Codeforces 上提交过，稍后重新加载一次；如果只是在本地计时做的，复盘内容就是空的。',
    );
  } else if (solvedRows.length === 0 && rows.length) {
    const easiest = Math.min(...rows.map((row) => row.rating).filter((rating) => rating != null));
    highlights.push(
      easiest > current
        ? `这场比赛最简单的题也有 ${easiest} 分，已经高于你现在的 ${current} 分，一题没解出来属于正常。下一场换题目更简单的组别。`
        : `题目难度在你的能力范围内，但一题都没解出来，更可能是时间分配或状态问题。下一场先确保稳稳拿下第一题。`,
    );
  } else {
    const fastest = [...solvedRows].sort((a, b) => a.elapsedSeconds - b.elapsedSeconds)[0];
    if (fastest) {
      highlights.push(`${fastest.index} 题（${fastest.rating} 分）最快拿下，用时 ${formatDuration(fastest.elapsedSeconds)}。`);
    }
  }
  if (stuckRows.length) {
    highlights.push(
      `卡住的是 ${stuckRows.map((row) => `${row.index} 题（失败 ${row.fails} 次）`).join('、')}，这几道值得赛后补。`,
    );
  }
  const untouched = rows.filter((row) => row.status === 'untouched');
  if (untouched.length >= 2 && solvedRows.length >= 2) {
    highlights.push(`还有 ${untouched.length} 题完全没碰，说明时间分配上还有余量。`);
  }
  if (solvedRows.length && target > current) {
    const hard = Math.max(...solvedRows.map((row) => row.rating));
    if (hard >= target) highlights.push(`解出的最难题是 ${hard} 分，已经摸到你目标 ${target} 分的水平了。`);
  }

  return {
    contestId: contest.id,
    contestName: contest.name,
    startedAt: session.startedAt,
    durationSeconds: session.durationSeconds,
    rows,
    solvedCount: solvedRows.length,
    attemptedCount: stuckRows.length,
    untouchedCount: untouched.length,
    weightedScore: solvedRows.reduce((sum, row) => sum + row.rating, 0),
    hardestSolved: solvedRows.length ? Math.max(...solvedRows.map((row) => row.rating)) : null,
    submissionCount,
    usedSeconds: lastSubmission != null ? lastSubmission - startSeconds : 0,
    highlights,
  };
}

function formatDuration(seconds) {
  if (seconds == null) return '—';
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${seconds % 60} 秒`;
}
