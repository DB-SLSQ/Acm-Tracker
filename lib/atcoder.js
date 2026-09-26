// AtCoder 题库与提交记录。
//
// 走的是 Kenkoooo 的 AtCoder Problems 公开接口：AtCoder 官方不提供题库和难度，
// 这个接口匿名就能读题目表、难度估计和任意用户的提交记录，不需要登录，
// 也不用碰 atcoder.jp 本身。
//
// 难度怎么对齐到 CF：Kenkoooo 的 difficulty 是 IRT 估计值，量级比 CF rating 低一截。
// 实测（2026-09 抓的样本）：ABC-C 约 400~530、ABC-D 770~900、ABC-E 1350~1390、
// ABC-F 1600~1850、ABC-G 2060~2340，ARC-C 约 2070。
// 一个 1600 分的 CF 用户做 ABC-E 大概相当于 CF 1500~1600 的题，所以统一加 200，
// 折成「练习区间」的分值后就能和 CF 题放进同一把尺子。以后按自己的通过率再校准。

const RESOURCES = 'https://kenkoooo.com/atcoder/resources';
const API = 'https://kenkoooo.com/atcoder/atcoder-api';
const USER_AGENT = 'acm-trainer/0.1 (local, single-user)';

// Kenkoooo 明确要求「1 秒最多一个请求」，这里取 1.1 秒留点余量
const MIN_GAP_MS = 1100;
const PAGE_SIZE = 500;
const MAX_PAGES = 40;

/**
 * 只要标准赛的题（ABC / ARC / AGC）。
 * 其他系列（ADT、PAST、典型 90、JOI、AWC…）没有难度估计；
 * 其中 ADT 本身就是 ABC/ARC 原题的重排，导进来会和原题撞车。
 */
const STANDARD_CONTEST = /^(abc|arc|agc)\d+$/;

/** 折算偏移：Kenkoooo difficulty + 200 ≈ CF rating 口径。见文件头实测数据。 */
export const ATCODER_RATING_OFFSET = 200;

/**
 * 折算后低于计划下限（lib/plan.js 的 RATING_FLOOR = 800）的题直接不要。
 * 这里不往上夹到 800：夹的话 ABC-A/B 那种题会全堆在 800 分上，看着像一道普通的
 * 入门题，实际是签到级，真按 800 分排进计划就是浪费时间。
 */
const MIN_IMPORT_RATING = 800;

export class AtcoderError extends Error {
  constructor(message, retryable = false) {
    super(message);
    this.name = 'AtcoderError';
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

/**
 * 单一入口：串行 + 限速 + 重试。
 * Kenkoooo 在高峰期会偶发 5xx，这种才重试；4xx 直接报错，重试没意义。
 */
async function getJson(url, { retries = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await sleep(1500 * attempt);
    await throttle();
    try {
      const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
      if (response.status === 404) {
        throw new AtcoderError('这个 AtCoder 用户名不存在（大小写要和 AtCoder 上完全一致）');
      }
      if (!response.ok) {
        throw new AtcoderError(`Kenkoooo 返回了 HTTP ${response.status}`, response.status >= 500);
      }
      return await response.json();
    } catch (error) {
      if (error instanceof AtcoderError && !error.retryable) throw error;
      lastError = error instanceof AtcoderError ? error : new AtcoderError(`网络错误：${error.message}`, true);
    }
  }
  throw lastError;
}

/** 难度折算：加上偏移，再按 50 分一档取整，和 CF 的 rating 刻度对齐。 */
function toRating(difficulty) {
  return Math.round((difficulty + ATCODER_RATING_OFFSET) / 50) * 50;
}

/** AtCoder 用户名（Kenkoooo 接口的用户名就是 AtCoder 上的那个）。 */
export function normalizeUser(raw) {
  const user = String(raw ?? '').trim();
  if (!user) throw new AtcoderError('请先填 AtCoder 用户名');
  if (!/^[A-Za-z0-9_]{1,30}$/.test(user)) {
    throw new AtcoderError('AtCoder 用户名只能是字母、数字、下划线');
  }
  return user;
}

/**
 * 题库：problems.json（题目表）+ problem-models.json（难度）+ contests.json（比赛时间）。
 * 三个文件加起来约 3 MB，所以只在题库过期或者用户手动点同步时才抓。
 */
export async function fetchCatalog({ onProgress } = {}) {
  onProgress?.('正在拉取题目表…');
  const problems = await getJson(`${RESOURCES}/problems.json`);
  onProgress?.('正在拉取难度估计…');
  const models = await getJson(`${RESOURCES}/problem-models.json`);
  onProgress?.('正在拉取比赛时间…');
  const contests = await getJson(`${RESOURCES}/contests.json`);

  const startTimes = new Map(
    (Array.isArray(contests) ? contests : []).map((row) => [
      String(row.id ?? ''),
      Number(row.start_epoch_second ?? 0) || null,
    ]),
  );

  const rows = [];
  for (const problem of Array.isArray(problems) ? problems : []) {
    const nativeContest = String(problem.contest_id ?? '');
    if (!STANDARD_CONTEST.test(nativeContest)) continue;
    const difficulty = models?.[problem.id]?.difficulty;
    if (typeof difficulty !== 'number') continue;
    const rating = toRating(difficulty);
    if (rating < MIN_IMPORT_RATING) continue;
    rows.push({
      nativeId: String(problem.id ?? ''),
      nativeContest,
      index: String(problem.problem_index ?? '').toUpperCase(),
      name: String(problem.name || problem.title || problem.id || ''),
      rating,
      nativeRating: Math.round(difficulty),
      startTime: startTimes.get(nativeContest) ?? null,
    });
  }
  return rows;
}

/** AtCoder 的结果字符串 → 本工具的口径（只有 OK 会被当成通过）。 */
function toVerdict(result) {
  return String(result ?? '').toUpperCase() === 'AC' ? 'OK' : 'OTHER';
}

/**
 * 提交记录。Kenkoooo 一次最多给 500 条，按 epoch_second 往后翻。
 * fromSecond 传上次同步到的秒数就是增量同步（边界那条会重复取一次，入库时忽略）。
 */
export async function fetchSubmissions(user, { fromSecond = 0, onPage } = {}) {
  const account = normalizeUser(user);
  const rows = [];
  let cursor = Math.max(0, Number(fromSecond) || 0);
  let newest = cursor;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = `${API}/v3/user/submissions?user=${encodeURIComponent(account)}&from_second=${cursor}`;
    const batch = await getJson(url);
    if (!Array.isArray(batch) || !batch.length) return { rows, newest, done: true };

    rows.push(...batch);
    const last = Math.max(...batch.map((item) => Number(item.epoch_second ?? 0)));
    // 每次都从游标那一秒开始取，边界上那条会重复返回一次。
    // 整批都不比游标新就说明已经追平了（同时防止接口不推进时死循环）。
    if (last <= cursor) return { rows, newest: Math.max(newest, last), done: true };

    cursor = last;
    newest = Math.max(newest, last);
    onPage?.(rows.length);
    if (batch.length < PAGE_SIZE) return { rows, newest, done: true };
  }
  return { rows, newest, done: false };
}

export { toVerdict, MIN_GAP_MS };
