import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as cf from './lib/cf.js';
import * as db from './lib/db.js';
import { buildPlan, deriveProgress, problemUrl, rankFocusTags, toClientProblem } from './lib/plan.js';
import { buildKnowledgeProfile, buildTagProfile, isNoiseTag, knowledgeAxis } from './lib/knowledge.js';
import {
  analyzeVirtualSession,
  divisionFit,
  parseContestInfo,
  recommendVirtualContests,
} from './lib/contests.js';
import { fetchLuogu, fetchNowcoder, PlatformError } from './lib/platforms.js';
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
  const { solved, attempted } = deriveProgress(submissions);
  return {
    ...user,
    submissionCount: submissions.length,
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
      // 评估水平时忽略「比当前 rating 低多少分」以内的题（null = 用默认值）
      floorGap: raw.floor_gap === undefined ? null : Number(raw.floor_gap),
      // 单个标签在题单里的占比上限，存的是百分数（null = 用默认值 40）
      tagShare: raw.tag_share === undefined ? null : Number(raw.tag_share),
      // 训练计划里是否隐藏标签（题单不显示算法方向，自己判断）
      hideTags: raw.hide_tags === '1',
      // 每天打卡提醒的时间（'HH:MM'，null = 关闭）
      remindAt: raw.remind_at ?? null,
      // 上一次提醒是哪天（'YYYY-MM-DD'），避免同一天反复弹
      remindLast: raw.remind_last ?? null,
      // 自定义背景图：图片文件存在数据目录里，这里只记一个版本号（换图时 +1，用来刷缓存）
      bgImage: raw.bg_image ? Number(raw.bg_image) : null,
      // 背景图的显示强度（0~1）和模糊像素
      bgOpacity: raw.bg_opacity === undefined ? null : Number(raw.bg_opacity),
      bgBlur: raw.bg_blur === undefined ? null : Number(raw.bg_blur),
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
const PLAN_VERSION = 4;

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

  // 训练过的推题模型（可能没有，或者没通过验证）
  const model = modelModule.parseModel(db.metaGet(modelModule.MODEL_KEY));

  const handleKey = db.normalizeHandle(rawHandle);
  const user = db.getUser(handleKey);
  const submissions = db.getSubmissions(handleKey);
  const { solved, attempted } = deriveProgress(submissions);

  // ---- 这一版开始，计划会「钉住」----
  // 之前每次刷新都重新挑一遍：你做过的题会被悄悄换掉，计划一直在漂，
  // 也看不出自己做到哪了。现在只有设置变了、或者点了「重新生成计划」才重挑。
  const settings = readSettings();
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
      contestDates: new Map(db.getContests().map((contest) => [contest.id, contest.startTime])),
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
  const contestDateMap = new Map(db.getContests().map((contest) => [contest.id, contest.startTime]));
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

  return {
    weeks: series,
    contests: recentContests,
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
  const now = Math.floor(Date.now() / 1000);

  const items = keys.map((key) => {
    const problem = problems.get(key);
    const at = lastAt.get(key) ?? null;
    const contestId = Number(key.slice(0, key.indexOf('-')));
    const index = key.slice(key.indexOf('-') + 1);
    return {
      contestId,
      index,
      name: problem?.name ?? '（题库里没有这道题，先同步一次题库）',
      rating: problem?.rating ?? null,
      tags: problem?.tags ?? [],
      // gym 的题目路径和普通题库不一样，统一走同一个函数
      url: problemUrl(contestId, index),
      attempts: attempted.get(key) ?? 0,
      lastAt: at,
      idleDays: at ? Math.max(0, Math.round((now - at) / 86400)) : null,
    };
  });

  if (sort === 'rating') items.sort((a, b) => (a.rating ?? 9999) - (b.rating ?? 9999));
  else if (sort === 'rating-desc') items.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  else items.sort((a, b) => (a.lastAt ?? 0) - (b.lastAt ?? 0));
  return items;
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
  const candidates = allProblems().filter((problem) => {
    if (problem.rating == null || from.rating == null) return false;
    const key = `${problem.contestId}-${problem.index}`;
    if (key === `${from.contestId}-${from.index}`) return false;
    if (exclude.has(key) || blocked.has(key)) return false;
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
async function handleCalendar(url) {
  const days = Math.min(60, Math.max(1, Number(url.searchParams.get('days') || 14)));
  const rawHandle = url.searchParams.get('handle');
  const contestsState = await ensureContests();

  const now = Math.floor(Date.now() / 1000);
  const until = now + days * 86400;
  const upcoming = db
    .getUpcomingContests(200)
    .filter((contest) => contest.type === 'CF' && contest.startTime <= until);

  let current = null;
  if (rawHandle) {
    const cached = db.getUser(db.normalizeHandle(rawHandle));
    if (cached?.rating) current = cached.rating;
  }

  return {
    contestsState,
    now,
    days,
    upcoming: upcoming.map((contest) => {
      const info = parseContestInfo(contest.name);
      return {
        id: contest.id,
        name: contest.name,
        division: info.division,
        startTime: contest.startTime,
        durationSeconds: contest.duration,
        url: `https://codeforces.com/contest/${contest.id}`,
        fit: current == null ? null : divisionFit(info.division, current),
      };
    }),
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
      // 背景图的显示强度（百分数）和模糊（像素）
      if (body.bgOpacity !== undefined) {
        const value = Number(body.bgOpacity);
        if (!Number.isFinite(value) || value < 0 || value > 1) {
          return sendError(res, 400, '背景强度请在 0 到 1 之间');
        }
        patch.bg_opacity = String(Math.round(value * 100) / 100);
      }
      if (body.bgBlur !== undefined) {
        const value = Number(body.bgBlur);
        if (!Number.isFinite(value) || value < 0 || value > 24) {
          return sendError(res, 400, '背景模糊请在 0 到 24 之间');
        }
        patch.bg_blur = String(Math.round(value));
      }
      // 训练计划里是否隐藏标签
      if (body.hideTags !== undefined) patch.hide_tags = body.hideTags ? '1' : '';
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

  // ---------- 自定义背景图 ----------
  // 图片存在数据目录里（background.png/jpg/…），设置里只记一个版本号用来刷缓存。
  // 浏览器拿不到本地文件路径，所以由界面把图片 POST 上来，服务端落盘。
  if (pathname === '/api/background') {
    const exts = ['png', 'jpg', 'webp', 'gif'];
    const findExisting = () => {
      for (const ext of exts) {
        const file = join(db.DATA_DIR, `background.${ext}`);
        if (existsSync(file)) return { file, ext };
      }
      return null;
    };

    if (req.method === 'GET') {
      const found = findExisting();
      if (!found) return sendError(res, 404, '还没有设置背景图');
      const type =
        found.ext === 'jpg'
          ? 'image/jpeg'
          : found.ext === 'webp'
            ? 'image/webp'
            : found.ext === 'gif'
              ? 'image/gif'
              : 'image/png';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' });
      createReadStream(found.file).pipe(res);
      return;
    }

    if (req.method === 'POST') {
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 12 * 1024 * 1024) {
            return sendError(res, 413, '图片太大了，最多 12 MB');
          }
          chunks.push(chunk);
        }
        const body = Buffer.concat(chunks);
        if (!body.length) return sendError(res, 400, '没有收到图片数据');

        const contentType = String(req.headers['content-type'] ?? '');
        const ext = contentType.includes('jpeg') || contentType.includes('jpg')
          ? 'jpg'
          : contentType.includes('webp')
            ? 'webp'
            : contentType.includes('gif')
              ? 'gif'
              : 'png';

        for (const other of exts) {
          rmSync(join(db.DATA_DIR, `background.${other}`), { force: true });
        }
        writeFileSync(join(db.DATA_DIR, `background.${ext}`), body);
        const version = Date.now();
        db.saveSettings({ bg_image: String(version) });
        return sendJson(res, 200, { ok: true, version, size: body.length, ext });
      } catch (error) {
        return sendError(res, 400, `保存背景图失败：${error.message}`);
      }
    }

    if (req.method === 'DELETE') {
      for (const other of exts) {
        rmSync(join(db.DATA_DIR, `background.${other}`), { force: true });
      }
      db.saveSettings({ bg_image: '' });
      return sendJson(res, 200, { ok: true });
    }
  }

  // ---------- 做题手感反馈：自己标一下这道题是秒的还是啃出来的 ----------
  if (pathname === '/api/feedback') {
    const handleKey = db.normalizeHandle(url.searchParams.get('handle'));
    if (req.method === 'GET') {
      if (!handleKey) return sendError(res, 400, '缺少 handle');
      return sendJson(res, 200, {
        feedback: db.listProblemFeedback(handleKey, 200),
        shift: db.feedbackShift(handleKey),
      });
    }
    if (req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const key = db.normalizeHandle(body.handle);
        if (!key || !body.index || !Number.isFinite(Number(body.contestId))) {
          return sendError(res, 400, '参数不完整');
        }
        const allowed = ['too_easy', 'ok', 'hard', 'read_editorial'];
        const feel = allowed.includes(body.feel) ? body.feel : null;
        if (!feel) return sendError(res, 400, 'feel 只能是 too_easy / ok / hard / read_editorial');
        db.setProblemFeedback(key, Number(body.contestId), String(body.index), feel);
        return sendJson(res, 200, { ok: true, shift: db.feedbackShift(key) });
      } catch (error) {
        return sendError(res, 400, error.message);
      }
    }
  }

  // ---------- 今天补一个方向：临时往日程里塞几道某方向的题 ----------
  if (pathname === '/api/plan/extra') {
    const handleKey = db.normalizeHandle(url.searchParams.get('handle'));
    if (!handleKey) return sendError(res, 400, '缺少 handle');
    if (req.method === 'GET') {
      const date = url.searchParams.get('date');
      if (!date) return sendError(res, 400, '缺少 date');
      return sendJson(res, 200, { keys: db.listExtraTasks(handleKey, date) });
    }
    if (req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const action = String(body.action ?? 'add');
        const date = String(body.date ?? '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendError(res, 400, 'date 格式不对');
        if (action === 'clear') {
          db.clearExtraTasks(handleKey, date);
          return sendJson(res, 200, { ok: true, keys: [] });
        }
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
  }

  // ---------- 复盘卡：最近 20 题的表现，和上一轮比 ----------
  if (pathname === '/api/retro' && req.method === 'GET') {
    const handleKey = db.normalizeHandle(url.searchParams.get('handle'));
    if (!handleKey) return sendError(res, 400, '缺少 handle');
    try {
      return sendJson(res, 200, buildRetroCard(handleKey));
    } catch (error) {
      return sendError(res, 500, `复盘算不出来：${error.message}`);
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
    return sendJson(res, 200, { platforms: db.listPlatformStats() });
  }

  // 手动屏蔽的题目：屏蔽后永远不再出现在推荐里
  if (pathname === '/api/blocked' && req.method === 'GET') {
    const rawHandle = url.searchParams.get('handle');
    if (!rawHandle) return sendError(res, 400, '请先填写 Codeforces 用户名');
    return sendJson(res, 200, { blocked: db.listBlockedProblems(db.normalizeHandle(rawHandle)) });
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
      solved: db.recentlySolved(handleKey, limit, offset),
    });
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
      return sendJson(res, 200, { blocked: db.listBlockedProblems(handleKey) });
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
      return sendJson(res, 200, { blocked: db.listBlockedProblems(handleKey) });
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
      db.savePlatformStats(result);
      return sendJson(res, 200, { result, platforms: db.listPlatformStats() });
    } catch (error) {
      const message = error instanceof PlatformError ? error.message : `同步失败：${error.message}`;
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
    const items = buildReviewQueue(handleKey, sort);
    return sendJson(res, 200, { total: items.length, sort, items });
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
    const baseSolved = deriveProgress(db.getSubmissions(baseKey)).solved;
    const otherSolved = deriveProgress(db.getSubmissions(otherKey)).solved;

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
      return sendJson(res, 200, { ok: true, total: buildReviewQueue(handleKey, 'stale').length });
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
