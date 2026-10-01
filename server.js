import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as cf from './lib/cf.js';
import * as db from './lib/db.js';
import {
  ATCODER_SHARE,
  LUOGU_SHARE,
  assignAxes,
  buildPlan,
  buildTeamPlans,
  deriveProgress,
  problemCode,
  problemKey,
  problemUrl,
  rankFocusTags,
  toClientProblem,
} from './lib/plan.js';
import { buildKnowledgeProfile, buildTagProfile, isNoiseTag, knowledgeAxis } from './lib/knowledge.js';
import {
  analyzeVirtualSession,
  divisionFit,
  parseContestInfo,
  recommendVirtualContests,
} from './lib/contests.js';
import { fetchLuogu, fetchLuoguText, fetchNowcoder, PlatformError } from './lib/platforms.js';
import {
  AtcoderError,
  fetchCatalog as fetchAtcoderCatalog,
  fetchSubmissions as fetchAtcoderSubmissions,
  fetchUserInfo as fetchAtcoderUserInfo,
  normalizeUser as normalizeAtcoderUser,
  toVerdict as toAtcoderVerdict,
} from './lib/atcoder.js';
import {
  REQUEST_BUDGET as LUOGU_REQUEST_BUDGET,
  LUOGU_POPULAR_LEVELS,
  fetchCatalog as fetchLuoguCatalog,
} from './lib/luogu.js';
import * as modelModule from './lib/model.js';

// 同一个账号多久之内不重复抓取（毫秒）。手动同步也走这个限制，防止连点。
const SYNC_COOLDOWN_MS = 20_000;
const recentSyncs = new Map();

// 题库一旦同步进库就基本不动，但生成计划时要按「方向 × 难度档」反复筛，
// 每次请求都从 SQLite 读一万多条再建 Map 很浪费（实测计划生成里这部分占大头）。
// 这里缓存一份，题库刷新/删除时清掉。
let problemsCache = null;
const allProblems = () => {
  if (!problemsCache) problemsCache = db.getAllProblems();
  return problemsCache;
};
const dropProblemsCache = () => {
  problemsCache = null;
};

// 后台训练任务：一次只能跑一个，进度靠这个对象回传，前端轮询。
const training = {
  running: false,
  lines: [],
  startedAt: null,
  finishedAt: null,
  error: null,
};

function pushTrainingLine(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    training.lines.push(trimmed);
  }
  // 只留最近的一段，前端够显示就行
  if (training.lines.length > 60) training.lines.splice(0, training.lines.length - 60);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, 'public');
const DEFAULT_PORT = Number(process.env.PORT || 5173);
const DEFAULT_HOST = process.env.HOST || '127.0.0.1';

// 版本号取自 package.json，界面底部会显示，方便确认装的是哪个版本
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
})();

const USER_CACHE_MS = 1000 * 60 * 60 * 6; // 用户数据 6 小时内不重复抓
const PROBLEMS_CACHE_MS = 1000 * 60 * 60 * 24; // 题库每天更新一次
const CONTESTS_CACHE_MS = 1000 * 60 * 60 * 12; // 比赛目录每 12 小时更新一次

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
  ['.json', 'application/json; charset=utf-8'],
]);

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

async function readJsonBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function isFresh(updatedAt, windowMs) {
  return updatedAt != null && Date.now() - updatedAt < windowMs;
}

async function ensureProblems({ force = false } = {}) {
  const count = db.countProblems();
  const updatedAt = Number(db.metaGet('problems_updated_at') || 0);
  if (!force && count > 3000 && isFresh(updatedAt, PROBLEMS_CACHE_MS)) {
    return { count, updatedAt, refreshed: false };
  }
  const data = await cf.getProblemset();
  const inserted = db.replaceProblems(data);
  dropProblemsCache();
  const now = Date.now();
  db.metaSet('problems_updated_at', now);
  return { count: inserted, updatedAt: now, refreshed: true };
}

async function ensureContests({ force = false } = {}) {
  const count = db.countContests();
  const updatedAt = Number(db.metaGet('contests_updated_at') || 0);
  if (!force && count > 100 && isFresh(updatedAt, CONTESTS_CACHE_MS)) {
    return { count, updatedAt, refreshed: false };
  }
  const list = await cf.getContestList();
  const inserted = db.replaceContests(list);
  const now = Date.now();
  db.metaSet('contests_updated_at', now);
  return { count: inserted, updatedAt: now, refreshed: true };
}

/**
 * AtCoder 题库。三个 JSON 加起来约 3 MB，只有过期（默认 7 天）或者用户手动点
 * 「同步 AtCoder」时才重新拉；题库本身长得慢，天天抓没意义。
 */
const ATCODER_CATALOG_TTL_MS = 7 * 24 * 3600 * 1000;

async function ensureAtcoderCatalog({ force = false, onProgress } = {}) {
  const count = db.countAtcoderProblems();
  const updatedAt = Number(db.metaGet('atcoder_problems_updated_at') || 0);
  if (!force && count > 1000 && isFresh(updatedAt, ATCODER_CATALOG_TTL_MS)) {
    return { count, updatedAt, refreshed: false };
  }
  const rows = await fetchAtcoderCatalog({ onProgress });
  const inserted = db.replaceAtcoderProblems(rows);
  dropProblemsCache();
  const now = Date.now();
  db.metaSet('atcoder_problems_updated_at', now);
  return { count: inserted, updatedAt: now, refreshed: true };
}

/** AtCoder 提交记录多久之内不重复抓（毫秒）。增量抓只要一两个请求，但也别每次刷页面都抓。 */
const ATCODER_SUBMISSION_TTL_MS = 6 * 3600 * 1000;

/**
 * 同步 AtCoder 提交记录。第一次会从头翻完整个提交历史，之后按游标只补新的。
 * 记录入到 submissions 表里，和 CF 共用一个进度口径：
 * 「做过的题不再推荐」「自动打勾」「补题队列」全都自动生效。
 */
async function syncAtcoderSubmissions(handleKey, account, { force = false, onProgress } = {}) {
  const freshAt = Number(db.metaGet(`atcoder_synced_at:${handleKey}`) || 0);
  if (!force && isFresh(freshAt, ATCODER_SUBMISSION_TTL_MS)) {
    return { added: 0, skipped: 0, total: db.countAtcoderSolved(handleKey), cached: true };
  }

  const cursor = db.getAtcoderSyncCursor(handleKey);
  const { rows, newest, done } = await fetchAtcoderSubmissions(account, {
    fromSecond: cursor,
    onPage: (n) => onProgress?.(`已读取 ${n} 条提交记录…`),
  });

  // 只留题库里有的题（ABC/ARC/AGC），其他系列的题排不进计划，收了也没用
  const mapped = rows.map((row) => ({
    id: row.id,
    nativeId: String(row.problem_id ?? ''),
    verdict: toAtcoderVerdict(row.result),
    createdAt: Number(row.epoch_second ?? 0),
  }));
  const { inserted, skipped } = db.appendAtcoderSubmissions(handleKey, mapped);
  if (newest > cursor) db.setAtcoderSyncCursor(handleKey, newest);
  // 没翻到头（记录太多，一轮没走完）就先不标记为「刚同步过」，下次接着翻
  if (done) db.metaSet(`atcoder_synced_at:${handleKey}`, Date.now());

  return {
    added: inserted,
    skipped,
    total: db.countAtcoderSolved(handleKey),
    cached: false,
    done,
  };
}

/**
 * 拉取提交记录。
 * 有同步游标时只补新记录（往前多取 24 小时容错），首次同步才全量重建。
 */
async function loadSubmissions(handleKey, handle, { full = false } = {}) {
  const cursor = db.getSyncCursor(handleKey);
  const incremental = !full && cursor > 0;
  const stopBefore = incremental ? cursor - 24 * 3600 : 0;

  const { rows, newest } = await cf.getAllSubmissions(handle, { stopBefore });
  const inserted = incremental
    ? db.appendSubmissions(handleKey, rows)
    : db.replaceSubmissions(handleKey, rows);

  if (newest > 0) db.setSyncCursor(handleKey, Math.max(cursor, newest));
  return inserted;
}

async function loadUser(rawHandle, { force = false } = {}) {
  const handleKey = db.normalizeHandle(rawHandle);
  const cached = db.getUser(handleKey);

  if (!force && cached && isFresh(cached.updatedAt, USER_CACHE_MS)) {
    return { user: cached, refreshed: false };
  }

  const info = await cf.getUser(rawHandle);
  const user = {
    displayHandle: info.handle ?? rawHandle,
    rating: info.rating ?? null,
    maxRating: info.maxRating ?? null,
    rank: info.rank ?? null,
    maxRank: info.maxRank ?? null,
    titlePhoto: info.titlePhoto ?? null,
  };
  db.saveUser(handleKey, user);

  const ratingHistory = await cf.getRatingHistory(rawHandle);
  db.replaceRatingHistory(handleKey, ratingHistory);
  await loadSubmissions(handleKey, rawHandle, { full: force });

  return { user: db.getUser(handleKey), refreshed: true };
}

function buildUserSummary(handleKey) {
  const user = db.getUser(handleKey);
  if (!user) return null;
  const submissions = db.getSubmissions(handleKey);
  // 账号卡片上的数字对应的是 Codeforces 这个号：AtCoder 的记录混进去会让
  // 「已通过 N 题」和旁边那个 CF rating 对不上口径。计划那边用全平台的记录。
  const cfSubmissions = submissions.filter((row) => row.platform !== 'atcoder');
  const { solved, attempted } = deriveProgress(cfSubmissions);
  return {
    ...user,
    submissionCount: cfSubmissions.length,
    solvedCount: solved.size,
    attemptedCount: attempted.size,
    ratingHistory: db.getRatingHistory(handleKey),
  };
}

export const THEMES = ['dark', 'light', 'gray', 'eye'];
export const PALETTES = ['green', 'blue', 'pink', 'orange', 'purple'];

/** 版本号比较：a > b 返回正数。只按点分段比数字，够用且不引入依赖。 */
function compareVersions(a, b) {
  const left = String(a).split('.').map(Number);
  const right = String(b).split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const x = Number.isFinite(left[index]) ? left[index] : 0;
    const y = Number.isFinite(right[index]) ? right[index] : 0;
    if (x !== y) return x - y;
  }
  return 0;
}

const parseJson = (value, fallback) => {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

/** 用户设置：从数据库的字符串还原成有类型的对象。 */
/**
 * 单个标签的占比上限：设置里存百分数，算法里用 0~1。
 * 没设置过用默认 40%，超出范围夹回合法区间，避免脏数据把题单撑爆。
 */
function normalizeTagShare(value) {
  const percent = Number.isFinite(value) ? Math.min(90, Math.max(10, value)) : 40;
  return percent / 100;
}

function readSettings() {
  const raw = db.getSettings();
  return {
    handle: raw.handle ?? null,
    target: raw.target ? Number(raw.target) : null,
    weekly: raw.weekly ? Number(raw.weekly) : null,
    theme: THEMES.includes(raw.theme) ? raw.theme : 'dark',
    heatmapPalette: PALETTES.includes(raw.heatmap_palette) ? raw.heatmap_palette : 'green',
    // 每周固定休息的日子：0=周日 … 6=周六
    restDays: parseJson(raw.rest_days, []),
    // 特定日期无法做题：{ 'YYYY-MM-DD': '聚餐' }
    dayOff: parseJson(raw.day_off, {}),
    // 被收起的面板：{ 'panel-plan': true }
    collapsed: parseJson(raw.collapsed, {}),
    // 被整个隐藏的模块：['panel-virtual', ...]
    hiddenModules: parseJson(raw.hidden_modules, []),
    // 其他平台的账号
    nowcoderUid: raw.nowcoder_uid ?? null,
    luoguUid: raw.luogu_uid ?? null,
    // AtCoder 用户名（Kenkoooo 接口用的就是 AtCoder 上的用户名）
    atcoderUid: raw.atcoder_uid ?? null,
    // 训练计划里要不要混 AtCoder 的题。没勾就是全 Codeforces
    atcoderInPlan: raw.atcoder_in_plan === '1',
    // 训练计划里要不要混洛谷的题（题库要先抓过）
    luoguInPlan: raw.luogu_in_plan === '1',
      // 评估水平时忽略「比当前 rating 低多少分」以内的题（null = 用默认值）
      floorGap: raw.floor_gap === undefined ? null : Number(raw.floor_gap),
      // 单个标签在题单里的占比上限，存的是百分数（null = 用默认值 40）
      tagShare: raw.tag_share === undefined ? null : Number(raw.tag_share),
      // 训练计划里是否隐藏标签（题单不显示算法方向，自己判断）
      hideTags: raw.hide_tags === '1',
      // 每天打卡提醒的时间（'HH:MM'，null = 关闭）
      remindAt: raw.remind_at ?? null,
      // 今日卡片是否显示「补一个方向」（默认显示）
      extraAxis: raw.extra_axis !== '0',
      // 上一次提醒是哪天（'YYYY-MM-DD'），避免同一天反复弹
      remindLast: raw.remind_last ?? null,
      updatedAt: raw.updated_at ? Number(raw.updated_at) : null,
  };
}

// 挑题算法或默认参数的版本号。改动到「同一份设置会挑出不同结果」时 +1，
// 老的计划快照就自动失效、重挑一次。
// v3：改成「每天四档」——练手/进阶/提升/学习，并把区间上界抬到 center+500
//     来装下较高那两档。老计划里根本没有 2000 分以上的题，必须重挑一次。
// v4：四档改成「按方向 × 按档」显式分名额（以前会被标签上限刷歪，实测 99 题里
//     48 道挤在最高档，日题单后面就塌成「一天两道 1700」），区间下限也收到
//     练手档。老计划的题池是歪的，得重挑。
// v5：题单里可以混 AtCoder 的题（设置里勾选）。挑题多了一个平台维度，
//     同一份设置会挑出不同结果，老快照得重挑一次。
// v6：洛谷题也能进题单（设置里勾选），一天最多一道。挑题又变了一次，老计划重挑。
const PLAN_VERSION = 6;

/**
 * 计划指纹：这几个东西没变，就沿用上次那份计划。
 *
 * 故意不包含「做过的题」和「题库总数」——你做掉一道题、题库里多了新题，
 * 都不该把整份计划打乱重排。
 */
function planSignature({ weekly, settings, model, bandShift = 0 }) {
  return JSON.stringify({
    v: PLAN_VERSION,
    weekly: Number.isFinite(weekly) && weekly > 0 ? Math.round(weekly) : 10,
    floorGap: settings.floorGap ?? null,
    tagShare: settings.tagShare ?? null,
    atcoderInPlan: Boolean(settings.atcoderInPlan),
    luoguInPlan: Boolean(settings.luoguInPlan),
    modelTrainedAt: model?.trainedAt ?? null,
    modelActive: Boolean(model && modelModule.isModelUseful(model)),
    bandShift: Math.round(bandShift) || 0,
  });
}

/** 每完成这么多题，就重新看一次最近的表现。 */
const ADJUST_ROUND = 20;
/** 一轮一轮挪，最多上下各挪 150 分，免得越跑越偏。 */
const ADJUST_LIMIT = 150;

/**
 * 难度自适应：每完成一轮（20 题），按最近这一轮的表现把练习区间挪 50 分。
 *
 * 判据只看「首次通过前提交了几次」——这个数据在 submissions 里是现成的：
 *   - 平均 ≤1 次：基本是独立做出来的，往上挪 50
 *   - 平均 ≥3 次：卡得比较久，往下挪 50
 *   - 中间：不动
 *
 * 没做满一轮就什么都不改。挪动和理由都写进 plan_adjust，计划说明里会念出来。
 * 注意：这个只在「重新生成计划」时生效，不会动你手上这份计划。
 */
function evaluateBandAdjustment(handleKey, target, previousSnapshot, solved) {
  const state = db.getPlanAdjust(handleKey, target);
  if (!previousSnapshot) return { ...state, changed: false };

  // 口径是「一共新做出来多少道题」，不是「当前计划里打了几个勾」。
  // 因为重新生成计划以后，做过的题会离开计划，按计划算的话第二轮永远凑不满。
  const solvedCount = solved.size;
  const finished = Math.max(0, solvedCount - state.evaluatedDone);
  if (finished < ADJUST_ROUND) return { ...state, changed: false };

  const recent = [...solved.values()]
    .map((row) => ({ at: row?.at ?? 0, attempts: row?.attempts ?? 0 }))
    .sort((a, b) => b.at - a.at)
    .slice(0, ADJUST_ROUND);
  const avgAttempts = recent.reduce((sum, row) => sum + row.attempts, 0) / recent.length;

  let delta = 0;
  let how = '难度刚好，先不动';
  if (avgAttempts <= 1) {
    delta = 50;
    how = '基本是独立做出来的';
  } else if (avgAttempts >= 3) {
    delta = -50;
    how = '卡得比较久';
  }

  const shift = Math.max(-ADJUST_LIMIT, Math.min(ADJUST_LIMIT, state.shift + delta));
  const reason = `最近这一轮 ${recent.length} 题平均提交 ${avgAttempts.toFixed(1)} 次（${how}）`;
  db.savePlanAdjust(handleKey, target, shift, solvedCount, reason);
  return { shift, evaluatedDone: solvedCount, reason, delta, changed: true, avgAttempts };
}

/**
 * 题目年份偏好要用的「比赛 → 开始时间」表。
 * CF 的比赛在 contests 表里，AtCoder 的记在 atcoder_contests 里，合成一份给挑题用。
 */
function problemContestDates() {
  return new Map([
    ...db.getContests().map((contest) => [contest.id, contest.startTime]),
    ...db.listAtcoderContestDates(),
  ]);
}

/**
 * 只从题库记录里取「来源 / 题号 / 链接」这几项。
 * 屏蔽表、做题记录这类地方只存了题号，界面要按平台拼对的链接，就靠这几个字段。
 */
function pickProblemFields(problem) {
  if (!problem) return {};
  const client = toClientProblem(problem);
  return {
    platform: client.platform,
    code: client.code,
    url: client.url,
    nativeRating: client.nativeRating,
  };
}

/** 屏蔽列表：补上平台、题号、链接，界面才能按来源跳对地方。 */
function blockedPayload(handleKey) {
  const rows = db.listBlockedProblems(handleKey);
  const known = db.getProblemsByKeys(rows.map((row) => `${row.contestId}-${row.index}`));
  return rows.map((row) => ({
    ...row,
    ...pickProblemFields(known.get(`${row.contestId}-${row.index}`)),
  }));
}

async function handlePlan(url) {
  const rawHandle = url.searchParams.get('handle');
  const target = Number(url.searchParams.get('target'));
  const weekly = Number(url.searchParams.get('weekly') || 10);
  const force = url.searchParams.get('refresh') === '1';

  if (!rawHandle) return { status: 400, body: { error: '请先填写 Codeforces 用户名' } };
  if (!Number.isFinite(target) || target < 800 || target > 4000) {
    return { status: 400, body: { error: '目标 rating 需要在 800 到 4000 之间' } };
  }

  const problemsState = await ensureProblems();
  await loadUser(rawHandle, { force });
  const settings = readSettings();

  // 勾了 AtCoder 就先增量同步一次提交记录（6 小时内不重复抓）。
  // 同步失败不影响出计划：AtCoder 只是加菜，CF 那份计划照常给。
  let atcoderSync = null;
  if (settings.atcoderInPlan && settings.atcoderUid) {
    try {
      const handleKeyForAtcoder = db.normalizeHandle(rawHandle);
      atcoderSync = await syncAtcoderSubmissions(handleKeyForAtcoder, settings.atcoderUid, {
        force,
      });
      if (atcoderSync.cached) atcoderSync = null;
    } catch (error) {
      atcoderSync = { error: error.message };
    }
  }

  // 训练过的推题模型（可能没有，或者没通过验证）
  const model = modelModule.parseModel(db.metaGet(modelModule.MODEL_KEY));

  const handleKey = db.normalizeHandle(rawHandle);
  const user = db.getUser(handleKey);
  const submissions = db.getSubmissions(handleKey);
  const { solved, attempted } = deriveProgress(submissions);

  // ---- 这一版开始，计划会「钉住」----
  // 之前每次刷新都重新挑一遍：你做过的题会被悄悄换掉，计划一直在漂，
  // 也看不出自己做到哪了。现在只有设置变了、或者点了「重新生成计划」才重挑。
  const targetRounded = Math.round(target);
  const adjustState = db.getPlanAdjust(handleKey, targetRounded);
  const signature = planSignature({ weekly, settings, model, bandShift: adjustState.shift });
  // 旧快照不管强不强制都要读出来：一个是看能不能沿用，另一个是评估「你上一份做到哪了」。
  // （点「重新生成计划」时 force=true，但那时候恰恰最需要这份旧快照。）
  const previous = db.getPlanSnapshot(handleKey, targetRounded);
  const reusable = !force && previous && previous.signature === signature ? previous : null;

  // 要重挑的时候（第一次、换了设置、点了重新生成），顺便看要不要按表现挪区间。
  // 评估用的是重挑之前那份计划：你把它做到什么程度了，才算得出来。
  const adjust = reusable
    ? { ...adjustState, changed: false }
    : evaluateBandAdjustment(handleKey, targetRounded, previous, solved);
  const finalSignature = planSignature({ weekly, settings, model, bandShift: adjust.shift });
  const preferred = new Map();
  if (reusable) {
    let order = 0;
    for (const stage of reusable.stages ?? []) {
      for (const key of stage.keys ?? []) preferred.set(key, order++);
    }
  }

  const plan = buildPlan({
    user,
    solved,
    attempted,
    problems: allProblems(),
      target: targetRounded,
      weekly: Number.isFinite(weekly) && weekly > 0 ? Math.round(weekly) : 10,
      floorGap: settings.floorGap,
      // 设置里存的是百分数，算法里用 0~1 的比例
      tagShare: normalizeTagShare(settings.tagShare),
      model,
      // 题目年份偏好要用：老题在人气分上占便宜，靠比赛开始时间把新题提上来
      contestDates: problemContestDates(),
      // 勾了「加入 AtCoder 题」才按比例混进去，没勾就是纯 CF
      atcoderShare: settings.atcoderInPlan ? ATCODER_SHARE : 0,
      // 洛谷同理
      luoguShare: settings.luoguInPlan ? LUOGU_SHARE : 0,
      // 用户手动屏蔽的题，永远不再推荐
      blocked: new Set(db.blockedKeys(handleKey)),
      // 上一份计划里的题：优先保下来，做过的也留在原位
      preferred: preferred.size ? preferred : null,
      // 按最近一轮的表现整体挪过的练习区间
      // 再加上「做题手感」反馈：秒了的多就往上挪，看题解的多就往下挪（最多 ±50）
      bandShift: adjust.shift + db.feedbackShift(handleKey),
    });

  if (!reusable) {
    plan.generatedAt = db.savePlanSnapshot(
      handleKey,
      targetRounded,
      finalSignature,
      plan.stageList.map((stage) => ({
        index: stage.index,
        keys: stage.problems.map((problem) => `${problem.contestId}-${problem.index}`),
      })),
    );
  } else {
    plan.generatedAt = reusable.createdAt;
  }
  plan.reused = Boolean(reusable);

  // 每周记一次各方向水平，用来画成长曲线。这东西只能往后攒，早几周的数据补不回来。
  try {
    db.saveGrowthSnapshot(
      handleKey,
      weekStartKey(Math.floor(Date.now() / 1000)),
      (plan.axes ?? []).map((row) => ({
        axis: row.axis,
        representative: row.representative,
        count: row.count,
      })),
    );
  } catch {
    /* 快照记不上不该影响出计划 */
  }
  if (reusable) {
    plan.notes.unshift(
      `这份计划是 ${new Date(plan.generatedAt).toLocaleDateString('zh-CN')} 定下来的：做过的题会留在原位、自动打勾，不会被换成别的题。` +
        '想重新挑一批，点右上角的「重新生成计划」。',
    );
  }
  // AtCoder 那边抓失败时说清楚：这份计划里的 AtCoder 题是按上一次同步的记录挑的
  if (atcoderSync?.error) {
    plan.notes.unshift(
      `AtCoder 提交记录这次没同步上（${atcoderSync.error}）。计划里的 AtCoder 题按上一次同步的记录挑，` +
        '可能包含你已经做过的；到设置里点一次「同步 AtCoder」就能补上。',
    );
  }
  // 区间挪过就在说明里讲清楚：上一轮多少分到多少分，为什么挪
  if (adjust.changed && adjust.delta) {
    const band = plan.stageList[0]?.band ?? null;
    // 上一轮的区间 = 这一轮的区间往回退掉这次的增量（不是退掉累计的 shift）
    const before = band ? [band[0] - adjust.delta, band[1] - adjust.delta] : null;
    plan.notes.unshift(
      before
        ? `练习区间按你的表现调整了：上一轮练 ${before[0]}~${before[1]} 分，${adjust.reason}，这一轮改成 ${band[0]}~${band[1]} 分。`
        : `练习区间按你的表现调整了：${adjust.reason}。`,
    );
  }

  const done = db.getProgress(handleKey, targetRounded);

  // ---- 手动换过的题，按记录换回去 ----
  applyPlanSwaps(plan, handleKey, targetRounded);
  // ---- 手动「放到最后」的题，挪到本阶段末尾 ----
  applyPlanDefer(plan, handleKey, targetRounded);

  // ---- 给每道题补上「方向」和「年份」----
  // 题单筛选要用：方向来自 tag 归类，年份来自比赛开始时间。
  const contestDateMap = problemContestDates();
  for (const stage of plan.stageList ?? []) {
    stage.problems = stage.problems.map((problem) => {
      const axes = [...new Set((problem.tags ?? []).map((tag) => knowledgeAxis(tag)).filter(Boolean))];
      const startTime = contestDateMap.get(problem.contestId);
      return {
        ...problem,
        axes,
        year: startTime ? new Date(startTime * 1000).getFullYear() : null,
      };
    });
  }

  // ---- 自动打勾 ----
  // 提交记录里已经通过的题，直接在题单里打上勾；手动取消过的题（progress 里有
  // done=0 的记录）尊重用户的选择，不再自动勾上。
  const manual = db.getProgressMap(handleKey, targetRounded);
  const autoDone = [];
  for (const stage of plan.stageList ?? []) {
    for (const problem of stage.problems) {
      const key = `${problem.contestId}-${problem.index}`;
      if (solved.has(key) && !manual.has(key)) autoDone.push(key);
    }
  }
  const doneList = [...new Set([...done, ...autoDone])];

  // ---- 手动塞进某天的补题 ----
  // 这些不参与配额，只挂在某一天上；日程当天和「今天」卡片会一起列出来。
  const extraRows = db.listScheduleExtras(handleKey);
  const extrasByDate = {};
  if (extraRows.length) {
    const extraProblems = db.getProblemsByKeys(
      extraRows.map((row) => `${row.contestId}-${row.index}`),
    );
    for (const row of extraRows) {
      const problem = extraProblems.get(`${row.contestId}-${row.index}`);
      if (!problem) continue;
      (extrasByDate[row.date] ??= []).push({ ...toClientProblem(problem), extra: true });
    }
  }

  // ---- 「今天补一个方向」临时加的题 ----
  const extraTasksByDate = {};
  const extraToday = new Date().toLocaleDateString('sv-SE');
  for (const row of db.listAllExtraTasks(handleKey, extraToday)) {
    const problem = db.getProblemsByKeys([row.key]).get(row.key);
    if (!problem) continue;
    (extraTasksByDate[row.date] ??= []).push({ ...toClientProblem(problem), extra: true });
  }

  // ---- 赛前热身包 ----
  const inPlanKeys = new Set(
    (plan.stageList ?? []).flatMap((stage) =>
      stage.problems.map((problem) => `${problem.contestId}-${problem.index}`),
    ),
  );
  const warmup = pickWarmup({
    handleKey,
    solved,
    blocked: new Set(db.blockedKeys(handleKey)),
    inPlan: inPlanKeys,
    current: user?.rating && user.rating > 0 ? user.rating : 800,
  });

  return {
    status: 200,
    body: {
      user: {
        ...user,
        submissionCount: submissions.length,
        solvedCount: solved.size,
        ratingHistory: db.getRatingHistory(handleKey),
      },
      problemsState,
      done: doneList,
      doneAuto: autoDone,
      doneManual: done,
      swapCount: db.listPlanSwaps(handleKey, targetRounded).size,
      extras: extrasByDate,
      // 今天补一个方向临时加的题（按天分组）
      extraTasks: extraTasksByDate,
      // 做题手感反馈：界面上给每道题标「秒了/刚好/卡住/看题解」，并显示它把区间挪了多少
      feedback: db.listProblemFeedback(handleKey, 200),
      feedbackShift: db.feedbackShift(handleKey),
      // 24 小时内有比赛的话，给一套热身题
      warmup,
      // 复盘卡：最近 20 题 vs 再往前 20 题
      retro: buildRetroCard(handleKey),
      plan,
    },
  };
}

/** 某天所在自然周的周一（本地时间）。报告按周看，周一开始。 */
function weekStartKey(seconds) {
  const date = new Date(seconds * 1000);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const median = (numbers) => {
  if (!numbers.length) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * 某个账号的「各方向 75 分位」。多账号对比要用。
 *
 * 口径和训练计划里的一致：忽略比当前 rating 低一段的签到题，
 * 否则两个人做过多少签到题会直接影响对比结果。
 */
function axisProfileOf(handleKey) {
  const user = db.getUser(handleKey);
  const problems = allProblems();
  const { solved } = deriveProgress(db.getSubmissions(handleKey));
  const solvedProblems = problems.filter(
    (problem) => problem.rating && solved.has(`${problem.contestId}-${problem.index}`),
  );

  const current = user?.rating && user.rating > 0 ? user.rating : 800;
  const floorGap = readSettings().floorGap;
  const floorDistance = Number.isFinite(floorGap) && floorGap >= 0 ? floorGap : 400;
  const analysisFloor =
    floorDistance === 0 ? 800 : Math.max(800, Math.round((current - floorDistance) / 100) * 100);

  const tagProfile = buildTagProfile(solvedProblems, { floor: analysisFloor });
  return {
    user,
    solvedCount: solved.size,
    axes: buildKnowledgeProfile(solvedProblems, tagProfile, { floor: analysisFloor }),
  };
}

/**
 * 训练强度 × 比赛结果。
 *
 * 两件事：
 * 1. 按周统计做题量和平均难度（近 N 周），做一条曲线；
 * 2. 每场 rated 比赛，回头看它前两周做了多少题、平均多难，和这场涨跌分放一起。
 *
 * 「赛前两周没有训练记录」这种情况会明确写出来，不用猜。
 */
function buildGrowthReport(handleKey, weeks) {
  const submissions = db.getSubmissions(handleKey);
  const { solved } = deriveProgress(submissions);
  const problemMap = new Map(allProblems().map((problem) => [`${problem.contestId}-${problem.index}`, problem]));

  const solvedRows = [...solved.entries()].map(([key, info]) => ({
    key,
    at: info?.at ?? 0,
    rating: problemMap.get(key)?.rating ?? null,
  }));

  // 按周归集：这周首次通过了多少题、平均难度多少
  const buckets = new Map();
  for (const row of solvedRows) {
    if (!row.at) continue;
    const week = weekStartKey(row.at);
    const bucket = buckets.get(week) ?? { solved: 0, ratingSum: 0, ratingCount: 0 };
    bucket.solved += 1;
    if (row.rating) {
      bucket.ratingSum += row.rating;
      bucket.ratingCount += 1;
    }
    buckets.set(week, bucket);
  }

  const now = new Date();
  const series = [];
  for (let back = weeks - 1; back >= 0; back -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back * 7);
    const week = weekStartKey(Math.floor(date.getTime() / 1000));
    const bucket = buckets.get(week) ?? { solved: 0, ratingSum: 0, ratingCount: 0 };
    series.push({
      week,
      solved: bucket.solved,
      avgRating: bucket.ratingCount ? Math.round(bucket.ratingSum / bucket.ratingCount) : null,
    });
  }

  // 比赛：涨跌分用「这次赛后分 − 上场赛后分」算，两场之间没有别的比赛，所以是准的
  const history = db.getRatingHistory(handleKey);
  const windowSeconds = 14 * 86400;
  const oldestWeek = series[0]?.week ?? '';
  const weeklyMedian = median(series.filter((row) => row.solved > 0).map((row) => row.solved));

  const contests = [];
  let previousRating = null;
  for (const entry of history) {
    const delta = previousRating == null || entry.rating == null ? null : entry.rating - previousRating;
    if (entry.rating != null) previousRating = entry.rating;
    const at = entry.at ?? 0;
    const before = solvedRows.filter((row) => row.at > at - windowSeconds && row.at <= at);
    const ratedBefore = before.filter((row) => row.rating);
    const avgRatingBefore = ratedBefore.length
      ? Math.round(ratedBefore.reduce((sum, row) => sum + row.rating, 0) / ratedBefore.length)
      : null;

    // 比的是「两周的量」：平时的周中位数 ×2 才是这两周的期望值，
    // 直接拿两周的量和一周的中位数比，几乎人人都成了「练得多」。
    const expected = weeklyMedian * 2;
    let tag;
    if (!before.length) tag = '赛前两周没有训练记录';
    else if (expected && before.length >= expected * 1.5) tag = '赛前练得比平时多';
    else if (expected && before.length <= expected * 0.5) tag = '赛前练得比平时少';
    else tag = '赛前训练量和平时差不多';

    contests.push({
      contestId: entry.contestId,
      name: entry.name,
      at,
      rating: entry.rating,
      delta,
      solvedBefore: before.length,
      avgRatingBefore,
      tag,
      week: weekStartKey(at),
    });
  }
  // 只留曲线覆盖范围内的比赛
  const recentContests = contests.filter((contest) => contest.week >= oldestWeek);

  // 方向成长：每周一份快照，攒够两份才能看变化
  const snapshots = db.listGrowthSnapshots(handleKey, 12);
  const axisTrend = [];
  if (snapshots.length >= 2) {
    const first = snapshots[0];
    const last = snapshots[snapshots.length - 1];
    const before = new Map((first.axes ?? []).map((row) => [row.axis, row.representative]));
    for (const row of last.axes ?? []) {
      const was = before.get(row.axis);
      if (was == null || row.representative == null || row.count === 0) continue;
      axisTrend.push({
        axis: row.axis,
        before: was,
        now: row.representative,
        change: row.representative - was,
      });
    }
    axisTrend.sort((a, b) => b.change - a.change);
  }

  // 一句话结论：把「赛前练得多」和「这一场涨了多少分」放一起看。
  // 只是描述你这份数据，不做因果断言——比赛难度不同，样本也就几十场。
  const heavy = recentContests.filter((row) => (row.solvedBefore ?? 0) >= 8);
  const light = recentContests.filter((row) => (row.solvedBefore ?? 0) < 8);
  const avgDelta = (list) =>
    list.length ? Math.round(list.reduce((sum, row) => sum + (row.delta ?? 0), 0) / list.length) : null;
  let conclusion = null;
  if (heavy.length >= 3 && light.length >= 3) {
    const hot = avgDelta(heavy);
    const cold = avgDelta(light);
    const gap = hot - cold;
    conclusion =
      gap >= 8
        ? `赛前两周做满 8 题的 ${heavy.length} 场，平均涨 ${hot} 分；练得少的 ${light.length} 场平均 ${cold} 分——练得多的那几场更稳。`
        : gap <= -8
          ? `赛前做满 8 题的 ${heavy.length} 场平均 ${hot} 分，练得少的 ${light.length} 场平均 ${cold} 分，反而是练得少的成绩好——多半是那几场难度更低，别急着改训练量。`
          : `赛前练多练少的平均涨跌差不多（${hot} / ${cold} 分），目前看不出训练量和涨分的直接关系。`;
  }

  return {
    weeks: series,
    contests: recentContests,
    conclusion,
    axisTrend,
    axisSnapshots: snapshots.length,
    summary: {
      weeks: series.length,
      solved: series.reduce((sum, row) => sum + row.solved, 0),
      avgRating: (() => {
        const rated = series.filter((row) => row.avgRating);
        return rated.length ? Math.round(rated.reduce((sum, row) => sum + row.avgRating, 0) / rated.length) : null;
      })(),
      contests: recentContests.length,
      delta: recentContests.reduce((sum, row) => sum + (row.delta ?? 0), 0),
      weeklyMedian,
    },
  };
}

/**
 * 补题队列：提交过但没通过的题。
 *
 * 数据来自 submissions，所以「补完自动出队」不用额外记账——做出来了它就不在
 * 「没通过」里了。这里只额外排掉两种：手动点过「已补」的、以及被屏蔽的。
 *
 * 排序默认按搁置时间（最久没碰的排前面），也可以按难度排。
 */
function buildReviewQueue(handleKey, sort) {
  const submissions = db.getSubmissions(handleKey);
  const { solved, attempted } = deriveProgress(submissions);

  // 每道没通过的题，最后一次提交是什么时候
  const lastAt = new Map();
  for (const row of submissions) {
    const key = `${row.contestId}-${row.index}`;
    if (!attempted.has(key)) continue;
    const at = row.createdAt ?? 0;
    if ((lastAt.get(key) ?? 0) < at) lastAt.set(key, at);
  }

  const skip = db.listReviewDone(handleKey);
  const blocked = new Set(db.blockedKeys(handleKey));
  const keys = [...attempted.keys()].filter((key) => !skip.has(key) && !blocked.has(key));
  const problems = db.getProblemsByKeys(keys);
  // 题库里查不到的题（gym、很早的比赛）没有难度也没有标签，排进队列也没法用来练：
  // 直接不列，只把数量报给界面。以前的写法是显示一行「题库里没有这道题」，那是噪音。
  const known = keys.filter((key) => problems.has(key));
  const missing = keys.length - known.length;
  const now = Math.floor(Date.now() / 1000);

  const items = known.map((key) => {
    const problem = problems.get(key);
    const at = lastAt.get(key) ?? null;
    const contestId = Number(key.slice(0, key.indexOf('-')));
    const index = key.slice(key.indexOf('-') + 1);
    return {
      contestId,
      index,
      name: problem.name,
      rating: problem.rating ?? null,
      tags: problem.tags ?? [],
      // 来源和链接都要分平台：AtCoder 的题号是 abc300_e，链接也在 atcoder.jp
      platform: problem.platform ?? 'codeforces',
      code: problemCode(problem),
      nativeRating: problem.nativeRating ?? null,
      url: problemUrl(problem),
      attempts: attempted.get(key) ?? 0,
      lastAt: at,
      idleDays: at ? Math.max(0, Math.round((now - at) / 86400)) : null,
    };
  });

  if (sort === 'rating') items.sort((a, b) => (a.rating ?? 9999) - (b.rating ?? 9999));
  else if (sort === 'rating-desc') items.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  else items.sort((a, b) => (a.lastAt ?? 0) - (b.lastAt ?? 0));
  return { items, missing };
}

/**
 * 题库浏览的筛选：把 URL 上的条件翻译成一批题。
 *
 * 题量一万六千出头，全在内存里（allProblems 有缓存），一次筛选几毫秒，够用。
 * 「做没做过」用 deriveProgress 算一遍——这个页面要看的就是「这题我做过没」。
 */
function filterProblemBank(url) {
  const handleKey = db.normalizeHandle(url.searchParams.get('handle'));
  let solved = new Map();
  let attempted = new Map();
  if (handleKey) {
    const progress = deriveProgress(db.getSubmissions(handleKey));
    solved = progress.solved;
    attempted = progress.attempted;
  }

  const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
  const from = Number(url.searchParams.get('from') || 0);
  const to = Number(url.searchParams.get('to') || 0);
  const tags = (url.searchParams.get('tags') ?? '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
  const platform = url.searchParams.get('platform') ?? 'all';
  // 通过状态：all / todo（没做过）/ done（做过的）。老的 todo=1 仍然认
  const state =
    url.searchParams.get('state') ?? (url.searchParams.get('todo') === '1' ? 'todo' : 'all');

  let rows = allProblems().filter((problem) => problem.type === 'PROGRAMMING');
  if (platform !== 'all') {
    rows = rows.filter((problem) => (problem.platform ?? 'codeforces') === platform);
  }
  // 不填难度区间就不筛。填了才按区间来（没难度的题会被排除，它们没法判断难易）
  if (from) rows = rows.filter((problem) => (problem.rating ?? -1) >= from);
  if (to) rows = rows.filter((problem) => (problem.rating ?? -1) <= to);
  if (tags.length) {
    rows = rows.filter((problem) => (problem.tags ?? []).some((tag) => tags.includes(tag)));
  }
  if (state === 'todo') {
    rows = rows.filter((problem) => !solved.has(`${problem.contestId}-${problem.index}`));
  } else if (state === 'done') {
    rows = rows.filter((problem) => solved.has(`${problem.contestId}-${problem.index}`));
  }
  if (q) {
    rows = rows.filter(
      (problem) =>
        problemCode(problem).toLowerCase().includes(q) || problem.name.toLowerCase().includes(q),
    );
  }
  return { rows, solved, attempted };
}

/**
 * 把题库按「比赛」分组，拼出比赛页要的数据。
 *
 * 一场比赛 = 题库里同一个 contest_id 的一批题。Codeforces 的名字和时间在 contests 表里；
 * AtCoder 的时间在 atcoder_contests 表里、名字就用它的比赛 id（abc478 → ABC478）。
 * 洛谷不参与——它的内部 id 是每题一个，没有比赛这个层级。
 */
function collectContests(url) {
  const handleKey = db.normalizeHandle(url.searchParams.get('handle'));
  let solved = new Map();
  if (handleKey) solved = deriveProgress(db.getSubmissions(handleKey)).solved;

  const cfInfo = new Map(db.getContests().map((contest) => [contest.id, contest]));
  // 这个函数返回的就是 [contestId, startTime] 数组对，直接塞进 Map
  const atcoderTimes = new Map(db.listAtcoderContestDates());

  const groups = new Map();
  for (const problem of allProblems()) {
    if (problem.type !== 'PROGRAMMING' || problem.platform === 'luogu') continue;
    let group = groups.get(problem.contestId);
    if (!group) {
      group = {
        contestId: problem.contestId,
        platform: problem.platform ?? 'codeforces',
        problems: [],
      };
      groups.set(problem.contestId, group);
    }
    group.problems.push(problem);
  }

  const rows = [];
  for (const group of groups.values()) {
    group.problems.sort((a, b) => a.index.localeCompare(b.index));
    const first = group.problems[0];
    const cf = cfInfo.get(group.contestId);
    const nativeContest = first.nativeContest ?? '';
    const atcoderKind = nativeContest.match(/^(abc|arc|agc)/i);
    const name = cf?.name ?? (nativeContest ? nativeContest.toUpperCase() : `比赛 ${group.contestId}`);
    const startTime = cf?.startTime ?? atcoderTimes.get(group.contestId) ?? 0;
    const kind = cf
      ? parseContestInfo(cf.name).division
      : atcoderKind
        ? atcoderKind[1].toUpperCase()
        : '其他';

    const problems = group.problems.map((problem) => ({
      index: problem.index,
      code: problemCode(problem),
      name: problem.name,
      rating: problem.rating ?? null,
      url: problemUrl(problem),
      solved: solved.has(`${problem.contestId}-${problem.index}`),
    }));

    rows.push({
      contestId: group.contestId,
      platform: group.platform,
      name,
      kind,
      startTime,
      url: cf
        ? `https://codeforces.com/contest/${group.contestId}`
        : `https://atcoder.jp/contests/${nativeContest}`,
      solvedCount: problems.filter((problem) => problem.solved).length,
      problems,
    });
  }
  return { rows, solved };
}

/** 题号 → 题目。复制粘贴过来的题单要认题号，这里把题库里的题号建一份索引。 */
function problemCodeIndex() {
  const index = new Map();
  for (const problem of allProblems()) {
    if (problem.type !== 'PROGRAMMING') continue;
    index.set(problemCode(problem).toUpperCase(), problem);
    // AtCoder 的正题号（abc476_d）和洛谷的原题号（P4170）也一起进索引
    if (problem.nativeId) index.set(String(problem.nativeId).toUpperCase(), problem);
  }
  return index;
}

/**
 * 把一段文本解析成题号列表。
 *
 * 用户贴过来的东西五花八门：可能是「拼好题」导出的 Markdown（带题目链接）、
 * 可能是从别处复制的「2173A Sleeping Through Classes」、也可能是洛谷题号 P4170。
 * 所以先按链接抓，再按裸题号抓，最后拿题库索引对齐；对不上的返回给界面提示，
 * 免得用户以为「我贴了十条怎么只进来六条」。
 *
 * AtCoder 的题号统一补零到三位（ABC25C 和 ABC025C 都认）。
 */
function parseProblemText(text) {
  const index = problemCodeIndex();
  const found = new Map(); // key -> problem
  const unresolved = new Set();

  const add = (candidate) => {
    const key = String(candidate).toUpperCase();
    const problem = index.get(key);
    if (problem) found.set(`${problem.contestId}-${problem.index}`, problem);
    // 只把「看着像题号、但题库里没有」的报给用户，标题行之类的噪音不报
    else unresolved.add(key);
  };

  // 一行一行来：先看这一行有没有链接（链接里的信息最准），没有再退到裸题号
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let hit = false;
    const before = found.size;

    const cfUrl = line.match(/codeforces\.com\/(?:problemset\/problem|contest)\/(\d+)\/(?:problem\/)?([A-Za-z]\d?)/);
    if (cfUrl) {
      add(`${cfUrl[1]}${cfUrl[2].toUpperCase()}`);
      hit = hit || found.size > before;
    }

    const atUrl = line.match(/atcoder\.jp\/contests\/([a-z0-9_]+)\/tasks\/([a-z0-9_]+)/i);
    if (atUrl) {
      add(atUrl[2].toUpperCase());
      hit = hit || found.size > before;
    }

    const lgUrl = line.match(/luogu\.com\.cn\/problem\/([A-Za-z]+\d+)/i);
    if (lgUrl) {
      add(lgUrl[1].toUpperCase());
      hit = hit || found.size > before;
    }

    if (!hit) {
      for (const match of line.matchAll(/\b(ABC|ARC|AGC)(\d{2,3})([A-Z])\b/gi)) {
        add(`${match[1].toUpperCase()}${match[2].padStart(3, '0')}${match[3].toUpperCase()}`);
      }
      for (const match of line.matchAll(/\bCF(\d+)([A-Z]\d?)\b/gi)) {
        add(`${match[1]}${match[2].toUpperCase()}`);
      }
      for (const match of line.matchAll(/\b([PB]\d{3,5})\b/g)) {
        add(match[1].toUpperCase());
      }
      for (const match of line.matchAll(/\b(\d{1,4})([A-Z]\d?)\b/g)) {
        add(`${match[1]}${match[2].toUpperCase()}`);
      }
    }
  }

  // 题库里对上的题不算「没认出来」，哪怕前面 add 过
  const resolvedKeys = new Set(
    [...found.values()].flatMap((p) => [problemCode(p).toUpperCase(), String(p.nativeId ?? '').toUpperCase()]),
  );
  const unmatched = [...unresolved].filter((key) => key && !resolvedKeys.has(key));

  return {
    items: [...found.values()].map((p) => ({ contestId: p.contestId, index: p.index })),
    unmatched,
  };
}

/** 没起名字时按时间和题数给一个，比如「题单 9/28 15:30 · 11 题」。 */
function defaultListName(count) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `题单 ${now.getMonth() + 1}/${now.getDate()} ${pad(now.getHours())}:${pad(now.getMinutes())} · ${count} 题`;
}

/**
 * 拼好题：一场没打过的 CF + 一场没打过的 AtCoder，凑成一套。
 *
 * 为什么要拼：单打一场 CF Div.2 才 6 题、一场 ABC 七八题，都不够一场区域赛的量；
 * 两场拼起来十几题，两边的难度分布也不同，练起来有起伏。
 *
 * 「没打过」按有没有提交记录判断——只看通过会把「打过但零通过」的场次算成没打过。
 * 只从最近 N 个月里挑：太久远的题难度标定和现在不一样，练了意义不大；
 * 但每次都取最新那一场又会一直重复，所以在最近的 60 场候选里随机取一场。
 */
function buildMashup(url) {
  const handleKey = db.normalizeHandle(url.searchParams.get('handle'));
  const { rows } = collectContests(url);
  const submissions = handleKey ? db.getSubmissions(handleKey) : [];
  const played = new Set(submissions.map((row) => row.contestId));

  const months = Math.min(36, Math.max(3, Number(url.searchParams.get('months') || 18)));
  const now = Math.floor(Date.now() / 1000);
  const since = now - months * 30 * 86400;
  const wantCf = url.searchParams.get('cf') || 'any';
  const wantAt = url.searchParams.get('at') || 'any';

  const candidates = (kind) =>
    rows
      .filter((contest) => contest.startTime >= since && contest.startTime <= now)
      .filter((contest) => !played.has(contest.contestId))
      .filter((contest) => contest.problems.length >= 4)
      .filter((contest) => (kind === 'any' ? true : contest.kind === kind))
      .sort((a, b) => b.startTime - a.startTime);

  const roll = (kind) => {
    const pool = candidates(kind);
    if (!pool.length) return { contest: null, size: 0 };
    // 最近的 60 场里随机：既保证够近，又不会每次都同一套
    const recent = pool.slice(0, 60);
    return { contest: recent[Math.floor(Math.random() * recent.length)], size: pool.length };
  };

  // 指定的类别最近正好没有没打过的场次时，退回「随便哪一类」，并在界面上说一声，
  // 免得用户选了半天只得到一句「没有符合条件的比赛」
  const rollWithFallback = (kind) => {
    const direct = roll(kind);
    if (direct.contest || kind === 'any') return { ...direct, fellBack: false };
    const fallback = roll('any');
    return { ...fallback, fellBack: Boolean(fallback.contest) };
  };

  // CF 先挑，AtCoder 再挑；两边互相不认识，拼在一起才有难度起伏
  const cfRoll = wantCf === 'none' ? { contest: null, size: 0 } : rollWithFallback(wantCf);
  const atRoll = wantAt === 'none' ? { contest: null, size: 0 } : rollWithFallback(wantAt);

  const problems = [];
  for (const contest of [cfRoll.contest, atRoll.contest]) {
    if (!contest) continue;
    for (const problem of contest.problems) {
      problems.push({ ...problem, contestName: contest.name, platform: contest.platform });
    }
  }
  // 按难度排：这套题要按由易到难做，没难度的排最后
  problems.sort((a, b) => (a.rating ?? 99999) - (b.rating ?? 99999));
  const rated = problems.filter((problem) => problem.rating != null);

  return {
    cf: cfRoll.contest,
    atcoder: atRoll.contest,
    problems,
    total: problems.length,
    months,
    pool: { cf: cfRoll.size, atcoder: atRoll.size },
    fellBack: { cf: Boolean(cfRoll.fellBack), atcoder: Boolean(atRoll.fellBack) },
    ratingRange: rated.length ? [rated[0].rating, rated[rated.length - 1].rating] : null,
  };
}

/** 分类按钮上要显示的数量。 */
function contestKinds(rows) {
  const counts = {};
  for (const row of rows) counts[row.kind] = (counts[row.kind] ?? 0) + 1;
  return counts;
}

/** 题库列表的排序。按难度排时把没难度的题丢最后，否则它们会跟最简单的题挤在一起。 */
function sortProblemRows(rows, sort) {
  if (sort === 'rating-desc') {
    rows.sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1));
  } else if (sort === 'solved') {
    rows.sort((a, b) => (b.solvedCount ?? 0) - (a.solvedCount ?? 0));
  } else if (sort === 'newest') {
    rows.sort((a, b) => b.contestId - a.contestId || a.index.localeCompare(b.index));
  } else {
    rows.sort((a, b) => (a.rating ?? 99999) - (b.rating ?? 99999) || a.contestId - b.contestId);
  }
  return rows;
}

/**
 * 把用户手动换过的题，按记录换回去。
 *
 * 换进来的那道题如果已经不满足条件（被屏蔽、被别的槽位占了、题库里没有了），
 * 就保留原题——宁可回到默认推荐，也不要在计划里出现重复或失效的题。
 */
function applyPlanSwaps(plan, handleKey, target) {
  const swaps = db.listPlanSwaps(handleKey, target);
  if (!swaps.size) return plan;

  const blocked = new Set(db.blockedKeys(handleKey));
  const inPlan = new Set();
  for (const stage of plan.stageList ?? []) {
    for (const problem of stage.problems) inPlan.add(`${problem.contestId}-${problem.index}`);
  }

  const replacements = db.getProblemsByKeys([...swaps.values()]);
  for (const stage of plan.stageList ?? []) {
    stage.problems = stage.problems.map((problem) => {
      const fromKey = `${problem.contestId}-${problem.index}`;
      const toKey = swaps.get(fromKey);
      if (!toKey) return problem;
      const row = replacements.get(toKey);
      if (!row || blocked.has(toKey) || inPlan.has(toKey)) return problem;
      inPlan.delete(fromKey);
      inPlan.add(toKey);
      return { ...toClientProblem(row), swappedFrom: fromKey };
    });
  }
  return plan;
}

/**
 * 换一道题：同方向、难度最接近、你还没做过、也不在现有计划里。
 *
 * 题目星级/难度差优先，其次挑通过人数多的（更接近「标准题」而不是偏题怪题）。
 * 难度差硬卡在 100 分以内：放太宽就不是「换一道差不多的」了，
 * 那种情况下更该屏蔽这道题，而不是让推荐算法硬凑。
 */
function pickReplacement({ from, exclude, handleKey }) {
  const blocked = new Set(db.blockedKeys(handleKey));
  const fromAxes = new Set((from.tags ?? []).map((tag) => knowledgeAxis(tag)).filter(Boolean));
  const fromAtcoder = from.platform === 'atcoder';
  const candidates = allProblems().filter((problem) => {
    if (problem.rating == null || from.rating == null) return false;
    const key = `${problem.contestId}-${problem.index}`;
    if (key === `${from.contestId}-${from.index}`) return false;
    if (exclude.has(key) || blocked.has(key)) return false;
    // AtCoder 的题没有算法标签，没法按方向找替代，就按「同一个平台 + 难度接近」换
    if (fromAtcoder) return problem.platform === 'atcoder';
    if (problem.platform === 'atcoder') return false;
    const axes = (problem.tags ?? []).map((tag) => knowledgeAxis(tag)).filter(Boolean);
    return axes.some((axis) => fromAxes.has(axis));
  });
  if (!candidates.length) return null;

  return (
    candidates
      .filter((problem) => Math.abs(problem.rating - from.rating) <= 100)
      .sort((a, b) => {
        const diff = Math.abs(a.rating - from.rating) - Math.abs(b.rating - from.rating);
        if (diff !== 0) return diff;
        return (b.solvedCount ?? 0) - (a.solvedCount ?? 0);
      })[0] ?? null
  );
}

/**
 * 把「放到本轮最后」的题挪到它所在阶段的末尾。
 *
 * 只调这一阶段内的顺序，不动配额、不动别的题；顺序变了日程安排也就跟着变，
 * 所以这不是「只改显示」。
 */
function applyPlanDefer(plan, handleKey, target) {
  const deferred = db.listPlanDefer(handleKey, target);
  if (!deferred.size) return plan;
  for (const stage of plan.stageList ?? []) {
    const kept = [];
    const moved = [];
    for (const problem of stage.problems) {
      const key = `${problem.contestId}-${problem.index}`;
      if (deferred.has(key)) moved.push({ ...problem, deferred: true });
      else kept.push(problem);
    }
    stage.problems = [...kept, ...moved];
  }
  return plan;
}

/**
 * 「今天补一个方向」：在用户当前水平附近挑几道指定方向的题。
 * 难度取 [当前-200, 当前+300]，跳过做过的、屏蔽的、计划里已经有的。
 */
function pickAxisExtras({ handleKey, axis, count = 3, exclude = new Set() }) {
  const user = db.getUser(handleKey);
  const current = user?.rating && user.rating > 0 ? user.rating : 800;
  const { solved } = deriveProgress(db.getSubmissions(handleKey));
  const blocked = new Set(db.blockedKeys(handleKey));

  return allProblems()
    .filter((problem) => {
      if (problem.type !== 'PROGRAMMING' || problem.rating == null) return false;
      if (problem.rating < current - 200 || problem.rating > current + 300) return false;
      const key = `${problem.contestId}-${problem.index}`;
      if (solved.has(key) || blocked.has(key) || exclude.has(key)) return false;
      return (problem.tags ?? []).some((tag) => knowledgeAxis(tag) === axis);
    })
    .sort((a, b) => (b.solvedCount ?? 0) - (a.solvedCount ?? 0))
    .slice(0, count);
}

/**
 * 复盘卡：最近 20 道通过的题，和再往前 20 道比。
 * 看的是三件事：平均难度有没有上去、一次通过的比例、这 20 题压在哪些方向。
 */
function buildRetroCard(handleKey) {
  const { solved } = deriveProgress(db.getSubmissions(handleKey));
  const problemMap = new Map(
    allProblems().map((problem) => [`${problem.contestId}-${problem.index}`, problem]),
  );
  const rows = [...solved.entries()]
    .map(([key, info]) => ({ at: info.at, attempts: info.attempts, problem: problemMap.get(key) }))
    .filter((row) => row.problem?.rating)
    .sort((a, b) => b.at - a.at);

  const summarize = (list) => {
    if (!list.length) return null;
    const avgRating = Math.round(
      list.reduce((sum, row) => sum + row.problem.rating, 0) / list.length,
    );
    const oneShot = Math.round(
      (list.filter((row) => (row.attempts ?? 0) === 0).length / list.length) * 100,
    );
    const axes = {};
    for (const row of list) {
      for (const tag of row.problem.tags ?? []) {
        const axis = knowledgeAxis(tag);
        if (axis) {
          axes[axis] = (axes[axis] ?? 0) + 1;
          break;
        }
      }
    }
    const topAxes = Object.entries(axes)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([axis, count]) => ({ axis, count }));
    return { count: list.length, avgRating, oneShot, topAxes };
  };

  const current = summarize(rows.slice(0, 20));
  const previous = summarize(rows.slice(20, 40));
  return {
    current,
    previous,
    delta: current && previous ? current.avgRating - previous.avgRating : null,
    oneShotDelta: current && previous ? current.oneShot - previous.oneShot : null,
  };
}

/**
 * 赛前热身包：24 小时内有 rated 比赛时，挑 1~2 道比当前水平低一点的题。
 * 比赛当天做新知识点没什么意义，热身一下手感更实在。
 */
function pickWarmup({ handleKey, solved, blocked, inPlan, current }) {
  const now = Math.floor(Date.now() / 1000);
  const soon = db
    .getContests()
    .filter((contest) => contest.type === 'CF' && contest.startTime > now && contest.startTime - now < 24 * 3600)
    .sort((a, b) => a.startTime - b.startTime)[0];
  if (!soon) return null;

  const picked = allProblems()
    .filter((problem) => {
      if (problem.type !== 'PROGRAMMING' || problem.rating == null) return false;
      if (problem.rating > current - 50 || problem.rating < current - 300) return false;
      const key = `${problem.contestId}-${problem.index}`;
      return !solved.has(key) && !blocked.has(key) && !inPlan.has(key);
    })
    .sort((a, b) => (b.solvedCount ?? 0) - (a.solvedCount ?? 0))
    .slice(0, 2);
  if (!picked.length) return null;

  return {
    contest: { id: soon.id, name: soon.name, startTime: soon.startTime },
    problems: picked.map(toClientProblem),
  };
}

function decorateContest(contest) {
  return {
    id: contest.id,
    name: contest.name,
    division: parseContestInfo(contest.name).division,
    startTime: contest.startTime,
    durationSeconds: contest.duration,
    url: `https://codeforces.com/contest/${contest.id}`,
  };
}

/** 比赛日历：未来一段时间内已公布赛程的 Codeforces 比赛。 */
/**
 * 洛谷 / AtCoder 的赛程。
 *
 * 这两家都不给「官方赛程接口」：AtCoder 只能抓 /contests/ 那张 HTML 表，
 * 洛谷有 _contentOnly=1 的半公开 JSON。都缓存 12 小时，只在打开比赛日历、
 * 缓存过期时才请求；抓不到就退回上一次的缓存，页面照常用 Codeforces 的赛程。
 * 失败也记一个「尝试时间」，半小时内不重复试，免得断网时每次打开都等几秒。
 */
const EXTERNAL_CONTEST_CACHE_MS = 1000 * 60 * 60 * 12;
const EXTERNAL_RETRY_MS = 1000 * 60 * 30;
const CALENDAR_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) acm-trainer';

async function loadExternalContests(source) {
  const key = `external_contests_${source}`;
  const cached = parseJson(db.metaGet(key), []);
  const updatedAt = Number(db.metaGet(`${key}_updated_at`) || 0);
  const attemptedAt = Number(db.metaGet(`${key}_attempted_at`) || 0);
  if (cached.length && isFresh(updatedAt, EXTERNAL_CONTEST_CACHE_MS)) return cached;
  if (isFresh(attemptedAt, EXTERNAL_RETRY_MS)) return cached;

  db.metaSet(`${key}_attempted_at`, Date.now());
  try {
    const list = source === 'luogu' ? await fetchLuoguContests() : await fetchAtCoderContests();
    if (list.length) {
      db.metaSet(key, JSON.stringify(list));
      db.metaSet(`${key}_updated_at`, Date.now());
      return list;
    }
  } catch (error) {
    console.warn(`[calendar] ${source} 赛程抓取失败：${error.message}`);
  }
  return cached;
}

/**
 * 从洛谷返回的正文里挖出比赛列表。
 *
 * 这个接口**必须带 cookie**：不带的话洛谷会一直 302，fetch 直接报 fetch failed
 * （实测 2026-09：裸 fetch 必挂，接下 set-cookie 再请求就 200）。所以调用方要走
 * fetchLuoguText，它负责把服务器下发的 cookie 带上再请求一次。
 *
 * 拿回来的其实是 HTML（就算带 _contentOnly=1 也是 HTML，实测三种 Accept 都一样），
 * 数据嵌在 <script id="lentille-context"> 那段 JSON 里。顺手兼容一下真给 JSON 的情况，
 * 免得哪天洛谷改了行为整块功能直接空掉。
 *
 * 实测字段（2026-09）：id / startTime / endTime / name / method / visibility /
 * invitationCodeType / rated / host / squad / problemCount。列表按开赛时间**倒序**，
 * 第一页 20 条就从最近一场往回排，往后翻全是已经打完的比赛，所以只取第一页。
 */
function parseLuoguContests(text) {
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    const block = text.match(
      /<script id="lentille-context" type="application\/json">([\s\S]*?)<\/script>/,
    );
    if (block) {
      try {
        payload = JSON.parse(block[1]);
      } catch {
        throw new Error('洛谷赛程数据解析失败');
      }
    }
  }
  if (!payload) throw new Error('洛谷页面里没找到赛程数据，可能页面结构变了或者被风控拦了');
  // 纯 JSON 接口挂在 currentData 下，HTML 里那段挂在 data 下
  const node = payload.currentData ?? payload.data ?? payload;
  return Array.isArray(node?.contests?.result) ? node.contests.result : [];
}

/** 洛谷赛程：contest/list?_contentOnly=1。 */
async function fetchLuoguContests() {
  const html = await fetchLuoguText('https://www.luogu.com.cn/contest/list?_contentOnly=1');
  const rows = parseLuoguContests(html);

  // 洛谷只要 rated 的场次。rated 是**数字**不是布尔：实测官方 rated 场次是 3、
  // ICPC 区域赛重现赛是 1、不计分的娱乐赛是 0，所以按数值判断，0 才丢掉。
  // 万一哪天这个字段整个没了，退回「时长 ≥ 2 小时」当正式赛，别把列表抓空。
  const valid = rows.filter((row) => row?.startTime && row?.endTime && row?.name);
  const hasRatedFlag = valid.some((row) => row.rated !== undefined || row.ratedLimit !== undefined);
  return valid
    .filter((row) => {
      if (hasRatedFlag) return Number(row.rated ?? row.ratedLimit ?? 0) > 0;
      return Number(row.endTime) - Number(row.startTime) >= 2 * 3600;
    })
    .map((row) => ({
      id: `luogu-${row.id}`,
      name: row.name,
      startTime: Number(row.startTime),
      durationSeconds: Math.max(0, Number(row.endTime) - Number(row.startTime)),
      url: `https://www.luogu.com.cn/contest/${row.id}`,
      source: 'luogu',
    }));
}

/** AtCoder 赛程：没有接口，抓 /contests/ 里 upcoming 那张表。 */
/**
 * AtCoder 赛程：抓 atcoder.jp/contests/ 里 upcoming 那张表。
 *
 * 试过改用 Kenkoooo 的 contests.json（和题目、提交记录同一个来源），不行：那份文件是它自己的
 * 批处理生成的，实测 2026-09-28 最新一条停在 9/27，**未来一场都没有**，拿它当赛程会直接把日历搞空。
 * 官方这张表反而更全，而且带「Rated Range」列，正好用来实现「只列计分场次」。
 */
async function fetchAtCoderContests() {
  const response = await fetch('https://atcoder.jp/contests/', {
    headers: { 'User-Agent': CALENDAR_UA },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = await response.text();

  const table = html.split('id="contest-table-upcoming"')[1] ?? '';
  const result = [];
  for (const row of table.split('<tr>').slice(1)) {
    const link = row.match(/href="\/contests\/([A-Za-z0-9_+-]+)"[^>]*>([^<]+)</);
    const start = row.match(/<time[^>]*>([^<]+)<\/time>/);
    if (!link || !start) continue;
    // 官方给的是日本时间，形如 2026-10-03 21:00:00+0900
    const parsed = new Date(
      start[1].trim().replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'),
    );
    if (Number.isNaN(parsed.getTime())) continue;

    // text-center 的格子有两个：时长（01:40）和 Rated Range（" - 1999" / "1200 - 2799" / "-"）
    const centers = [...row.matchAll(/<td class="text-center">([^<]*)<\/td>/g)].map((m) =>
      m[1].trim(),
    );
    const durationText = centers.find((text) => /^\d{1,2}:\d{2}$/.test(text));
    const ratedText = centers[centers.length - 1] ?? '';
    // 这一列有三种取值：区间（" - 1999" / "1200 - 2799"）、全员计分（All）、
    // 以及不评分的一个「-」（PAST、AWC、AAL 这类练习赛）。只跳过最后一种。
    const allRated = /^all$/i.test(ratedText);
    if (!allRated && !/\d/.test(ratedText)) continue;

    result.push({
      id: `atcoder-${link[1]}`,
      name: link[2].trim(),
      startTime: Math.floor(parsed.getTime() / 1000),
      durationSeconds: durationText
        ? (Number(durationText.slice(0, -3)) * 60 + Number(durationText.slice(-2))) * 60
        : 100 * 60,
      url: `https://atcoder.jp/contests/${link[1]}`,
      source: 'atcoder',
      // 「计分区间」文案：上界写成 ~1999，两端都有就写 1200~2799，全员计分单独说
      ratedLabel: allRated ? '全员计分' : `计分区间 ${formatRatedRange(ratedText)}`,
    });
  }
  return result;
}

/** 把 AtCoder 的 Rated Range 格子（"- 1999" / "1200 - 2799" / "2400 -"）收拾成好读的样子。 */
function formatRatedRange(text) {
  const [low, high] = String(text)
    .split('-')
    .map((part) => part.trim());
  if (!low && high) return `~${high}`;
  if (low && !high) return `${low}~`;
  return `${low}~${high}`;
}

async function handleCalendar(url) {
  const days = Math.min(60, Math.max(1, Number(url.searchParams.get('days') || 14)));
  const rawHandle = url.searchParams.get('handle');
  const contestsState = await ensureContests();
  // 洛谷和 AtCoder 的赛程：抓不到就只用 Codeforces 的，不影响页面
  const [luogu, atcoder] = await Promise.all([
    loadExternalContests('luogu'),
    loadExternalContests('atcoder'),
  ]);

  const now = Math.floor(Date.now() / 1000);
  const until = now + days * 86400;
  // Codeforces 和 AtCoder 只留一周内的（赛程太远排着也没用，主要看这周打哪场）；
  // 洛谷的正式赛公布得早，按用户选的窗口来。
  const weekAhead = now + 7 * 86400;
  const upcoming = db
    .getUpcomingContests(200)
    .filter(
      (contest) =>
        contest.type === 'CF' &&
        contest.startTime <= Math.min(until, weekAhead) &&
        contest.startTime + contest.duration > now,
    );

  let current = null;
  if (rawHandle) {
    const cached = db.getUser(db.normalizeHandle(rawHandle));
    if (cached?.rating) current = cached.rating;
  }

  const cfRows = upcoming.map((contest) => {
    const info = parseContestInfo(contest.name);
    return {
      id: contest.id,
      name: contest.name,
      division: info.division,
      source: 'cf',
      startTime: contest.startTime,
      durationSeconds: contest.duration,
      url: `https://codeforces.com/contest/${contest.id}`,
      fit: current == null ? null : divisionFit(info.division, current),
    };
  });

  // 外面的赛程只保留「还没结束、且在时间窗里」的
  const externalRows = [...luogu, ...atcoder]
    .filter((contest) => {
      if (contest.startTime + contest.durationSeconds <= now) return false;
      // AtCoder 和 Codeforces 一样只看一周内；洛谷按用户选的窗口
      return contest.source === 'luogu' ? contest.startTime <= until : contest.startTime <= weekAhead;
    })
    .map((contest) => ({
      id: contest.id,
      name: contest.name,
      // AtCoder 顺带把「这场对哪个分段计分」带出来，挑场次时有用
      division:
        contest.source === 'luogu'
          ? '洛谷'
          : contest.ratedLabel ?? 'AtCoder',
      source: contest.source,
      startTime: contest.startTime,
      durationSeconds: contest.durationSeconds,
      url: contest.url,
      // 这两家不区分 Div.，也就没有「适合你的组别」这个判断
      fit: null,
    }));

  return {
    contestsState,
    now,
    days,
    sources: ['cf', 'luogu', 'atcoder'],
    upcoming: [...cfRows, ...externalRows].sort((a, b) => a.startTime - b.startTime),
  };
}

/** 虚拟参赛：进行中的场次、推荐场次、赛后复盘、历史记录。 */
async function handleVirtual(url) {
  const rawHandle = url.searchParams.get('handle');
  if (!rawHandle) return { status: 400, body: { error: '请先填写 Codeforces 用户名' } };

  const targetParam = Number(url.searchParams.get('target'));
  await ensureContests();
  await ensureProblems();
  await loadUser(rawHandle);

  const handleKey = db.normalizeHandle(rawHandle);
  const user = db.getUser(handleKey);
  const current = user?.rating && user.rating > 0 ? user.rating : 800;
  const target =
    Number.isFinite(targetParam) && targetParam >= 800 ? Math.round(targetParam) : current + 200;

  const submissions = db.getSubmissions(handleKey);
  const { solved } = deriveProgress(submissions);
  const problems = allProblems();
  const rated = problems.filter(
    (problem) => problem.type === 'PROGRAMMING' && problem.rating != null,
  );

  const sessions = db.listVirtualSessions(handleKey, 10);
  const running = sessions.find((session) => session.status === 'running') ?? null;

  // 复盘：默认看最近打完的那一场
  const reviewId = Number(url.searchParams.get('reviewId')) || 0;
  const reviewSession = reviewId
    ? sessions.find((session) => session.id === reviewId)
    : sessions.find((session) => session.status !== 'running');
  let review = null;
  if (reviewSession) {
    const contest = db.getContest(reviewSession.contestId);
    const contestProblems = rated.filter((problem) => problem.contestId === reviewSession.contestId);
    if (contest && contestProblems.length) {
      review = analyzeVirtualSession({
        session: reviewSession,
        contest,
        problems: contestProblems,
        submissions,
        current,
        target,
      });
    }
  }

  const history = sessions.map((session) => {
    const contest = db.getContest(session.contestId);
    return {
      id: session.id,
      contestId: session.contestId,
      contestName: contest?.name ?? `比赛 ${session.contestId}`,
      division: contest ? parseContestInfo(contest.name).division : null,
      startedAt: session.startedAt,
      durationSeconds: session.durationSeconds,
      status: session.status,
      url: `https://codeforces.com/contest/${session.contestId}`,
    };
  });

  let runningPayload = null;
  if (running) {
    const contest = db.getContest(running.contestId);
    const contestProblems = rated
      .filter((problem) => problem.contestId === running.contestId)
      .sort((a, b) => a.index.localeCompare(b.index));
    runningPayload = {
      session: running,
      contest: contest ? decorateContest(contest) : null,
      problems: contestProblems.map(toClientProblem),
      remainingSeconds: Math.round(
        (running.startedAt + running.durationSeconds * 1000 - Date.now()) / 1000,
      ),
    };
  }

  let recommendations = [];
  if (!running) {
    // 用和目标区间一致的弱项口径来挑比赛，保证"练的"和"打的"是一回事
    const solvedProblems = rated.filter((problem) =>
      solved.has(`${problem.contestId}-${problem.index}`),
    );
    const tagProfile = buildTagProfile(solvedProblems);
    const bandLower = Math.max(800, target - 250);
    const bandTags = new Set();
    for (const problem of rated) {
      if (problem.rating < bandLower || problem.rating > target + 150) continue;
      for (const tag of problem.tags) if (!isNoiseTag(tag)) bandTags.add(tag);
    }
    const weakTags = new Set(
      rankFocusTags({ tagProfile, bandTags, bandLower, bandCenter: target })
        .slice(0, 10)
        .map((row) => row.tag),
    );

    recommendations = recommendVirtualContests({
      contests: db.getContests(),
      problems,
      solved,
      weakTags,
      current,
      target,
      participatedContestIds: new Set(
        db.getRatingHistory(handleKey).map((entry) => entry.contestId),
      ),
      doneContestIds: new Set(sessions.map((session) => session.contestId)),
    });
  }

  return {
    status: 200,
    body: { current, target, running: runningPayload, recommendations, review, history },
  };
}

// ---------------------------------------------------------------------------
// 团队模式
//
// 队伍不出现在任何鉴权路径上：这本来就是本机单人使用的程序，队伍的「成员」
// 就是这个程序里已经加载过的那些 handle。所以所有 /api/team/* 接口都不校验
// 权限，谁调用都能读写——这不是疏忽，而是设计。真要多人用（同一个程序被
// 三个人的浏览器同时打开），那是下一步上云端才需要解决的事，
// 到那时这里会换成真正的会话校验。
// ---------------------------------------------------------------------------

/** 把队伍里的 handle 补全成「成员 + 知识画像 + 进度摘要」，供分工和总览用。 */
function teamMembersWithProfiles(teamId, settings) {
  const members = db.listTeamMembers(teamId);
  return members.map((member) => {
    const user = db.getUser(member.handleKey);
    const submissions = db.getSubmissions(member.handleKey);
    const { solved } = deriveProgress(submissions);
    const solvedProblems = [];
    for (const problem of db.getAllProblems()) {
      const key = problemKey(problem.contestId, problem.index);
      const entry = solved.get(key);
      if (!entry) continue;
      solvedProblems.push({
        ...problem,
        solvedAt: entry.at,
      });
    }
    const floor = user?.rating
      ? Math.max(0, user.rating - (Number.isFinite(settings.floorGap) ? settings.floorGap : 400))
      : 0;
    const tagProfile = buildTagProfile(solvedProblems, { floor });
    const profile = buildKnowledgeProfile(solvedProblems, tagProfile, { floor });
    return {
      handleKey: member.handleKey,
      display: user?.displayHandle || member.handleKey,
      role: member.role,
      rating: user?.rating ?? null,
      maxRating: user?.maxRating ?? null,
      solvedCount: solved.size,
      profile: profile.map((entry) => ({
        axis: entry.axis,
        count: entry.count,
        representative: entry.representative,
        gapVsSelf: entry.gapVsSelf,
        confidence: entry.confidence,
      })),
    };
  });
}

async function handleTeamOverview(teamId, settings) {
  const team = db.getTeam(teamId);
  if (!team) return { status: 404, body: { error: '队伍不存在' } };
  const members = teamMembersWithProfiles(teamId, settings);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const weekAgo = nowSeconds - 7 * 24 * 3600;

  const overview = members.map((member) => {
    const submissions = db.getSubmissions(member.handleKey);
    const { solved } = deriveProgress(submissions);
    let recent = 0;
    for (const entry of solved.values()) {
      if (entry.at && entry.at >= weekAgo) recent += 1;
    }
    // 最近一次提交时间：界面上用「几天没动了」来提示谁掉队了。
    // getDailyActivity 返回的是 { solved: {日期: 条数}, submissions: {...} } 两个对象，
    // 不是数组——按日期排一下取最后一天。
    const activity = db.getDailyActivity(member.handleKey);
    const days = Object.keys(activity.solved ?? {}).sort();
    const lastActive = days.length ? days[days.length - 1] : null;
    return {
      handleKey: member.handleKey,
      display: member.display,
      role: member.role,
      rating: member.rating,
      maxRating: member.maxRating,
      solvedCount: member.solvedCount,
      solvedThisWeek: recent,
      lastActive,
      // 最强的两块和最弱的两块，总览页上一眼能看出谁擅长什么、缺什么
      strengths: [...member.profile]
        .filter((entry) => entry.count > 0)
        .sort((a, b) => (b.gapVsSelf ?? 0) - (a.gapVsSelf ?? 0))
        .slice(0, 2)
        .map((entry) => ({ axis: entry.axis, gapVsSelf: Math.round(entry.gapVsSelf ?? 0) })),
      weaknesses: [...member.profile]
        .sort((a, b) => (a.gapVsSelf ?? 0) - (b.gapVsSelf ?? 0))
        .slice(0, 2)
        .map((entry) => ({ axis: entry.axis, gapVsSelf: Math.round(entry.gapVsSelf ?? 0) })),
    };
  });

  return {
    status: 200,
    body: {
      team,
      members: overview,
      // 分工也一并带上：界面的「分工矩阵」要显示每个方向归谁，
      // 光有成员画像算不出来（分工是钉住的结果，不是现算的）。
      assignment: ensureAssignmentView(teamId, members),
    },
  };
}

/**
 * 读这份队伍的分工；一次都没分过（或者成员变过）就现场分一份存下来。
 *
 * 为什么放在「看总览」的时候也算一次：分工矩阵是团队页最核心的一块，
 * 第一次进来如果是空的，用户根本不知道该点哪个按钮。自动分一份不是
 * 擅自替用户决定——「重新分配」按钮一直都在，不满意点一下就重算。
 */
function ensureAssignmentView(teamId, members) {
  const list = members ?? [];
  if (!list.length) return [];

  const saved = db.listTeamAssignments(teamId);
  const memberKeys = new Set(list.map((m) => m.handleKey));
  // 现有成员里只要有一个没分工，就整份重算：不然新加的人会一直显示「待分配」
  const covered =
    saved.length > 0 && list.every((m) => saved.some((s) => s.handleKey === m.handleKey));
  const stale = saved.some((s) => !memberKeys.has(s.handleKey));

  let assignment = saved;
  if (!covered || stale) {
    const allocation = assignAxes(list);
    assignment = allocation.byMember.flatMap((m) => [
      ...m.main.map((axis) => ({ handleKey: m.handleKey, axis, kind: 'main' })),
      ...m.sub.map((axis) => ({ handleKey: m.handleKey, axis, kind: 'sub' })),
    ]);
    db.saveTeamAssignments(teamId, assignment);
  }

  const displayOf = new Map(list.map((m) => [m.handleKey, m.display]));
  return list.map((m) => ({
    handleKey: m.handleKey,
    display: displayOf.get(m.handleKey) ?? m.handleKey,
    main: assignment
      .filter((s) => s.handleKey === m.handleKey && s.kind === 'main')
      .map((s) => s.axis),
    sub: assignment
      .filter((s) => s.handleKey === m.handleKey && s.kind === 'sub')
      .map((s) => s.axis),
  }));
}

/**
 * 团队排题：GET /api/team/:id/plan
 *
 * 先按现有的分工（team_assignments）给每人排题；没有分工就现场算一份并存下来。
 * 排题是纯 CPU 的（实测三人各 8 道约 44ms），同步做就行，不用排队。
 */
function handleTeamPlan(teamId, url, settings) {
  const team = db.getTeam(teamId);
  if (!team) return { status: 404, body: { error: '队伍不存在' } };
  const perMember = Math.min(50, Math.max(1, Number(url.searchParams.get('perMember') || 8)));
  const target = Number(url.searchParams.get('target') || 1900);

  const members = teamMembersWithProfiles(teamId, settings);
  if (!members.length) {
    return { status: 200, body: { team, assignment: null, members: [], note: '队伍里还没有成员' } };
  }

  // 分工：和总览页共用同一份逻辑（没分过就自动分一份存下来），
  // 保证「看总览」和「点排题」看到的是同一套方向，不会两处不一致。
  const byMember = ensureAssignmentView(teamId, members);

  const profileByKey = new Map(members.map((m) => [m.handleKey, m]));
  const planningMembers = byMember.map((alloc) => {
    const info = profileByKey.get(alloc.handleKey);
    const submissions = db.getSubmissions(alloc.handleKey);
    const { solved } = deriveProgress(submissions);
    return {
      handleKey: alloc.handleKey,
      display: info?.display ?? alloc.handleKey,
      rating: info?.rating ?? target,
      main: alloc.main,
      sub: alloc.sub,
      solved,
    };
  });

  const blocked = new Set();
  for (const member of planningMembers) {
    for (const entry of db.listBlockedProblems(member.handleKey)) {
      blocked.add(problemKey(entry.contestId, entry.index));
    }
  }

  const result = buildTeamPlans(planningMembers, {
    problems: db.getAllProblems(),
    target,
    perMember,
    // settings 里没设过就是 null（表示"用默认值"），走的还是单人版同一个换算
    tagShare: normalizeTagShare(settings.tagShare),
    blocked,
  });

  return {
    status: 200,
    body: {
      team,
      target,
      perMember,
      assignment: byMember,
      members: result.members,
      note: `按队内分工排题：每人 ${perMember} 道，队内不重复。`,
    },
  };
}

async function route(req, res, url) {
  const { pathname } = url;

  if (pathname === '/api/health') {
    // 自检页要用这些：题库是什么时候同步的、模型练没练过、计划快照存了几份、库多大
    const model = modelModule.parseModel(db.metaGet(modelModule.MODEL_KEY));
    let dbSize = 0;
    try {
      dbSize = statSync(join(db.DATA_DIR, 'trainer.db')).size;
    } catch {
      dbSize = 0;
    }
    return sendJson(res, 200, {
      ok: true,
      version: VERSION,
      problems: db.countProblems(),
      problemsUpdatedAt: Number(db.metaGet('problems_updated_at') || 0) || null,
      contests: db.countContests(),
      model: model
        ? {
            trainedAt: model.trainedAt ?? null,
            samples: model.samples ?? null,
            auc: model.auc ?? null,
            baselineAuc: model.baselineAuc ?? null,
            active: modelModule.isModelUseful(model),
          }
        : null,
      dbSize,
    });
  }

  if (pathname === '/api/settings' && req.method === 'GET') {
    return sendJson(res, 200, { settings: readSettings() });
  }

  if (pathname === '/api/settings' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const patch = { updated_at: Date.now() };
      if (body.handle !== undefined) patch.handle = String(body.handle).trim();
      if (body.target !== undefined && Number.isFinite(Number(body.target))) {
        patch.target = Math.round(Number(body.target));
      }
      if (body.weekly !== undefined && Number.isFinite(Number(body.weekly))) {
        patch.weekly = Math.round(Number(body.weekly));
      }
      if (body.theme !== undefined) {
        if (!THEMES.includes(body.theme)) return sendError(res, 400, '不支持的主题');
        patch.theme = body.theme;
      }
      if (body.heatmapPalette !== undefined) {
        if (!PALETTES.includes(body.heatmapPalette)) return sendError(res, 400, '不支持的配色');
        patch.heatmap_palette = body.heatmapPalette;
      }
      if (body.restDays !== undefined) {
        if (!Array.isArray(body.restDays)) return sendError(res, 400, 'restDays 需要是数组');
        patch.rest_days = JSON.stringify(
          [...new Set(body.restDays.map(Number).filter((n) => n >= 0 && n <= 6))].sort(),
        );
      }
      if (body.dayOff !== undefined) {
        if (typeof body.dayOff !== 'object' || body.dayOff === null) {
          return sendError(res, 400, 'dayOff 需要是对象');
        }
        const clean = {};
        for (const [date, note] of Object.entries(body.dayOff)) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
          clean[date] = String(note ?? '').slice(0, 60);
        }
        patch.day_off = JSON.stringify(clean);
      }
      if (body.collapsed !== undefined) {
        if (typeof body.collapsed !== 'object' || body.collapsed === null) {
          return sendError(res, 400, 'collapsed 需要是对象');
        }
        const clean = {};
        for (const [panel, value] of Object.entries(body.collapsed)) {
          if (/^panel-[a-z-]+$/.test(panel) && value) clean[panel] = true;
        }
        patch.collapsed = JSON.stringify(clean);
      }
      if (body.hiddenModules !== undefined) {
        if (!Array.isArray(body.hiddenModules)) {
          return sendError(res, 400, 'hiddenModules 需要是数组');
        }
        patch.hidden_modules = JSON.stringify([
          ...new Set(body.hiddenModules.filter((id) => /^panel-[a-z-]+$/.test(id))),
        ]);
      }
      if (body.nowcoderUid !== undefined) patch.nowcoder_uid = String(body.nowcoderUid).trim();
      if (body.luoguUid !== undefined) patch.luogu_uid = String(body.luoguUid).trim();
      if (body.atcoderUid !== undefined) patch.atcoder_uid = String(body.atcoderUid).trim();
      // 训练计划里是否混入 AtCoder 题：不勾就是全 CF
      if (body.atcoderInPlan !== undefined) patch.atcoder_in_plan = body.atcoderInPlan ? '1' : '';
      // 训练计划里是否混入洛谷题
      if (body.luoguInPlan !== undefined) patch.luogu_in_plan = body.luoguInPlan ? '1' : '';
      if (body.floorGap !== undefined) {
        const value = Number(body.floorGap);
        if (!Number.isFinite(value) || value < 0 || value > 2000) {
          return sendError(res, 400, '排除区间请填 0 到 2000 之间的数字');
        }
        patch.floor_gap = String(Math.round(value));
      }
      if (body.tagShare !== undefined) {
        const value = Number(body.tagShare);
        if (!Number.isFinite(value) || value < 10 || value > 90) {
          return sendError(res, 400, '单个标签占比上限请填 10 到 90 之间的数字');
        }
        patch.tag_share = String(Math.round(value));
      }
      // 训练计划里是否隐藏标签
      if (body.hideTags !== undefined) patch.hide_tags = body.hideTags ? '1' : '';
      if (body.extraAxis !== undefined) patch.extra_axis = body.extraAxis ? '1' : '';
      // 打卡提醒时间：'HH:MM'，空串表示关闭
      if (body.remindAt !== undefined) {
        const value = String(body.remindAt ?? '').trim();
        if (value && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
          return sendError(res, 400, '提醒时间要写成 09:30 这样');
        }
        patch.remind_at = value;
      }
      // 记「今天已经提醒过」，防止同一天重复弹
      if (body.remindLast !== undefined) {
        patch.remind_last = String(body.remindLast ?? '').slice(0, 10);
      }
      db.saveSettings(patch);
      return sendJson(res, 200, { settings: readSettings() });
    } catch (error) {
      return sendError(res, 400, error.message);
    }
  }

  // ---------- 数据安全：备份 / 导出 / 导入，以及检查更新 ----------
  if (pathname === '/api/backup') {
    const dir = join(db.DATA_DIR, 'backups');
    if (req.method === 'GET') {
      mkdirSync(dir, { recursive: true });
      const files = readdirSync(dir)
        .filter((name) => name.endsWith('.db'))
        .map((name) => ({ name, size: statSync(join(dir, name)).size }))
        .sort((a, b) => b.name.localeCompare(a.name));
      return sendJson(res, 200, { dir, files });
    }
    if (req.method === 'POST') {
      try {
        mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
        const target = join(dir, `trainer-${stamp}.db`);
        // 用 SQLite 自带的 VACUUM INTO 备份：会把 WAL 里没落盘的内容一起写进去，
        // 直接复制文件有可能拿到写了一半的库。
        db.db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
        return sendJson(res, 200, {
          ok: true,
          name: `trainer-${stamp}.db`,
          size: statSync(target).size,
          dir,
        });
      } catch (error) {
        return sendError(res, 500, `备份失败：${error.message}`);
      }
    }
  }

  // 导出/导入训练数据（设置、勾选进度、屏蔽表、虚拟赛记录）：换电脑时把 JSON 搬过去
  if (pathname === '/api/export' && req.method === 'GET') {
    return sendJson(res, 200, db.exportTrainingData());
  }

  if (pathname === '/api/import' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req, 30_000_000);
      return sendJson(res, 200, { ok: true, ...db.importTrainingData(body) });
    } catch (error) {
      return sendError(res, 400, `导入失败：${error.message}`);
    }
  }

  // 检查更新：直接问 GitHub 最新 Release 是什么，比自己记版本号省事（零依赖）
  if (pathname === '/api/update-check' && req.method === 'GET') {
    try {
      const response = await fetch(
        'https://api.github.com/repos/DB-SLSQ/Acm-Tracker/releases/latest',
        { headers: { 'User-Agent': 'acm-trainer', Accept: 'application/vnd.github+json' } },
      );
      if (!response.ok) return sendError(res, 502, `GitHub 返回 ${response.status}`);
      const release = await response.json();
      const latest = String(release.tag_name ?? '').replace(/^v/, '');
      const asset = (release.assets ?? []).find((item) =>
        String(item.name ?? '').toLowerCase().endsWith('.exe'),
      );
      return sendJson(res, 200, {
        current: VERSION,
        latest,
        newer: compareVersions(latest, VERSION) > 0,
        url: asset?.browser_download_url ?? release.html_url,
        notes: String(release.body ?? '').slice(0, 4000),
        publishedAt: release.published_at ?? null,
      });
    } catch (error) {
      return sendError(res, 502, `检查更新失败：${error.message}`);
    }
  }

  // ---------- 推题模型：后台训练 + 进度查询 ----------
  if (pathname === '/api/model' && req.method === 'GET') {
    const model = modelModule.parseModel(db.metaGet(modelModule.MODEL_KEY));
    return sendJson(res, 200, {
      samples: db.countModelSamples(),
      training: {
        running: training.running,
        lines: training.lines,
        startedAt: training.startedAt,
        finishedAt: training.finishedAt,
        error: training.error,
      },
      model: model
        ? {
            trainedAt: model.trainedAt ?? null,
            samples: model.samples ?? null,
            contests: model.contests ?? null,
            auc: model.metrics?.auc ?? null,
            baselineAuc: model.baseline?.auc ?? null,
            logLoss: model.metrics?.logLoss ?? null,
            baselineLogLoss: model.baseline?.logLoss ?? null,
            active: modelModule.isModelUseful(model),
          }
        : null,
    });
  }

  if (pathname === '/api/model/train' && req.method === 'POST') {
    if (training.running) return sendError(res, 409, '已经有一个训练任务在跑了');
    const body = await readJsonBody(req).catch(() => ({}));
    const contests = Math.max(1, Math.min(2000, Number(body.contests) || 300));
    const extra = body.reset ? ['--reset'] : [];
    const child = spawn(
      process.execPath,
      ['--no-warnings', join(HERE, 'scripts', 'train-model.js'), '--contests', String(contests), ...extra],
      { cwd: HERE, env: process.env },
    );
    training.running = true;
    training.lines = [`开始采集 ${contests} 场比赛的数据…`];
    training.startedAt = Date.now();
    training.finishedAt = null;
    training.error = null;
    child.stdout.on('data', (chunk) => pushTrainingLine(chunk));
    child.stderr.on('data', (chunk) => pushTrainingLine(chunk));
    child.on('error', (error) => {
      training.error = error.message;
    });
    child.on('close', (code) => {
      training.running = false;
      training.finishedAt = Date.now();
      if (code !== 0 && !training.error) training.error = `训练进程异常退出（代码 ${code}）`;
      pushTrainingLine(code === 0 ? '训练结束。' : '训练中断。');
    });
    return sendJson(res, 202, { started: true, contests });
  }

  if (pathname === '/api/activity') {
    const rawHandle = url.searchParams.get('handle');
    if (!rawHandle) return sendError(res, 400, '请先填写 Codeforces 用户名');
    const handleKey = db.normalizeHandle(rawHandle);
    if (!db.getUser(handleKey)) return sendError(res, 404, '还没有这个用户的数据，请先加载一次');
    const offsetSeconds = Number(url.searchParams.get('offset') || 0);
    const activity = db.getDailyActivity(
      handleKey,
      Number.isFinite(offsetSeconds) ? Math.round(offsetSeconds) : 0,
    );
    return sendJson(res, 200, { activity });
  }

  if (pathname === '/api/platforms' && req.method === 'GET') {
    return sendJson(res, 200, {
      platforms: db.listPlatformStats(),
      // 洛谷题库的抓取摘要（抓了几道、抽了哪几页），设置里会显示上一次的结果
      luoguCatalog: parseJson(db.metaGet('luogu_catalog_info'), null),
    });
  }

  // 手动屏蔽的题目：屏蔽后永远不再出现在推荐里
  if (pathname === '/api/blocked' && req.method === 'GET') {
    const rawHandle = url.searchParams.get('handle');
    if (!rawHandle) return sendError(res, 400, '请先填写 Codeforces 用户名');
    return sendJson(res, 200, { blocked: blockedPayload(db.normalizeHandle(rawHandle)) });
  }

  // 做过的题，按首次通过时间倒序
  if (pathname === '/api/solved') {
    const rawHandle = url.searchParams.get('handle');
    if (!rawHandle) return sendError(res, 400, '请先填写 Codeforces 用户名');
    const handleKey = db.normalizeHandle(rawHandle);
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 100)));
    const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
    return sendJson(res, 200, {
      total: db.countSolved(handleKey),
      // 这里会带上 AtCoder 的过题记录：界面上按 platform 显示来源角标
      solved: db.recentlySolved(handleKey, limit, offset).map(toClientProblem),
    });
  }

  // 题库浏览：筛选 + 分页 + 随机挑一道（照着 cftracker 那套做的，但数据是本地题库，
  // 所以 CF / AtCoder / 洛谷三个平台能一起筛，不用联网）
  if (pathname === '/api/problems' && req.method === 'GET') {
    const { rows, solved, attempted } = filterProblemBank(url);
    const sort = url.searchParams.get('sort') ?? 'rating';
    const page = Math.max(1, Number(url.searchParams.get('page') || 1));
    const perPage = Math.min(100, Math.max(10, Number(url.searchParams.get('perPage') || 50)));
    sortProblemRows(rows, sort);
    const total = rows.length;
    const items = rows.slice((page - 1) * perPage, page * perPage).map((problem) => {
      const key = `${problem.contestId}-${problem.index}`;
      return {
        ...toClientProblem(problem),
        solved: solved.has(key),
        attempts: attempted.get(key) ?? 0,
      };
    });
    return sendJson(res, 200, { total, page, perPage, sort, items });
  }

  // 随机一道：拿同一套筛选条件，在筛完的结果里随机挑
  if (pathname === '/api/problems/random' && req.method === 'GET') {
    const { rows, solved } = filterProblemBank(url);
    if (!rows.length) return sendError(res, 404, '这组条件下没有题，放宽一点再试');
    const pick = rows[Math.floor(Math.random() * rows.length)];
    return sendJson(res, 200, {
      matched: rows.length,
      problem: {
        ...toClientProblem(pick),
        solved: solved.has(`${pick.contestId}-${pick.index}`),
      },
    });
  }

  // 比赛列表（照着 cftracker 的 contests 页做的）：一场一行，展开是这场每道题的难度块，
  // 做过的高亮。洛谷不参与——它的题没有「比赛」这个层级。
  if (pathname === '/api/contests' && req.method === 'GET') {
    const { rows } = collectContests(url);
    const kind = url.searchParams.get('kind') ?? 'all';
    const state = url.searchParams.get('state') ?? 'all';
    const sort = url.searchParams.get('sort') ?? 'newest';
    const page = Math.max(1, Number(url.searchParams.get('page') || 1));
    const perPage = Math.min(60, Math.max(10, Number(url.searchParams.get('perPage') || 30)));

    let list = rows;
    if (kind !== 'all') list = list.filter((contest) => contest.kind === kind);
    if (state === 'played') list = list.filter((contest) => contest.solvedCount > 0);
    if (state === 'todo') list = list.filter((contest) => contest.solvedCount < contest.problems.length);
    if (sort === 'oldest') list.sort((a, b) => a.startTime - b.startTime);
    else if (sort === 'most-solved') list.sort((a, b) => b.solvedCount - a.solvedCount);
    else list.sort((a, b) => b.startTime - a.startTime);

    return sendJson(res, 200, {
      total: list.length,
      page,
      perPage,
      items: list.slice((page - 1) * perPage, page * perPage),
      kinds: contestKinds(rows),
    });
  }

  // 随机一场：cftracker 那个「random contest」，默认只挑你还没做全的
  if (pathname === '/api/contests/random' && req.method === 'GET') {
    const { rows } = collectContests(url);
    const kind = url.searchParams.get('kind') ?? 'all';
    let list = rows.filter((contest) => contest.solvedCount < contest.problems.length);
    if (kind !== 'all') list = list.filter((contest) => contest.kind === kind);
    if (!list.length) return sendError(res, 404, '没有符合条件的比赛了，换个类别试试');
    const pick = list[Math.floor(Math.random() * list.length)];
    return sendJson(res, 200, { matched: list.length, contest: pick });
  }

  // 拼好题：一场没打过的 CF + 一场没打过的 AtCoder，凑成一套
  if (pathname === '/api/mashup' && req.method === 'GET') {
    const result = buildMashup(url);
    if (!result.cf && !result.atcoder) {
      return sendError(res, 404, '这段时间里没有你没打过的比赛了，把时间范围放宽一点');
    }
    return sendJson(res, 200, result);
  }

  // 自己攒的题单：列表、详情、新建、追加、勾选、删除
  if (pathname === '/api/lists' && req.method === 'GET') {
    return sendJson(res, 200, { lists: db.listProblemLists() });
  }

  if (pathname === '/api/lists' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const parsed = parseProblemText(String(body.text ?? ''));
      if (!parsed.items.length) {
        return sendError(res, 400, '没认出来任何题目，把题号或题目链接一起贴进来就行');
      }
      const id = db.createProblemList(body.name ?? defaultListName(parsed.items.length), parsed.items);
      return sendJson(res, 200, {
        id,
        matched: parsed.items.length,
        unmatched: parsed.unmatched,
        lists: db.listProblemLists(),
      });
    } catch (error) {
      return sendError(res, 400, error.message);
    }
  }

  const listPath = pathname.match(/^\/api\/lists\/(\d+)(\/items|\/item)?$/);
  if (listPath) {
    const listId = Number(listPath[1]);
    const sub = listPath[2];
    const list = db.getProblemList(listId);
    if (!list) return sendError(res, 404, '这个题单不存在了');

    if (!sub && req.method === 'GET') {
      const problems = db.getProblemsByKeys(
        db.getProblemListItems(listId).map((item) => `${item.contestId}-${item.index}`),
      );
      const items = db
        .getProblemListItems(listId)
        .map((item) => {
          const problem = problems.get(`${item.contestId}-${item.index}`);
          if (!problem) return null;
          return { ...toClientProblem(problem), done: item.done };
        })
        .filter(Boolean);
      return sendJson(res, 200, { list, items });
    }

    if (!sub && req.method === 'DELETE') {
      db.deleteProblemList(listId);
      return sendJson(res, 200, { ok: true, lists: db.listProblemLists() });
    }

    if (sub === '/items' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const parsed = parseProblemText(String(body.text ?? ''));
        const added = parsed.items.length ? db.addProblemListItems(listId, parsed.items) : 0;
        return sendJson(res, 200, { added, matched: parsed.items.length, unmatched: parsed.unmatched });
      } catch (error) {
        return sendError(res, 400, error.message);
      }
    }

    if (sub === '/item') {
      try {
        const body = await readJsonBody(req);
        const contestId = Number(body.contestId);
        if (!Number.isFinite(contestId) || !body.index) return sendError(res, 400, '参数不完整');
        if (req.method === 'POST') {
          db.setProblemListItemDone(listId, contestId, String(body.index), Boolean(body.done));
          return sendJson(res, 200, { ok: true });
        }
        if (req.method === 'DELETE') {
          db.removeProblemListItem(listId, contestId, String(body.index));
          return sendJson(res, 200, { ok: true });
        }
      } catch (error) {
        return sendError(res, 400, error.message);
      }
    }
  }

  if (pathname === '/api/blocked' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const handleKey = db.normalizeHandle(body.handle);
      const contestId = Number(body.contestId);
      if (!handleKey) return sendError(res, 400, '请先填写 Codeforces 用户名');
      if (!Number.isFinite(contestId) || !body.index) return sendError(res, 400, '题目参数不完整');
      db.blockProblem(handleKey, {
        contestId,
        index: String(body.index),
        name: body.name,
        rating: Number.isFinite(Number(body.rating)) ? Number(body.rating) : null,
        reason: body.reason,
      });
      return sendJson(res, 200, { blocked: blockedPayload(handleKey) });
    } catch (error) {
      return sendError(res, 400, error.message);
    }
  }

  if (pathname === '/api/blocked' && req.method === 'DELETE') {
    try {
      const body = await readJsonBody(req);
      const handleKey = db.normalizeHandle(body.handle);
      const contestId = Number(body.contestId);
      if (!handleKey) return sendError(res, 400, '请先填写 Codeforces 用户名');
      if (!Number.isFinite(contestId) || !body.index) return sendError(res, 400, '题目参数不完整');
      db.unblockProblem(handleKey, contestId, String(body.index));
      return sendJson(res, 200, { blocked: blockedPayload(handleKey) });
    } catch (error) {
      return sendError(res, 400, error.message);
    }
  }

  if (pathname === '/api/platforms/sync' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const platform = String(body.platform ?? '');
      const account = String(body.account ?? '').trim();
      if (!['nowcoder', 'luogu'].includes(platform)) {
        return sendError(res, 400, '暂不支持这个平台');
      }
      if (!account) return sendError(res, 400, '请先填写用户 ID');

      const key = `${platform}:${account}`;
      if (Date.now() - (recentSyncs.get(key) ?? 0) < SYNC_COOLDOWN_MS) {
        return sendError(res, 429, '刚刚同步过，等 20 秒再试');
      }
      recentSyncs.set(key, Date.now());

      const result = platform === 'luogu' ? await fetchLuogu(account) : await fetchNowcoder(account);

      // 洛谷顺手把「做过的题」记下来：训练计划靠它排除做过的题、自动打勾。
      // 逐题列表不写进 platform_stats（几千道题的 JSON 太大），记完就删。
      let solvedMarked = null;
      if (platform === 'luogu') {
        const rawHandle = String(body.handle ?? db.getSettings().handle ?? '').trim();
        const passed = result.extra?.solved ?? [];
        if (rawHandle && passed.length) {
          solvedMarked = db.appendLuoguSolved(db.normalizeHandle(rawHandle), passed);
        }
        if (result.extra) delete result.extra.solved;
      }

      db.savePlatformStats(result);
      return sendJson(res, 200, {
        result,
        solvedMarked,
        platforms: db.listPlatformStats(),
      });
    } catch (error) {
      const message = error instanceof PlatformError ? error.message : `同步失败：${error.message}`;
      return sendError(res, 502, message);
    }
  }

  /**
   * AtCoder 同步：题库（ABC/ARC/AGC 里有难度的题）+ 这个用户的提交记录。
   * 题库 7 天内只抓一次，提交记录按游标增量补，所以这个按钮可以随便点。
   */
  if (pathname === '/api/atcoder/sync' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const account = normalizeAtcoderUser(body.account);
      const force = Boolean(body.force);
      // 题库 7 天才换一次，所以「强制」默认只作用于提交记录；
      // 想连题库一起重抓就传 forceCatalog
      const forceCatalog = Boolean(body.forceCatalog);

      const cooldownKey = `atcoder:${account}`;
      if (force && Date.now() - (recentSyncs.get(cooldownKey) ?? 0) < SYNC_COOLDOWN_MS) {
        return sendError(res, 429, '刚刚同步过，等 20 秒再试');
      }
      recentSyncs.set(cooldownKey, Date.now());

      const catalog = await ensureAtcoderCatalog({ force: forceCatalog });
      // 记录挂在 CF 账号下（计划和进度都按这个号存），和 AtCoder 用户名是两回事
      const rawHandle = String(
        body.handle ?? url.searchParams.get('handle') ?? db.getSettings().handle ?? '',
      ).trim();
      if (!rawHandle) return sendError(res, 400, '请先填写 Codeforces 用户名');
      const handleKey = db.normalizeHandle(rawHandle);

      const submissions = await syncAtcoderSubmissions(handleKey, account, { force: true });
      // Kenkoooo 的用户总览：排名这种要全站数据才算得出来，顺手抓一次
      let overview = null;
      try {
        overview = await fetchAtcoderUserInfo(account);
      } catch {
        // 拿不到就不显示这几项，同步本身不受影响
      }
      const stats = {
        通过题目: submissions.total,
        提交记录: db.getSubmissions(handleKey).filter((row) => row.platform === 'atcoder').length,
      };
      if (overview) {
        stats['AtCoder 通过排名'] = overview.acceptedRank;
        stats['计分总分'] = overview.ratedPointSum;
      }
      db.savePlatformStats({
        platform: 'atcoder',
        account,
        nickname: account,
        stats,
        extra: { catalog: catalog.count },
      });

      return sendJson(res, 200, {
        result: { platform: 'atcoder', account, solved: submissions.total, stats },
        catalog,
        submissions,
        platforms: db.listPlatformStats(),
      });
    } catch (error) {
      const message =
        error instanceof AtcoderError ? error.message : `同步 AtCoder 失败：${error.message}`;
      return sendError(res, 502, message);
    }
  }

  /**
   * 洛谷题库。默认只抓普及档（普及−/普及/普及+/提高−），每档等距抽 8 页 = 400 题，
   * 单线程 1.2 秒一个请求，单次上限 60 个请求。要爬提高/省选档就传 levels。
   */
  if (pathname === '/api/luogu/catalog' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const levels =
        Array.isArray(body.levels) && body.levels.length
          ? [...new Set(body.levels.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 8))].sort()
          : LUOGU_POPULAR_LEVELS;
      if (!levels.length) return sendError(res, 400, '难度档要给 1~8 之间的数字');
      const pagesPerLevel = Math.max(1, Math.min(20, Number(body.pagesPerLevel) || 8));
      const budget = Math.max(
        levels.length + 1,
        Math.min(200, Number(body.budget) || LUOGU_REQUEST_BUDGET),
      );

      if (Date.now() - (recentSyncs.get('luogu-catalog') ?? 0) < SYNC_COOLDOWN_MS) {
        return sendError(res, 429, '刚刚抓过题库，等 20 秒再试');
      }
      recentSyncs.set('luogu-catalog', Date.now());

      const { rows, perLevel, requests } = await fetchLuoguCatalog({
        levels,
        pagesPerLevel,
        budget,
      });
      const inserted = db.replaceLuoguProblems(rows);
      dropProblemsCache();
      const now = Date.now();
      db.metaSet('luogu_problems_updated_at', now);
      // 分档记进度：先抓普及、过几天再抓提高，设置里两批都能看到
      const previousInfo = parseJson(db.metaGet('luogu_catalog_info'), null) ?? {};
      const levelsInfo = { ...(previousInfo.levels ?? {}) };
      for (const row of perLevel) {
        levelsInfo[row.level] = {
          label: row.label,
          total: row.total,
          pages: row.pages,
          taken: row.taken,
          updatedAt: now,
        };
      }
      const info = {
        count: db.countLuoguProblems(),
        inserted,
        levels: levelsInfo,
        perLevel,
        requests,
        updatedAt: now,
      };
      db.metaSet('luogu_catalog_info', JSON.stringify(info));

      // 题库刚更新，顺手把「做过的题」也标一遍：之前题库里没有的题现在能对上了
      const settings = readSettings();
      let solvedMarked = null;
      if (settings.luoguUid) {
        try {
          const stats = await fetchLuogu(settings.luoguUid);
          const passed = stats.extra?.solved ?? [];
          const rawHandle = String(body.handle ?? settings.handle ?? '').trim();
          if (rawHandle && passed.length) {
            solvedMarked = db.appendLuoguSolved(db.normalizeHandle(rawHandle), passed);
          }
        } catch (error) {
          solvedMarked = { error: error.message };
        }
      }

      return sendJson(res, 200, {
        catalog: info,
        solvedMarked,
        luoguCatalog: info,
        platforms: db.listPlatformStats(),
      });
    } catch (error) {
      const message = `抓洛谷题库失败：${error.message}`;
      return sendError(res, 502, message);
    }
  }

  if (pathname === '/api/calendar') {
    try {
      return sendJson(res, 200, await handleCalendar(url));
    } catch (error) {
      const message = error instanceof cf.CfError ? error.message : `获取赛程失败：${error.message}`;
      return sendError(res, 502, message);
    }
  }

  if (pathname === '/api/virtual' && req.method === 'GET') {
    try {
      const result = await handleVirtual(url);
      return sendJson(res, result.status, result.body);
    } catch (error) {
      const message =
        error instanceof cf.CfError ? error.message : `读取虚拟参赛失败：${error.message}`;
      return sendError(res, 502, message);
    }
  }

  if (pathname === '/api/virtual/start' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const handleKey = db.normalizeHandle(body.handle);
      if (!handleKey) return sendError(res, 400, '请先填写 Codeforces 用户名');
      const contest = db.getContest(Number(body.contestId));
      if (!contest) return sendError(res, 404, '找不到这场比赛，刷新赛程后重试');

      const existing = db.getRunningSession(handleKey);
      if (existing) db.finishVirtualSession(existing.id);

      const durationSeconds =
        Number(body.durationSeconds) > 0 ? Number(body.durationSeconds) : contest.duration;
      const session = db.createVirtualSession(handleKey, contest.id, durationSeconds);
      return sendJson(res, 200, { session });
    } catch (error) {
      return sendError(res, 400, error.message);
    }
  }

  if (pathname === '/api/virtual/finish' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const handleKey = db.normalizeHandle(body.handle);
      const running = db.getRunningSession(handleKey);
      if (!running) return sendError(res, 400, '当前没有进行中的虚拟赛');
      return sendJson(res, 200, { session: db.finishVirtualSession(running.id) });
    } catch (error) {
      return sendError(res, 400, error.message);
    }
  }

  if (pathname === '/api/user') {
    const rawHandle = url.searchParams.get('handle');
    if (!rawHandle) return sendError(res, 400, '请先填写 Codeforces 用户名');
    const force = url.searchParams.get('refresh') === '1';
    try {
      await ensureProblems();
      await loadUser(rawHandle, { force });
      const summary = buildUserSummary(db.normalizeHandle(rawHandle));
      return sendJson(res, 200, { user: summary });
    } catch (error) {
      const message = error instanceof cf.CfError ? error.message : `抓取失败：${error.message}`;
      return sendError(res, 502, message);
    }
  }

  if (pathname === '/api/plan') {
    try {
      const result = await handlePlan(url);
      return sendJson(res, result.status, result.body);
    } catch (error) {
      const message = error instanceof cf.CfError ? error.message : `生成计划失败：${error.message}`;
      return sendError(res, 502, message);
    }
  }

  // ---- 团队模式 ----
  // 队伍列表 / 新建。路径故意做得平，不带 :id，因为前端只有「选哪支队」一个动作。
  if (pathname === '/api/team' && req.method === 'GET') {
    return sendJson(res, 200, { teams: db.listTeams() });
  }

  if (pathname === '/api/team' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const team = db.createTeam(body?.name);
      return sendJson(res, 201, { team });
    } catch (error) {
      return sendError(res, 400, error.message);
    }
  }

  // /api/team/:id[/...] 的公共前缀解析。子路径用 '/' 切，teamId 是随机串不含 '/'。
  if (pathname.startsWith('/api/team/')) {
    const rest = pathname.slice('/api/team/'.length);
    const [teamId, sub] = [rest.split('/')[0], rest.split('/')[1] ?? ''];

    if (!teamId) return sendError(res, 400, '缺少队伍 id');

    if (!sub && req.method === 'GET') {
      const result = await handleTeamOverview(teamId, readSettings());
      return sendJson(res, result.status, result.body);
    }

    if (!sub && req.method === 'DELETE') {
      if (!db.getTeam(teamId)) return sendError(res, 404, '队伍不存在');
      db.deleteTeam(teamId);
      return sendJson(res, 200, { ok: true });
    }

    if (!sub && req.method === 'PATCH') {
      try {
        const body = await readJsonBody(req);
        if (!db.renameTeam(teamId, body?.name)) return sendError(res, 404, '队伍不存在');
        return sendJson(res, 200, { team: db.getTeam(teamId) });
      } catch (error) {
        return sendError(res, 400, error.message);
      }
    }

    // 成员增删
    if (sub === 'members' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        if (!db.getTeam(teamId)) return sendError(res, 404, '队伍不存在');
        const handleKey = db.normalizeHandle(body?.handle);
        if (!handleKey) return sendError(res, 400, '请填写成员账号');
        // 顺带把这个人加载进来：不然新加的成员没有 rating、没有知识画像，
        // 分工时会被当成"什么都不会"的新号，分到的方向会很难看。
        try {
          await loadUser(handleKey);
        } catch (error) {
          // 抓不到也不挡着加人：可以先加进来，之后联网再同步。
          // 但要把原因回给前端，免得用户以为加成功了却什么都没有。
          db.addTeamMember(teamId, handleKey, body?.role);
          return sendJson(res, 201, {
            member: { handleKey, role: body?.role ?? 'member' },
            warning: `成员已加入，但抓取 ${handleKey} 的数据失败：${error.message}`,
          });
        }
        db.addTeamMember(teamId, handleKey, body?.role);
        return sendJson(res, 201, { member: { handleKey, role: body?.role ?? 'member' } });
      } catch (error) {
        return sendError(res, 400, error.message);
      }
    }

    if (sub === 'members' && req.method === 'DELETE') {
      const handleKey = db.normalizeHandle(url.searchParams.get('handle'));
      if (!handleKey) return sendError(res, 400, '缺少 handle');
      if (!db.removeTeamMember(teamId, handleKey)) return sendError(res, 404, '该成员不在队伍里');
      return sendJson(res, 200, { ok: true });
    }

    // 重算分工（成员或数据变了之后手动触发）
    if (sub === 'assign' && req.method === 'POST') {
      const settings = readSettings();
      const members = teamMembersWithProfiles(teamId, settings);
      if (!db.getTeam(teamId)) return sendError(res, 404, '队伍不存在');
      if (!members.length) return sendError(res, 400, '队伍里还没有成员');
      const allocation = assignAxes(members);
      db.saveTeamAssignments(
        teamId,
        allocation.byMember.flatMap((m) => [
          ...m.main.map((axis) => ({ handleKey: m.handleKey, axis, kind: 'main' })),
          ...m.sub.map((axis) => ({ handleKey: m.handleKey, axis, kind: 'sub' })),
        ]),
      );
      return sendJson(res, 200, {
        assignment: allocation.byMember.map((m) => ({
          ...m,
          display: members.find((x) => x.handleKey === m.handleKey)?.display ?? m.handleKey,
        })),
      });
    }

    if (sub === 'plan' && req.method === 'GET') {
      try {
        const result = handleTeamPlan(teamId, url, readSettings());
        return sendJson(res, result.status, result.body);
      } catch (error) {
        return sendError(res, 500, `团队排题失败：${error.message}`);
      }
    }

    return sendError(res, 404, '接口不存在');
  }

  if (pathname === '/api/progress' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const handleKey = db.normalizeHandle(body.handle);
      const target = Number(body.target);
      const contestId = Number(body.contestId);
      if (!handleKey || !Number.isFinite(target) || !Number.isFinite(contestId) || !body.index) {
        return sendError(res, 400, '参数不完整');
      }
      db.setProgress(handleKey, target, contestId, String(body.index), Boolean(body.done));
      return sendJson(res, 200, { ok: true });
    } catch (error) {
      return sendError(res, 400, error.message);
    }
  }

  // 做题手感：秒了 / 刚好 / 卡住 / 看题解，用来把练习区间上下微调。
  // 这条路由在 19e6c08（撤背景图那次）被连着一块删掉了，0.1.7 里这四个按钮点了只弹「接口不存在」，
  // 0.1.8 补回来。读的那一头一直没断——历史手感一直跟着 /api/plan 返回，所以老记录不用补录。
  if (pathname === '/api/feedback' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const handleKey = db.normalizeHandle(body.handle);
      const contestId = Number(body.contestId);
      if (!handleKey || !Number.isFinite(contestId) || !body.index) {
        return sendError(res, 400, '参数不完整');
      }
      const allowed = ['too_easy', 'ok', 'hard', 'read_editorial'];
      if (!allowed.includes(body.feel)) {
        return sendError(res, 400, 'feel 只能是 too_easy / ok / hard / read_editorial');
      }
      db.setProblemFeedback(handleKey, contestId, String(body.index), body.feel);
      return sendJson(res, 200, { ok: true, shift: db.feedbackShift(handleKey) });
    } catch (error) {
      return sendError(res, 400, error.message);
    }
  }

  // 换一道题：同方向、难度最接近、没做过、也不在现有计划里
  if (pathname === '/api/plan/replace' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const handleKey = db.normalizeHandle(body.handle);
      const target = Math.round(Number(body.target));
      const contestId = Number(body.contestId);
      const index = String(body.index ?? '');
      if (!handleKey || !Number.isFinite(target) || !Number.isFinite(contestId) || !index) {
        return sendError(res, 400, '参数不完整');
      }

      const fromKey = `${contestId}-${index}`;
      const from = db.getProblemsByKeys([fromKey]).get(fromKey);
      if (!from) return sendError(res, 404, '题库里找不到这道题，先同步一次题库');

      // 客户端传上来的「当前计划里已有的题」，再加上你已经做过的题
      const exclude = new Set(
        (Array.isArray(body.exclude) ? body.exclude : []).map(String).filter(Boolean).slice(0, 800),
      );
      for (const key of deriveProgress(db.getSubmissions(handleKey)).solved.keys()) exclude.add(key);

      const picked = pickReplacement({ from, exclude, handleKey });
      if (!picked) return sendError(res, 404, '这个方向、这个难度已经没有别的题了，可以直接屏蔽掉它');

      const toKey = `${picked.contestId}-${picked.index}`;
      db.setPlanSwap(handleKey, target, fromKey, toKey);
      // 换到第 3 次就别再换了：多半是这道题不适合你，建议直接屏蔽
      const swapped = db.bumpSwapCount(handleKey, fromKey);
      return sendJson(res, 200, {
        fromKey,
        problem: { ...toClientProblem(picked), swappedFrom: fromKey },
        swappedTimes: swapped,
        hint:
          swapped >= 3
            ? `这道题已经换过 ${swapped} 次了。要不直接屏蔽它？后面不再给你推荐这道题。`
            : null,
      });
    } catch (error) {
      return sendError(res, 400, error.message);
    }
  }

  // 放到本轮最后 / 取消
  if (pathname === '/api/plan/defer' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const handleKey = db.normalizeHandle(body.handle);
      const target = Math.round(Number(body.target));
      const key = String(body.key ?? '');
      if (!handleKey || !Number.isFinite(target) || !key) return sendError(res, 400, '参数不完整');
      db.setPlanDefer(handleKey, target, key, Boolean(body.deferred));
      return sendJson(res, 200, { ok: true, deferred: db.listPlanDefer(handleKey, target).size });
    } catch (error) {
      return sendError(res, 400, error.message);
    }
  }

  // 撤销换题：只撤一道，或者把当前目标的换题记录全清掉
  if (pathname === '/api/plan/swap/clear' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const handleKey = db.normalizeHandle(body.handle);
      const target = Math.round(Number(body.target));
      if (!handleKey || !Number.isFinite(target)) return sendError(res, 400, '参数不完整');
      if (body.all) db.clearPlanSwaps(handleKey, target);
      else if (body.fromKey) db.clearPlanSwap(handleKey, target, String(body.fromKey));
      else return sendError(res, 400, '参数不完整');
      return sendJson(res, 200, { ok: true, swapCount: db.listPlanSwaps(handleKey, target).size });
    } catch (error) {
      return sendError(res, 400, error.message);
    }
  }

  // 补题队列：提交过但没通过的题
  if (pathname === '/api/review-queue' && req.method === 'GET') {
    const handleKey = db.normalizeHandle(url.searchParams.get('handle'));
    if (!handleKey) return sendError(res, 400, '请先填写 Codeforces 用户名');
    const sort = url.searchParams.get('sort') ?? 'stale';
    const { items, missing } = buildReviewQueue(handleKey, sort);
    return sendJson(res, 200, { total: items.length, missing, sort, items });
  }

  // 成长报告：每周做题量/难度 + 比赛前后对照
  if (pathname === '/api/growth' && req.method === 'GET') {
    const handleKey = db.normalizeHandle(url.searchParams.get('handle'));
    if (!handleKey) return sendError(res, 400, '请先填写 Codeforces 用户名');
    const weeks = Math.max(4, Math.min(52, Number(url.searchParams.get('weeks') || 26)));
    return sendJson(res, 200, buildGrowthReport(handleKey, weeks));
  }

  // 用过的账号列表（多账号切换用）
  if (pathname === '/api/handles' && req.method === 'GET') {
    return sendJson(res, 200, { handles: db.listKnownHandles() });
  }

  // 两个账号对比：各方向 75 分位、每周做题量、同一道题谁先做出来
  if (pathname === '/api/compare' && req.method === 'GET') {
    const rawBase = url.searchParams.get('handle');
    const rawOther = url.searchParams.get('other');
    const baseKey = db.normalizeHandle(rawBase);
    const otherKey = db.normalizeHandle(rawOther);
    if (!baseKey || !otherKey) return sendError(res, 400, '需要两个账号');
    if (baseKey === otherKey) return sendError(res, 400, '这是当前账号自己，换一个 ID 吧');

    // 对比不要求先在上面把对方「加载」过：库里没有就顺手抓一次。
    // 已经抓过的走 6 小时缓存，来回切着看不会反复请求 Codeforces。
    try {
      await ensureProblems();
      await loadUser(baseKey, { force: false });
      await loadUser(rawOther, { force: false });
    } catch (error) {
      const message = error instanceof cf.CfError ? error.message : `抓取失败：${error.message}`;
      return sendError(res, 502, `读不到 ${rawOther} 的数据：${message}`);
    }

    const base = axisProfileOf(baseKey);
    const other = axisProfileOf(otherKey);
    // 对比只看 Codeforces 的过题：AtCoder 的记录挂在同一个 CF 账号下面，
    // 混进「谁先做出来」会让两个号看起来做过一模一样的 AtCoder 题
    const cfSubmissionsOf = (key) =>
      db.getSubmissions(key).filter((row) => row.platform !== 'atcoder');
    const baseSolved = deriveProgress(cfSubmissionsOf(baseKey)).solved;
    const otherSolved = deriveProgress(cfSubmissionsOf(otherKey)).solved;

    // 方向差异
    const axes = base.axes.map((row, index) => {
      const peer = other.axes[index];
      const left = row.count ? row.representative : null;
      const right = peer?.count ? peer.representative : null;
      return {
        axis: row.axis,
        base: left,
        other: right,
        diff: left != null && right != null ? left - right : null,
      };
    });

    // 同一道题谁先做出来（只列两边都做过的）
    const problemMap = new Map(allProblems().map((problem) => [`${problem.contestId}-${problem.index}`, problem]));
    const shared = [];
    for (const [key, info] of baseSolved) {
      const peer = otherSolved.get(key);
      if (!peer) continue;
      const problem = problemMap.get(key);
      shared.push({
        contestId: problem?.contestId ?? Number(key.slice(0, key.indexOf('-'))),
        index: problem?.index ?? key.slice(key.indexOf('-') + 1),
        name: problem?.name ?? '（题库里没有这道题）',
        rating: problem?.rating ?? null,
        baseAt: info?.at ?? null,
        otherAt: peer?.at ?? null,
        first: (info?.at ?? 0) < (peer?.at ?? 0) ? 'base' : 'other',
      });
    }
    shared.sort((a, b) => Math.max(b.baseAt ?? 0, b.otherAt ?? 0) - Math.max(a.baseAt ?? 0, a.otherAt ?? 0));

    return sendJson(res, 200, {
      base: {
        handle: baseKey,
        display: base.user?.displayHandle ?? baseKey,
        rating: base.user?.rating ?? null,
        maxRating: base.user?.maxRating ?? null,
        solvedCount: base.solvedCount,
        weekly: buildGrowthReport(baseKey, 26).weeks,
      },
      other: {
        handle: otherKey,
        display: other.user?.displayHandle ?? otherKey,
        rating: other.user?.rating ?? null,
        maxRating: other.user?.maxRating ?? null,
        solvedCount: other.solvedCount,
        weekly: buildGrowthReport(otherKey, 26).weeks,
      },
      axes,
      shared: shared.slice(0, 40),
      sharedCount: shared.length,
    });
  }

  // 队列里标「已补 / 不再提示」，或者撤销这个标记
  if (pathname === '/api/review-queue/done' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const handleKey = db.normalizeHandle(body.handle);
      const contestId = Number(body.contestId);
      if (!handleKey || !Number.isFinite(contestId) || !body.index) {
        return sendError(res, 400, '参数不完整');
      }
      db.setReviewDone(handleKey, contestId, String(body.index), Boolean(body.done));
      return sendJson(res, 200, {
        ok: true,
        total: buildReviewQueue(handleKey, 'stale').items.length,
      });
    } catch (error) {
      return sendError(res, 400, error.message);
    }
  }

  // 「今天补一个方向」：临时往某一天塞几道指定方向的题，不占计划配额。
  // 和 /api/feedback 一样是 19e6c08 误删的；挑题的 pickAxisExtras 一直在，补回路由就能用。
  if (pathname === '/api/plan/extra' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const handleKey = db.normalizeHandle(body.handle);
      const date = String(body.date ?? '').slice(0, 10);
      if (!handleKey) return sendError(res, 400, '缺少 handle');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendError(res, 400, 'date 格式不对');
      const axis = String(body.axis ?? '');
      if (!axis) return sendError(res, 400, '缺少方向');
      const exclude = new Set(
        (Array.isArray(body.exclude) ? body.exclude : []).map(String).filter(Boolean).slice(0, 800),
      );
      const picked = pickAxisExtras({ handleKey, axis, count: 3, exclude });
      if (!picked.length) return sendError(res, 404, `「${axis}」这个方向暂时没有合适的题`);
      db.addExtraTasks(
        handleKey,
        date,
        picked.map((problem) => `${problem.contestId}-${problem.index}`),
      );
      return sendJson(res, 200, {
        ok: true,
        problems: picked.map(toClientProblem),
        keys: db.listExtraTasks(handleKey, date),
      });
    } catch (error) {
      return sendError(res, 400, error.message);
    }
  }

  // 把一道补题塞进某一天（默认今天）
  if (pathname === '/api/schedule/extra' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const handleKey = db.normalizeHandle(body.handle);
      const date = String(body.date ?? '');
      const contestId = Number(body.contestId);
      if (!handleKey || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(contestId) || !body.index) {
        return sendError(res, 400, '参数不完整');
      }
      db.addScheduleExtra(handleKey, date, contestId, String(body.index));
      return sendJson(res, 200, { ok: true });
    } catch (error) {
      return sendError(res, 400, error.message);
    }
  }

  // 从某一天里拿掉额外安排的题
  if (pathname === '/api/schedule/extra' && req.method === 'DELETE') {
    try {
      const body = await readJsonBody(req);
      const handleKey = db.normalizeHandle(body.handle);
      const date = String(body.date ?? '');
      const contestId = Number(body.contestId);
      if (!handleKey || !date || !Number.isFinite(contestId) || !body.index) {
        return sendError(res, 400, '参数不完整');
      }
      db.removeScheduleExtra(handleKey, date, contestId, String(body.index));
      return sendJson(res, 200, { ok: true });
    } catch (error) {
      return sendError(res, 400, error.message);
    }
  }

  if (pathname.startsWith('/api/')) {
    return sendError(res, 404, '接口不存在');
  }

  return serveStatic(res, pathname);
}

async function serveStatic(res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = normalize(join(PUBLIC_DIR, relative));
  const root = normalize(PUBLIC_DIR + sep);

  if (!target.startsWith(root)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const data = await readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME.get(extname(target)) ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('页面不存在');
  }
}

const requestHandler = (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  route(req, res, url).catch((error) => {
    console.error('[server]', error);
    if (!res.headersSent) sendError(res, 500, error.message);
  });
};

/**
 * 启动服务。桌面程序传 port: 0 让系统分配空闲端口，避免和别的程序撞车。
 * 返回 { server, port, url }。
 */
export function startServer({ port = DEFAULT_PORT, host = DEFAULT_HOST, quiet = false } = {}) {
  const server = createServer(requestHandler);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actualPort = server.address().port;
      const url = `http://${host}:${actualPort}`;
      if (!quiet) {
        console.log('');
        console.log('  ACM 训练台已启动');
        console.log(`  在浏览器里打开：${url}`);
        console.log('  按 Ctrl+C 停止');
        console.log('');
      }
      resolve({ server, port: actualPort, url });
    });
  });
}

// 直接用 node server.js 运行时才自动启动；被桌面程序 import 时不启动。
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  startServer().catch((error) => {
    console.error('启动失败：', error.message);
    process.exit(1);
  });
}
