// 本地 SQLite 缓存。用 Node 内置的 node:sqlite，不需要装任何依赖。

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = join(HERE, '..');

// 数据目录可以外部指定：桌面程序打包后安装目录是只读的，
// 数据库必须放到用户数据目录，所以由启动方通过环境变量告知。
export const DATA_DIR = process.env.ACM_TRAINER_DATA_DIR
  ? resolve(process.env.ACM_TRAINER_DATA_DIR)
  : join(PROJECT_ROOT, 'data');

mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(join(DATA_DIR, 'trainer.db'));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS meta (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
  );

  -- 用户自己的设置（记住用户名、目标分数等），和服务端缓存分开存
  CREATE TABLE IF NOT EXISTS settings (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
  );

  -- 其他 OJ 平台抓到的汇总数据（牛客、洛谷…）
  CREATE TABLE IF NOT EXISTS platform_stats (
    platform   TEXT    NOT NULL,
    account    TEXT    NOT NULL,
    nickname   TEXT,
    stats      TEXT    NOT NULL,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (platform, account)
  );

  CREATE TABLE IF NOT EXISTS problems (
    contest_id   INTEGER NOT NULL,
    idx          TEXT    NOT NULL,
    name         TEXT    NOT NULL,
    rating       INTEGER,
    tags         TEXT    NOT NULL,
    solved_count INTEGER NOT NULL DEFAULT 0,
    type         TEXT    NOT NULL DEFAULT 'PROGRAMMING',
    -- 题目来源。默认值让老库一升级就是「全是 Codeforces」，行为不变
    platform       TEXT NOT NULL DEFAULT 'codeforces',
    -- 平台自己的题号（AtCoder 是 abc300_e），拼题目链接用
    native_id      TEXT,
    -- 平台自己的比赛标识（AtCoder 是 abc300）
    native_contest TEXT,
    -- 平台自己的难度（AtCoder 是 Kenkoooo difficulty），折算后的值在 rating 里
    native_rating  INTEGER,
    PRIMARY KEY (contest_id, idx)
  );

  -- AtCoder 的「比赛 → 本工具内部的数字 id」映射。
  -- 计划题号、打勾进度、屏蔽记录都按 (contest_id, idx) 存，而 AtCoder 没有数字比赛号，
  -- 所以统一从 3000000 起分配；映射留在库里，重新导入题库时 id 不会变，
  -- 老计划里的 AtCoder 题就不会突然「题库里没有了」。
  CREATE TABLE IF NOT EXISTS atcoder_contests (
    contest_key TEXT    PRIMARY KEY,
    contest_id  INTEGER NOT NULL UNIQUE,
    start_time  INTEGER
  );

  -- 洛谷的「题号 → 内部数字 id」。洛谷题目没有比赛号，计划里的题号又必须是
  -- (contest_id, idx) 这一对，所以从 4000000 起给每个题号分配一个稳定的内部 id，
  -- 真正的题号（P1001 这种）存在 problems.native_id 里，界面上显示的就是它。
  CREATE TABLE IF NOT EXISTS luogu_ids (
    native_id  TEXT    PRIMARY KEY,
    contest_id INTEGER NOT NULL UNIQUE
  );

  -- 训练「能不能做出这道题」用的样本：一个人在某一题上的结果
  CREATE TABLE IF NOT EXISTS model_samples (
    contest_id     INTEGER NOT NULL,
    handle         TEXT    NOT NULL,
    idx            TEXT    NOT NULL,
    rating         INTEGER NOT NULL,  -- 参赛者赛前 rating
    solved         INTEGER NOT NULL,  -- 0/1
    problem_rating INTEGER,
    tags           TEXT    NOT NULL DEFAULT '[]',
    at             INTEGER,           -- 这场比赛的时间，用来做时间切分
    PRIMARY KEY (contest_id, handle, idx)
  );

  CREATE INDEX IF NOT EXISTS idx_model_samples_contest ON model_samples (contest_id);

  CREATE TABLE IF NOT EXISTS users (
    handle_key     TEXT PRIMARY KEY,
    display_handle TEXT NOT NULL,
    rating         INTEGER,
    max_rating     INTEGER,
    rank           TEXT,
    max_rank       TEXT,
    title_photo    TEXT,
    updated_at     INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS submissions (
    id         INTEGER PRIMARY KEY,
    handle_key TEXT    NOT NULL,
    contest_id INTEGER NOT NULL,
    idx        TEXT    NOT NULL,
    verdict    TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    -- 提交来自哪个平台。AtCoder 的记录和 CF 存在同一张表里，
    -- 主键 id 用高位偏移区分，不会撞号（见 appendAtcoderSubmissions）
    platform   TEXT    NOT NULL DEFAULT 'codeforces'
  );

  CREATE INDEX IF NOT EXISTS idx_submissions_handle ON submissions (handle_key, created_at);

  CREATE TABLE IF NOT EXISTS rating_history (
    handle_key TEXT    NOT NULL,
    contest_id INTEGER NOT NULL,
    name       TEXT,
    rank       INTEGER,
    rating     INTEGER,
    at         INTEGER,
    PRIMARY KEY (handle_key, contest_id)
  );

  CREATE TABLE IF NOT EXISTS progress (
    handle_key TEXT    NOT NULL,
    target     INTEGER NOT NULL,
    contest_id INTEGER NOT NULL,
    idx        TEXT    NOT NULL,
    done       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (handle_key, target, contest_id, idx)
  );

  -- 手动换过的题：from 是被换掉的那道，to 是换上来的那道。
  -- 重新生成计划时按这张表把题换回去，不然每次生成都会把用户的调整冲掉。
  -- 做题手感反馈：提交记录看不出「是不是秒的」「是不是看了题解」
  CREATE TABLE IF NOT EXISTS problem_feedback (
    handle_key TEXT    NOT NULL,
    contest_id INTEGER NOT NULL,
    idx        TEXT    NOT NULL,
    feel       TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (handle_key, contest_id, idx)
  );

  -- 「今天补一个方向」临时加的题，只对某一天生效
  CREATE TABLE IF NOT EXISTS extra_tasks (
    handle_key TEXT    NOT NULL,
    date       TEXT    NOT NULL,
    contest_id INTEGER NOT NULL,
    idx        TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (handle_key, date, contest_id, idx)
  );

  CREATE TABLE IF NOT EXISTS plan_swaps (
    handle_key TEXT    NOT NULL,
    target     INTEGER NOT NULL,
    from_key   TEXT    NOT NULL,
    to_key     TEXT    NOT NULL,
    created_at INTEGER,
    PRIMARY KEY (handle_key, target, from_key)
  );

  -- 当前这份计划（题号清单）。没有它的话，每次刷新都会重新挑一遍：
  -- 你做过的题会被悄悄换掉，计划永远在漂，也看不出自己做到哪了。
  CREATE TABLE IF NOT EXISTS plan_snapshots (
    handle_key TEXT    NOT NULL,
    target     INTEGER NOT NULL,
    signature  TEXT    NOT NULL,
    created_at INTEGER,
    payload    TEXT    NOT NULL,
    PRIMARY KEY (handle_key, target)
  );

  -- 补题队列里手动「已补/不再提示」的题。做出来的题会自动出队（它不再是「没通过」），
  -- 这张表只记「我不想再看到它了」。
  CREATE TABLE IF NOT EXISTS review_done (
    handle_key TEXT    NOT NULL,
    contest_id INTEGER NOT NULL,
    idx        TEXT    NOT NULL,
    created_at INTEGER,
    PRIMARY KEY (handle_key, contest_id, idx)
  );

  -- 手动塞进某一天的额外题目（补题队列 → 排到今天）
  CREATE TABLE IF NOT EXISTS schedule_extras (
    handle_key TEXT    NOT NULL,
    date       TEXT    NOT NULL,
    contest_id INTEGER NOT NULL,
    idx        TEXT    NOT NULL,
    created_at INTEGER,
    PRIMARY KEY (handle_key, date, contest_id, idx)
  );

  -- 练习区间的自适应调整：每完成一轮（20 题）按表现上下挪 50 分，
  -- 记录当前挪了多少、上一轮算到第几题、以及理由（界面要写清楚为什么变）。
  CREATE TABLE IF NOT EXISTS plan_adjust (
    handle_key     TEXT    NOT NULL,
    target         INTEGER NOT NULL,
    shift          INTEGER NOT NULL DEFAULT 0,
    evaluated_done INTEGER NOT NULL DEFAULT 0,
    reason         TEXT,
    updated_at     INTEGER,
    PRIMARY KEY (handle_key, target)
  );

  -- 每道题被换过几次。换到第 3 次就该建议直接屏蔽了——一直换说明这道题
  -- 不适合你，而不是推荐算法错了。
  CREATE TABLE IF NOT EXISTS plan_swap_counter (
    handle_key TEXT    NOT NULL,
    from_key   TEXT    NOT NULL,
    count      INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER,
    PRIMARY KEY (handle_key, from_key)
  );

  -- 手动「放到本轮最后」的题
  CREATE TABLE IF NOT EXISTS plan_defer (
    handle_key TEXT    NOT NULL,
    target     INTEGER NOT NULL,
    key        TEXT    NOT NULL,
    created_at INTEGER,
    PRIMARY KEY (handle_key, target, key)
  );

  -- 每周存一次「各方向做到多少分」，用来画方向成长曲线。
  -- 这东西只能往后攒，所以从这一版开始每周记一次，前面的补不回来。
  CREATE TABLE IF NOT EXISTS growth_snapshots (
    handle_key TEXT    NOT NULL,
    week_key   TEXT    NOT NULL,
    payload    TEXT    NOT NULL,
    created_at INTEGER,
    PRIMARY KEY (handle_key, week_key)
  );

  -- 用过的 Codeforces 账号。多个账号之间数据本来就按 handle_key 分开存，
  -- 这张表只是记住「你用过谁」，方便一键切换和做对比。
  CREATE TABLE IF NOT EXISTS known_handles (
    handle_key TEXT PRIMARY KEY,
    display    TEXT NOT NULL,
    added_at   INTEGER
  );

  CREATE TABLE IF NOT EXISTS contests (
    id         INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    phase      TEXT,
    start_time INTEGER,
    duration   INTEGER NOT NULL DEFAULT 0,
    type       TEXT,
    cached_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_contests_start ON contests (start_time);

  CREATE TABLE IF NOT EXISTS virtual_sessions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    handle_key       TEXT    NOT NULL,
    contest_id       INTEGER NOT NULL,
    started_at       INTEGER NOT NULL,
    duration_seconds INTEGER NOT NULL,
    finished_at      INTEGER,
    status           TEXT    NOT NULL DEFAULT 'running'
  );

  CREATE INDEX IF NOT EXISTS idx_virtual_handle ON virtual_sessions (handle_key, started_at DESC);

  -- 用户手动屏蔽的题目：永久不再出现在推荐里
  CREATE TABLE IF NOT EXISTS blocked_problems (
    handle_key TEXT    NOT NULL,
    contest_id INTEGER NOT NULL,
    idx        TEXT    NOT NULL,
    name       TEXT,
    rating     INTEGER,
    reason     TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (handle_key, contest_id, idx)
  );
`);

// 老库升级：缺的列在这里补。ALTER TABLE 加列不做存在性判断，
// 列已经在时会报错，逐条 try 掉就是（SQLite 没有 IF NOT EXISTS 的加列语法）。
for (const sql of [
  'ALTER TABLE platform_stats ADD COLUMN extra TEXT',
  // AtCoder 支持（v0.1.7）：题目、提交记录都要标来源
  "ALTER TABLE problems ADD COLUMN platform TEXT NOT NULL DEFAULT 'codeforces'",
  'ALTER TABLE problems ADD COLUMN native_id TEXT',
  'ALTER TABLE problems ADD COLUMN native_contest TEXT',
  'ALTER TABLE problems ADD COLUMN native_rating INTEGER',
  "ALTER TABLE submissions ADD COLUMN platform TEXT NOT NULL DEFAULT 'codeforces'",
]) {
  try {
    db.exec(sql);
  } catch {
    /* 列已经存在 */
  }
}

export function metaGet(key) {
  const row = db.prepare('SELECT v FROM meta WHERE k = ?').get(key);
  return row ? row.v : null;
}

export function metaSet(key, value) {
  db.prepare(
    'INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
  ).run(key, String(value));
}

export function getSettings() {
  const rows = db.prepare('SELECT k, v FROM settings').all();
  const result = {};
  for (const row of rows) result[row.k] = row.v;
  return result;
}

/** 只更新传入的字段，没传的保持原样；传空字符串表示清除该项。 */
export function saveSettings(patch) {
  const statement = db.prepare(
    'INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
  );
  const remove = db.prepare('DELETE FROM settings WHERE k = ?');
  db.exec('BEGIN');
  try {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === null) continue;
      if (value === '') {
        remove.run(key);
        continue;
      }
      statement.run(key, String(value));
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getSettings();
}

export function countProblems() {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM problems').get().n);
}

/**
 * 用最新的 problem set 整体替换 Codeforces 题库（约 1 万条，事务内完成，很快）。
 * 只删 CF 那部分：AtCoder 题库在同一个表里，重新同步 CF 不该把它清掉。
 */
export function replaceProblems({ problems, problemStatistics }) {
  const solvedCounts = new Map();
  for (const stat of problemStatistics ?? []) {
    solvedCounts.set(`${stat.contestId}-${stat.index}`, Number(stat.solvedCount ?? 0));
  }

  const insert = db.prepare(`
    INSERT OR REPLACE INTO problems
      (contest_id, idx, name, rating, tags, solved_count, type, platform)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'codeforces')
  `);

  db.exec('BEGIN');
  try {
    db.exec("DELETE FROM problems WHERE platform = 'codeforces'");
    let inserted = 0;
    for (const problem of problems) {
      if (problem.contestId == null || !problem.index) continue;
      insert.run(
        problem.contestId,
        problem.index,
        problem.name ?? '',
        problem.rating ?? null,
        JSON.stringify(problem.tags ?? []),
        solvedCounts.get(`${problem.contestId}-${problem.index}`) ?? 0,
        problem.type ?? 'PROGRAMMING',
      );
      inserted += 1;
    }
    db.exec('COMMIT');
    return inserted;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** problems 表的一行 → 程序里用的题目对象（两个查询共用一套字段）。 */
function mapProblemRow(row) {
  return {
    contestId: row.contest_id,
    index: row.idx,
    name: row.name,
    rating: row.rating,
    tags: row.tags ? JSON.parse(row.tags) : [],
    solvedCount: row.solved_count,
    type: row.type,
    platform: row.platform ?? 'codeforces',
    nativeId: row.native_id ?? null,
    nativeContest: row.native_contest ?? null,
    nativeRating: row.native_rating ?? null,
  };
}

export function getAllProblems() {
  return db
    .prepare(
      `SELECT contest_id, idx, name, rating, tags, solved_count, type,
              platform, native_id, native_contest, native_rating
       FROM problems`,
    )
    .all()
    .map(mapProblemRow);
}

export function normalizeHandle(handle) {
  return String(handle ?? '').trim().toLowerCase();
}

// ---------- AtCoder 题库 ----------

/**
 * AtCoder 没有数字比赛号，统一从 3000000 起分配内部 id。
 * CF 的比赛号现在最大 4 位、gym 是 6 位（10xxxx），留出足够空档。
 */
const ATCODER_CONTEST_ID_BASE = 2999999;

/**
 * 整体替换 AtCoder 题库（ABC/ARC/AGC 里有难度估计的那些，约两千多道）。
 *
 * 两点注意：
 * 1. 只删 platform='atcoder' 的行，CF 题库不受影响；
 * 2. 比赛 id 映射表(atcoder_contests)不清空，重新导入后 id 不变，
 *    老计划里的题、打勾记录、屏蔽记录都还能对上。
 */
export function replaceAtcoderProblems(rows) {
  const findByKey = db.prepare('SELECT contest_id FROM atcoder_contests WHERE contest_key = ?');
  const maxId = db.prepare('SELECT COALESCE(MAX(contest_id), ?) AS n FROM atcoder_contests');
  const addContest = db.prepare(
    'INSERT INTO atcoder_contests (contest_key, contest_id, start_time) VALUES (?, ?, ?)',
  );
  const touchContest = db.prepare(
    'UPDATE atcoder_contests SET start_time = ? WHERE contest_key = ?',
  );
  const insert = db.prepare(`
    INSERT OR REPLACE INTO problems
      (contest_id, idx, name, rating, tags, solved_count, type,
       platform, native_id, native_contest, native_rating)
    VALUES (?, ?, ?, ?, '[]', 0, 'PROGRAMMING', 'atcoder', ?, ?, ?)
  `);

  db.exec('BEGIN');
  try {
    let next = Number(maxId.get(ATCODER_CONTEST_ID_BASE).n) + 1;
    const ids = new Map();
    for (const row of rows) {
      if (!row.nativeContest || !row.index) continue;
      if (ids.has(row.nativeContest)) continue;
      const found = findByKey.get(row.nativeContest);
      if (found) {
        ids.set(row.nativeContest, Number(found.contest_id));
        if (row.startTime) touchContest.run(row.startTime, row.nativeContest);
      } else {
        addContest.run(row.nativeContest, next, row.startTime ?? null);
        ids.set(row.nativeContest, next);
        next += 1;
      }
    }

    db.prepare("DELETE FROM problems WHERE platform = 'atcoder'").run();
    let inserted = 0;
    for (const row of rows) {
      const contestId = ids.get(row.nativeContest);
      if (contestId == null || !row.index) continue;
      insert.run(
        contestId,
        row.index,
        row.name ?? '',
        row.rating ?? null,
        row.nativeId ?? null,
        row.nativeContest,
        row.nativeRating ?? null,
      );
      inserted += 1;
    }
    db.exec('COMMIT');
    return inserted;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function countAtcoderProblems() {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM problems WHERE platform = 'atcoder'")
    .get();
  return Number(row?.n ?? 0);
}

// ---------- 洛谷题库 ----------

/** 洛谷题目没有比赛号，内部 id 从 4000000 起分配（AtCoder 用的是 3 开头）。 */
const LUOGU_CONTEST_ID_BASE = 3999999;

/**
 * 写入洛谷题库（按难度档抽页抓来的那批）。
 *
 * 删除是**按难度档**做的：这次抓了哪几档就只替换哪几档，
 * 先抓普及、再抓提高，普及那批不会被清掉。
 * 题号映射表（luogu_ids）不清空，重新导入后内部 id 不变，
 * 老计划、打勾记录、屏蔽记录都还对得上。
 */
export function replaceLuoguProblems(rows) {
  const findByNative = db.prepare('SELECT contest_id FROM luogu_ids WHERE native_id = ?');
  const maxId = db.prepare('SELECT COALESCE(MAX(contest_id), ?) AS n FROM luogu_ids');
  const addId = db.prepare('INSERT INTO luogu_ids (native_id, contest_id) VALUES (?, ?)');
  const insert = db.prepare(`
    INSERT OR REPLACE INTO problems
      (contest_id, idx, name, rating, tags, solved_count, type,
       platform, native_id, native_contest, native_rating)
    VALUES (?, ?, ?, ?, ?, ?, 'PROGRAMMING', 'luogu', ?, NULL, ?)
  `);

  db.exec('BEGIN');
  try {
    let next = Number(maxId.get(LUOGU_CONTEST_ID_BASE).n) + 1;
    const ids = new Map();
    for (const row of rows) {
      if (!row.nativeId || ids.has(row.nativeId)) continue;
      const found = findByNative.get(row.nativeId);
      if (found) {
        ids.set(row.nativeId, Number(found.contest_id));
      } else {
        addId.run(row.nativeId, next);
        ids.set(row.nativeId, next);
        next += 1;
      }
    }

    // 只替换这次抓到的难度档；一档一行都没抓到就别动库（抓取失败时不能把旧数据删了）
    const levels = [...new Set(rows.map((row) => row.level).filter(Number.isInteger))];
    if (!levels.length) {
      db.exec('COMMIT');
      return 0;
    }
    db.prepare(
      `DELETE FROM problems
       WHERE platform = 'luogu' AND native_rating IN (${levels.map(() => '?').join(', ')})`,
    ).run(...levels);

    let inserted = 0;
    for (const row of rows) {
      const contestId = ids.get(row.nativeId);
      if (contestId == null) continue;
      insert.run(
        contestId,
        // 一道题一行：idx 用洛谷题号，和 native_id 一致，键是 contest_id-idx
        row.nativeId,
        row.name ?? '',
        row.rating ?? null,
        JSON.stringify(row.tags ?? []),
        Number(row.accepted ?? 0),
        row.nativeId,
        row.level ?? null,
      );
      inserted += 1;
    }
    db.exec('COMMIT');
    return inserted;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function countLuoguProblems() {
  const row = db.prepare("SELECT COUNT(*) AS n FROM problems WHERE platform = 'luogu'").get();
  return Number(row?.n ?? 0);
}

/**
 * 洛谷「做过的题」入库。练习页没有时间信息，created_at 只能写 0——
 * 所以这些记录不参与热力图和做题记录（那边按时间排序），只用来
 * 「排除做过的题 + 自动打勾」。
 */
export function appendLuoguSolved(handleKey, rows) {
  const known = new Map(
    db
      .prepare("SELECT native_id, contest_id, idx FROM problems WHERE platform = 'luogu'")
      .all()
      .map((row) => [row.native_id, row]),
  );
  const insert = db.prepare(`
    INSERT OR IGNORE INTO submissions
      (id, handle_key, contest_id, idx, verdict, created_at, platform)
    VALUES (?, ?, ?, ?, 'OK', 0, 'luogu')
  `);

  db.exec('BEGIN');
  try {
    let inserted = 0;
    let skipped = 0;
    for (const row of rows) {
      const problem = known.get(row.pid);
      if (!problem) {
        skipped += 1;
        continue;
      }
      // 洛谷没有提交号，用题号的字符和拼一个稳定的负数做主键，
      // 和 CF 的提交号、AtCoder 的高位偏移都不会撞
      let hash = 0;
      for (const ch of String(row.pid)) hash = (hash * 31 + ch.charCodeAt(0)) % 900000000;
      insert.run(-(1000000000 + hash), handleKey, problem.contest_id, problem.idx);
      inserted += 1;
    }
    db.exec('COMMIT');
    return { inserted, skipped };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function countLuoguSolved(handleKey) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT 1 FROM submissions
         WHERE handle_key = ? AND platform = 'luogu' AND verdict = 'OK'
         GROUP BY contest_id, idx
       )`,
    )
    .get(handleKey);
  return Number(row?.n ?? 0);
}

/** AtCoder 各场比赛的开始时间，用来给题目算「年份偏好」（越新的题越靠前）。 */
export function listAtcoderContestDates() {
  return db
    .prepare('SELECT contest_id, start_time FROM atcoder_contests WHERE start_time IS NOT NULL')
    .all()
    .map((row) => [Number(row.contest_id), Number(row.start_time)]);
}

/** 按 'contestId-index' 精确取若干道题，换题时要拿新题的详细信息。 */
export function getProblemsByKeys(keys) {
  const result = new Map();
  if (!keys?.length) return result;
  const select = db.prepare(
    `SELECT contest_id, idx, name, rating, tags, solved_count, type,
            platform, native_id, native_contest, native_rating
     FROM problems WHERE contest_id = ? AND idx = ?`,
  );
  for (const key of keys) {
    const dash = String(key).indexOf('-');
    if (dash <= 0) continue;
    const contestId = Number(String(key).slice(0, dash));
    const index = String(key).slice(dash + 1);
    if (!Number.isFinite(contestId)) continue;
    const row = select.get(contestId, index);
    if (!row) continue;
    result.set(key, mapProblemRow(row));
  }
  return result;
}

export function saveUser(handleKey, info) {
  // 顺手记一下用过的账号，多账号切换和对比要用
  db.prepare(`
    INSERT INTO known_handles (handle_key, display, added_at)
    VALUES (?, ?, ?)
    ON CONFLICT(handle_key) DO UPDATE SET display = excluded.display
  `).run(handleKey, info.handle ?? handleKey, Date.now());

  db.prepare(`
    INSERT INTO users (handle_key, display_handle, rating, max_rating, rank, max_rank, title_photo, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(handle_key) DO UPDATE SET
      display_handle = excluded.display_handle,
      rating         = excluded.rating,
      max_rating     = excluded.max_rating,
      rank           = excluded.rank,
      max_rank       = excluded.max_rank,
      title_photo    = excluded.title_photo,
      updated_at     = excluded.updated_at
  `).run(
    handleKey,
    info.displayHandle ?? handleKey,
    info.rating ?? null,
    info.maxRating ?? null,
    info.rank ?? null,
    info.maxRank ?? null,
    info.titlePhoto ?? null,
    Date.now(),
  );
}

export function getUser(handleKey) {
  const row = db.prepare('SELECT * FROM users WHERE handle_key = ?').get(handleKey);
  if (!row) return null;
  return {
    handleKey: row.handle_key,
    displayHandle: row.display_handle,
    rating: row.rating,
    maxRating: row.max_rating,
    rank: row.rank,
    maxRank: row.max_rank,
    titlePhoto: row.title_photo,
    updatedAt: Number(row.updated_at),
  };
}

/**
 * 用完整的 Codeforces 提交记录整体替换（我们每次都抓全量，所以直接重建最省心）。
 * 只清 CF 的行，AtCoder 的记录留在库里。
 */
export function replaceSubmissions(handleKey, submissions) {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO submissions
      (id, handle_key, contest_id, idx, verdict, created_at, platform)
    VALUES (?, ?, ?, ?, ?, ?, 'codeforces')
  `);

  db.exec('BEGIN');
  try {
    db.prepare("DELETE FROM submissions WHERE handle_key = ? AND platform = 'codeforces'").run(
      handleKey,
    );
    let inserted = 0;
    for (const submission of submissions) {
      const problem = submission.problem ?? {};
      if (submission.id == null || problem.contestId == null || !problem.index) continue;
      insert.run(
        submission.id,
        handleKey,
        problem.contestId,
        problem.index,
        submission.verdict ?? 'UNKNOWN',
        Number(submission.creationTimeSeconds ?? 0),
      );
      inserted += 1;
    }
    db.exec('COMMIT');
    return inserted;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// ---------- 推题模型用的比赛样本 ----------
// 只留训练需要的字段：哪场比赛、谁、什么题、赛前多少分、做出来没有。
// 一行样本 = 一个人在某一题上的结果，几十万行也扛得住。

export function saveModelSamples(rows) {
  if (!rows.length) return 0;
  const statement = db.prepare(
    `INSERT INTO model_samples (contest_id, handle, idx, rating, solved, problem_rating, tags, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(contest_id, handle, idx) DO NOTHING`,
  );
  let inserted = 0;
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      const info = statement.run(
        row.contestId,
        row.handle,
        row.index,
        row.rating,
        row.solved ? 1 : 0,
        row.problemRating ?? null,
        JSON.stringify(row.tags ?? []),
        row.at ?? null,
      );
      inserted += info.changes ?? 0;
    }
    db.exec('COMMIT');
    return inserted;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function countModelSamples() {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM model_samples').get().n);
}

/** 已经采过样本的比赛，重跑时跳过，不用重新下载。 */
export function modelSampleContestIds() {
  return new Set(
    db.prepare('SELECT DISTINCT contest_id FROM model_samples').all().map((row) => row.contest_id),
  );
}

export function clearModelSamples() {
  db.exec('DELETE FROM model_samples');
}

/** 分页读出样本，避免一次性把几十万行都塞进内存。 */
export function getModelSamples(limit = 200000, offset = 0) {
  return db
    .prepare(
      `SELECT contest_id, rating, problem_rating, tags, solved, at
         FROM model_samples
        ORDER BY contest_id
        LIMIT ? OFFSET ?`,
    )
    .all(limit, offset)
    .map((row) => ({
      contestId: row.contest_id,
      rating: row.rating,
      problemRating: row.problem_rating,
      tags: parseJsonArray(row.tags),
      label: row.solved ? 1 : 0,
      at: row.at,
    }));
}

function parseJsonArray(text) {
  try {
    const value = JSON.parse(text ?? '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export function getSubmissions(handleKey) {
  return db
    .prepare(
      `SELECT id, contest_id, idx, verdict, created_at, platform
       FROM submissions WHERE handle_key = ? ORDER BY created_at ASC, id ASC`,
    )
    .all(handleKey)
    .map((row) => ({
      id: row.id,
      contestId: row.contest_id,
      index: row.idx,
      verdict: row.verdict,
      createdAt: Number(row.created_at),
      platform: row.platform ?? 'codeforces',
    }));
}

/**
 * 每日活动统计，用于热力图。
 * solved 是「当天首次通过的题数」，submissions 是当天总提交数。
 * offsetSeconds 用于按用户所在时区归日（客户端传 -getTimezoneOffset()*60）。
 * 洛谷的记录没有时间（练习页只给「做过哪题」），归日会全落到 1970，所以排除掉。
 */
export function getDailyActivity(handleKey, offsetSeconds = 0) {
  const solvedRows = db
    .prepare(
      `SELECT date(first_at + ?, 'unixepoch') AS day, COUNT(*) AS n
       FROM (
         SELECT contest_id || '-' || idx AS k, MIN(created_at) AS first_at
         FROM submissions
         WHERE handle_key = ? AND verdict = 'OK' AND platform <> 'luogu'
         GROUP BY k
       )
       GROUP BY day ORDER BY day`,
    )
    .all(offsetSeconds, handleKey);

  const submissionRows = db
    .prepare(
      `SELECT date(created_at + ?, 'unixepoch') AS day, COUNT(*) AS n
       FROM submissions WHERE handle_key = ? AND platform <> 'luogu'
       GROUP BY day ORDER BY day`,
    )
    .all(offsetSeconds, handleKey);

  const toMap = (rows) => Object.fromEntries(rows.map((row) => [row.day, Number(row.n)]));
  return { solved: toMap(solvedRows), submissions: toMap(submissionRows) };
}

export function replaceRatingHistory(handleKey, history) {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO rating_history (handle_key, contest_id, name, rank, rating, at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM rating_history WHERE handle_key = ?').run(handleKey);
    let inserted = 0;
    for (const entry of history) {
      if (entry.contestId == null) continue;
      insert.run(
        handleKey,
        entry.contestId,
        entry.contestName ?? '',
        entry.rank ?? null,
        entry.newRating ?? null,
        Number(entry.ratingUpdateTimeSeconds ?? 0),
      );
      inserted += 1;
    }
    db.exec('COMMIT');
    return inserted;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function getRatingHistory(handleKey) {
  return db
    .prepare(
      'SELECT contest_id, name, rank, rating, at FROM rating_history WHERE handle_key = ? ORDER BY at ASC',
    )
    .all(handleKey)
    .map((row) => ({
      contestId: row.contest_id,
      name: row.name,
      rank: row.rank,
      rating: row.rating,
      at: Number(row.at),
    }));
}

export function getProgress(handleKey, target) {
  return db
    .prepare('SELECT contest_id, idx FROM progress WHERE handle_key = ? AND target = ? AND done = 1')
    .all(handleKey, target)
    .map((row) => `${row.contest_id}-${row.idx}`);
}

export function setProgress(handleKey, target, contestId, index, done) {
  db.prepare(`
    INSERT INTO progress (handle_key, target, contest_id, idx, done)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(handle_key, target, contest_id, idx) DO UPDATE SET done = excluded.done
  `).run(handleKey, target, contestId, index, done ? 1 : 0);
}

/**
 * 手动勾选过的题（包括被手动取消的），key -> done。
 *
 * 和 getProgress 的区别很重要：getProgress 只给「勾上的」，看不出某道题是
 * 「被手动取消了」还是「压根没碰过」。自动打勾要靠这个区分——手动取消过的题
 * 不该被提交记录重新打上勾。
 */
export function getProgressMap(handleKey, target) {
  const rows = db
    .prepare('SELECT contest_id, idx, done FROM progress WHERE handle_key = ? AND target = ?')
    .all(handleKey, target);
  return new Map(rows.map((row) => [`${row.contest_id}-${row.idx}`, row.done === 1]));
}

// ---------- 手动换题 ----------

/** 读当前这份计划（题号清单 + 生成它时的设置指纹）。 */
export function getPlanSnapshot(handleKey, target) {
  const row = db
    .prepare('SELECT signature, created_at, payload FROM plan_snapshots WHERE handle_key = ? AND target = ?')
    .get(handleKey, target);
  if (!row) return null;
  try {
    return { signature: row.signature, createdAt: row.created_at, stages: JSON.parse(row.payload) };
  } catch {
    return null;
  }
}

/**
 * 存下这份计划，返回真正写进去的时间戳。
 *
 * 返回值不是多余的：界面上日程要按「计划哪一天定下来的」排，
 * 如果调用方另取一次 Date.now()，同一个计划会有两个相差几毫秒的开始时间，
 * 重新生成之后立刻刷新，日程可能排到不一样的日期上。
 */
export function savePlanSnapshot(handleKey, target, signature, stageKeys) {
  const createdAt = Date.now();
  db.prepare(`
    INSERT INTO plan_snapshots (handle_key, target, signature, created_at, payload)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(handle_key, target) DO UPDATE SET
      signature = excluded.signature, created_at = excluded.created_at, payload = excluded.payload
  `).run(handleKey, target, signature, createdAt, JSON.stringify(stageKeys));
  return createdAt;
}

export function clearPlanSnapshot(handleKey, target) {
  db.prepare('DELETE FROM plan_snapshots WHERE handle_key = ? AND target = ?').run(handleKey, target);
}

export function listPlanSwaps(handleKey, target) {
  const rows = db
    .prepare('SELECT from_key, to_key FROM plan_swaps WHERE handle_key = ? AND target = ?')
    .all(handleKey, target);
  return new Map(rows.map((row) => [row.from_key, row.to_key]));
}

export function setPlanSwap(handleKey, target, fromKey, toKey) {
  db.prepare(`
    INSERT INTO plan_swaps (handle_key, target, from_key, to_key, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(handle_key, target, from_key) DO UPDATE SET to_key = excluded.to_key, created_at = excluded.created_at
  `).run(handleKey, target, fromKey, toKey, Date.now());
}

export function clearPlanSwap(handleKey, target, fromKey) {
  db.prepare('DELETE FROM plan_swaps WHERE handle_key = ? AND target = ? AND from_key = ?').run(
    handleKey,
    target,
    fromKey,
  );
}

export function clearPlanSwaps(handleKey, target) {
  db.prepare('DELETE FROM plan_swaps WHERE handle_key = ? AND target = ?').run(handleKey, target);
}

/** 这道题被换过几次，返回换完之后的次数。 */
export function bumpSwapCount(handleKey, fromKey) {
  db.prepare(`
    INSERT INTO plan_swap_counter (handle_key, from_key, count, updated_at)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(handle_key, from_key) DO UPDATE SET count = count + 1, updated_at = excluded.updated_at
  `).run(handleKey, fromKey, Date.now());
  const row = db
    .prepare('SELECT count FROM plan_swap_counter WHERE handle_key = ? AND from_key = ?')
    .get(handleKey, fromKey);
  return Number(row?.count ?? 0);
}

// ---------- 放到本轮最后 ----------

/** 存/取每周的能力快照（各方向 75 分位）。 */
export function listKnownHandles() {
  // 以 users 表为准（能出现在这里的都是成功加载过的账号），再加上 known_handles 里
  // 额外的记录。这样即便这个功能是后加的、老账号也还在，列表不会漏人。
  const merged = new Map();
  for (const row of db.prepare('SELECT handle_key, display_handle, updated_at FROM users').all()) {
    merged.set(row.handle_key, {
      handleKey: row.handle_key,
      display: row.display_handle || row.handle_key,
      addedAt: Number(row.updated_at ?? 0),
    });
  }
  for (const row of db.prepare('SELECT handle_key, display, added_at FROM known_handles').all()) {
    if (!merged.has(row.handle_key)) {
      merged.set(row.handle_key, { handleKey: row.handle_key, display: row.display, addedAt: row.added_at });
    }
  }
  return [...merged.values()].sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0));
}

export function saveGrowthSnapshot(handleKey, weekKey, payload) {
  db.prepare(`
    INSERT INTO growth_snapshots (handle_key, week_key, payload, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(handle_key, week_key) DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at
  `).run(handleKey, weekKey, JSON.stringify(payload), Date.now());
}

export function listGrowthSnapshots(handleKey, limit = 12) {
  return db
    .prepare('SELECT week_key, payload FROM growth_snapshots WHERE handle_key = ? ORDER BY week_key DESC LIMIT ?')
    .all(handleKey, limit)
    .map((row) => {
      try {
        return { week: row.week_key, axes: JSON.parse(row.payload) };
      } catch {
        return { week: row.week_key, axes: [] };
      }
    })
    .reverse();
}

export function listPlanDefer(handleKey, target) {
  return new Set(
    db
      .prepare('SELECT key FROM plan_defer WHERE handle_key = ? AND target = ?')
      .all(handleKey, target)
      .map((row) => row.key),
  );
}

export function setPlanDefer(handleKey, target, key, deferred) {
  if (deferred) {
    db.prepare(`
      INSERT INTO plan_defer (handle_key, target, key, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(handle_key, target, key) DO UPDATE SET created_at = excluded.created_at
    `).run(handleKey, target, key, Date.now());
  } else {
    db.prepare('DELETE FROM plan_defer WHERE handle_key = ? AND target = ? AND key = ?').run(
      handleKey,
      target,
      key,
    );
  }
}

// ---------- 补题队列 ----------

/** 练习区间的自适应状态：挪了多少分、算到第几题、上次的理由。 */
export function getPlanAdjust(handleKey, target) {
  const row = db
    .prepare('SELECT shift, evaluated_done, reason FROM plan_adjust WHERE handle_key = ? AND target = ?')
    .get(handleKey, target);
  return row
    ? { shift: Number(row.shift) || 0, evaluatedDone: Number(row.evaluated_done) || 0, reason: row.reason }
    : { shift: 0, evaluatedDone: 0, reason: null };
}

export function savePlanAdjust(handleKey, target, shift, evaluatedDone, reason) {
  db.prepare(`
    INSERT INTO plan_adjust (handle_key, target, shift, evaluated_done, reason, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(handle_key, target) DO UPDATE SET
      shift = excluded.shift, evaluated_done = excluded.evaluated_done,
      reason = excluded.reason, updated_at = excluded.updated_at
  `).run(handleKey, target, Math.round(shift), Math.round(evaluatedDone), reason ?? null, Date.now());
}

/** 手动从补题队列里移除的题（key 集合）。 */
export function listReviewDone(handleKey) {
  return new Set(
    db
      .prepare('SELECT contest_id, idx FROM review_done WHERE handle_key = ?')
      .all(handleKey)
      .map((row) => `${row.contest_id}-${row.idx}`),
  );
}

export function setReviewDone(handleKey, contestId, index, done) {
  if (done) {
    db.prepare(`
      INSERT INTO review_done (handle_key, contest_id, idx, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(handle_key, contest_id, idx) DO UPDATE SET created_at = excluded.created_at
    `).run(handleKey, contestId, index, Date.now());
  } else {
    db.prepare('DELETE FROM review_done WHERE handle_key = ? AND contest_id = ? AND idx = ?').run(
      handleKey,
      contestId,
      index,
    );
  }
}

// ---------- 塞进某天的额外题目 ----------

export function listScheduleExtras(handleKey) {
  return db
    .prepare('SELECT date, contest_id, idx FROM schedule_extras WHERE handle_key = ? ORDER BY date')
    .all(handleKey)
    .map((row) => ({ date: row.date, contestId: row.contest_id, index: row.idx }));
}

export function addScheduleExtra(handleKey, date, contestId, index) {
  db.prepare(`
    INSERT INTO schedule_extras (handle_key, date, contest_id, idx, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(handle_key, date, contest_id, idx) DO NOTHING
  `).run(handleKey, date, contestId, index, Date.now());
}

export function removeScheduleExtra(handleKey, date, contestId, index) {
  db.prepare(
    'DELETE FROM schedule_extras WHERE handle_key = ? AND date = ? AND contest_id = ? AND idx = ?',
  ).run(handleKey, date, contestId, index);
}

// ---------- 其他平台的汇总数据 ----------

export function savePlatformStats({ platform, account, nickname, stats, extra }) {
  db.prepare(`
    INSERT INTO platform_stats (platform, account, nickname, stats, extra, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform, account) DO UPDATE SET
      nickname = excluded.nickname, stats = excluded.stats,
      extra = excluded.extra, fetched_at = excluded.fetched_at
  `).run(
    platform,
    account,
    nickname ?? null,
    JSON.stringify(stats ?? {}),
    extra ? JSON.stringify(extra) : null,
    Date.now(),
  );
}

export function listPlatformStats() {
  return db
    .prepare(
      'SELECT platform, account, nickname, stats, extra, fetched_at FROM platform_stats ORDER BY platform',
    )
    .all()
    .map((row) => ({
      platform: row.platform,
      account: row.account,
      nickname: row.nickname,
      stats: JSON.parse(row.stats),
      extra: row.extra ? JSON.parse(row.extra) : null,
      fetchedAt: Number(row.fetched_at),
    }));
}

export function deletePlatformStats(platform, account) {
  db.prepare('DELETE FROM platform_stats WHERE platform = ? AND account = ?').run(platform, account);
}

// ---------- 手动屏蔽的题目 ----------

export function blockProblem(handleKey, { contestId, index, name, rating, reason }) {
  db.prepare(`
    INSERT INTO blocked_problems (handle_key, contest_id, idx, name, rating, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(handle_key, contest_id, idx) DO UPDATE SET
      name = excluded.name, rating = excluded.rating, reason = excluded.reason
  `).run(handleKey, contestId, index, name ?? null, rating ?? null, reason ?? null, Date.now());
}

export function unblockProblem(handleKey, contestId, index) {
  db.prepare('DELETE FROM blocked_problems WHERE handle_key = ? AND contest_id = ? AND idx = ?').run(
    handleKey,
    contestId,
    index,
  );
}

export function listBlockedProblems(handleKey) {
  return db
    .prepare(
      'SELECT contest_id, idx, name, rating, reason, created_at FROM blocked_problems WHERE handle_key = ? ORDER BY created_at DESC',
    )
    .all(handleKey)
    .map((row) => ({
      contestId: row.contest_id,
      index: row.idx,
      name: row.name,
      rating: row.rating,
      reason: row.reason,
      createdAt: Number(row.created_at),
    }));
}

export function blockedKeys(handleKey) {
  return db
    .prepare('SELECT contest_id, idx FROM blocked_problems WHERE handle_key = ?')
    .all(handleKey)
    .map((row) => `${row.contest_id}-${row.idx}`);
}

// ---------- 做过的题（按首次通过时间倒序） ----------

/** 拿最近通过的一批题。题库里没有的（比如 gym 题）也要能列出来，所以用 LEFT JOIN。 */
export function recentlySolved(handleKey, limit = 100, offset = 0) {
  return db
    .prepare(`
      SELECT s.contest_id, s.idx, MIN(s.created_at) AS first_ac,
             p.name, p.rating, p.tags,
             COALESCE(p.platform, s.platform, 'codeforces') AS platform,
             p.native_id, p.native_contest, p.native_rating
      FROM submissions s
      LEFT JOIN problems p ON p.contest_id = s.contest_id AND p.idx = s.idx
      WHERE s.handle_key = ? AND s.verdict = 'OK' AND s.platform <> 'luogu'
      GROUP BY s.contest_id, s.idx
      ORDER BY first_ac DESC
      LIMIT ? OFFSET ?
    `)
    .all(handleKey, limit, offset)
    .map((row) => ({
      contestId: row.contest_id,
      index: row.idx,
      name: row.name,
      rating: row.rating,
      tags: row.tags ? JSON.parse(row.tags) : [],
      platform: row.platform,
      nativeId: row.native_id ?? null,
      nativeContest: row.native_contest ?? null,
      nativeRating: row.native_rating ?? null,
      firstAcAt: Number(row.first_ac),
    }));
}

export function countSolved(handleKey) {
  const row = db
    .prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT 1 FROM submissions
        WHERE handle_key = ? AND verdict = 'OK' AND platform <> 'luogu'
        GROUP BY contest_id, idx
      )
    `)
    .get(handleKey);
  return Number(row?.n ?? 0);
}

// ---------- 比赛目录 ----------

export function countContests() {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM contests').get().n);
}

export function replaceContests(list) {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO contests (id, name, phase, start_time, duration, type, cached_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const now = Date.now();

  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM contests');
    let inserted = 0;
    for (const contest of list) {
      if (contest.id == null || !contest.name) continue;
      insert.run(
        contest.id,
        contest.name,
        contest.phase ?? null,
        contest.startTimeSeconds ?? null,
        Number(contest.durationSeconds ?? 0),
        contest.type ?? null,
        now,
      );
      inserted += 1;
    }
    db.exec('COMMIT');
    return inserted;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function getUpcomingContests(limit = 30) {
  return db
    .prepare(
      'SELECT id, name, phase, start_time, duration, type FROM contests WHERE start_time > ? ORDER BY start_time ASC LIMIT ?',
    )
    .all(Math.floor(Date.now() / 1000), limit)
    .map(mapContestRow);
}

export function getContests() {
  return db
    .prepare('SELECT id, name, phase, start_time, duration, type FROM contests')
    .all()
    .map(mapContestRow);
}

export function getContest(id) {
  const row = db
    .prepare('SELECT id, name, phase, start_time, duration, type FROM contests WHERE id = ?')
    .get(id);
  return row ? mapContestRow(row) : null;
}

function mapContestRow(row) {
  return {
    id: row.id,
    name: row.name,
    phase: row.phase,
    startTime: row.start_time,
    duration: row.duration,
    type: row.type,
  };
}

// ---------- 虚拟参赛 ----------

export function createVirtualSession(handleKey, contestId, durationSeconds) {
  const startedAt = Date.now();
  const result = db
    .prepare(
      'INSERT INTO virtual_sessions (handle_key, contest_id, started_at, duration_seconds, status) VALUES (?, ?, ?, ?, ?)',
    )
    .run(handleKey, contestId, startedAt, durationSeconds, 'running');
  return getVirtualSession(Number(result.lastInsertRowid));
}

export function getVirtualSession(id) {
  const row = db.prepare('SELECT * FROM virtual_sessions WHERE id = ?').get(id);
  return row ? mapSessionRow(row) : null;
}

export function getRunningSession(handleKey) {
  const row = db
    .prepare(
      "SELECT * FROM virtual_sessions WHERE handle_key = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1",
    )
    .get(handleKey);
  return row ? mapSessionRow(row) : null;
}

export function finishVirtualSession(id) {
  db.prepare("UPDATE virtual_sessions SET status = 'finished', finished_at = ? WHERE id = ?").run(
    Date.now(),
    id,
  );
  return getVirtualSession(id);
}

export function listVirtualSessions(handleKey, limit = 10) {
  return db
    .prepare('SELECT * FROM virtual_sessions WHERE handle_key = ? ORDER BY started_at DESC LIMIT ?')
    .all(handleKey, limit)
    .map(mapSessionRow);
}

function mapSessionRow(row) {
  return {
    id: row.id,
    handleKey: row.handle_key,
    contestId: row.contest_id,
    startedAt: Number(row.started_at),
    durationSeconds: Number(row.duration_seconds),
    finishedAt: row.finished_at == null ? null : Number(row.finished_at),
    status: row.status,
  };
}

// ---------- 增量同步 ----------

export function getSyncCursor(handleKey) {
  return Number(metaGet(`sync_cursor:${handleKey}`) || 0);
}

export function setSyncCursor(handleKey, seconds) {
  metaSet(`sync_cursor:${handleKey}`, seconds);
}

/** 增量写入 Codeforces 记录：只补新记录，不删除历史。 */
export function appendSubmissions(handleKey, submissions) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO submissions
      (id, handle_key, contest_id, idx, verdict, created_at, platform)
    VALUES (?, ?, ?, ?, ?, ?, 'codeforces')
  `);

  db.exec('BEGIN');
  try {
    let inserted = 0;
    for (const submission of submissions) {
      const problem = submission.problem ?? {};
      if (submission.id == null || problem.contestId == null || !problem.index) continue;
      insert.run(
        submission.id,
        handleKey,
        problem.contestId,
        problem.index,
        submission.verdict ?? 'UNKNOWN',
        Number(submission.creationTimeSeconds ?? 0),
      );
      inserted += 1;
    }
    db.exec('COMMIT');
    return inserted;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
// ---------- 做题手感反馈（自己给每道题打分，比提交次数更准） ----------

/**
 * 做完一道题之后自己标一下难易：too_easy / ok / hard / read_editorial。
 * 提交记录只能看出「过没过」，看不出「是不是秒的」「是不是看题解才会的」，
 * 这两个才是调练习区间最需要的信号。
 */
export function setProblemFeedback(handleKey, contestId, index, feel) {
  db.prepare(`
    INSERT INTO problem_feedback (handle_key, contest_id, idx, feel, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(handle_key, contest_id, idx) DO UPDATE SET
      feel = excluded.feel, created_at = excluded.created_at
  `).run(handleKey, contestId, String(index), feel, Date.now());
}

export function listProblemFeedback(handleKey, limit = 40) {
  return db
    .prepare(
      'SELECT contest_id, idx, feel, created_at FROM problem_feedback WHERE handle_key = ? ORDER BY created_at DESC LIMIT ?',
    )
    .all(handleKey, limit)
    .map((row) => ({
      contestId: row.contest_id,
      index: row.idx,
      feel: row.feel,
      createdAt: row.created_at,
    }));
}

/**
 * 最近这些手感标签折算成「练习区间该往上挪还是往下挪」的分数。
 *
 * 秒了的多 → 往上挪；看题解的多 → 往下挪。每 20 条反馈最多挪 50 分，
 * 免得几条主观感受就把整个区间拽跑。
 */
export function feedbackShift(handleKey, limit = 20) {
  const rows = db
    .prepare(
      'SELECT feel FROM problem_feedback WHERE handle_key = ? ORDER BY created_at DESC LIMIT ?',
    )
    .all(handleKey, limit);
  if (rows.length < 5) return 0;
  let score = 0;
  for (const row of rows) {
    if (row.feel === 'too_easy') score += 1;
    else if (row.feel === 'read_editorial') score -= 1;
    else if (row.feel === 'hard') score -= 0.3;
  }
  const ratio = score / rows.length;
  if (ratio > 0.5) return 50;
  if (ratio > 0.2) return 25;
  if (ratio < -0.5) return -50;
  if (ratio < -0.2) return -25;
  return 0;
}

// ---------- 「今天补一个方向」的临时加题 ----------

/** 把一个方向临时加的几道题记在今天，日程和今日卡片会带上它们。 */
export function addExtraTasks(handleKey, date, keys) {
  const now = Date.now();
  const statement = db.prepare(
    'INSERT OR IGNORE INTO extra_tasks (handle_key, date, contest_id, idx, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  for (const key of keys) {
    const dash = key.indexOf('-');
    statement.run(handleKey, date, Number(key.slice(0, dash)), key.slice(dash + 1), now);
  }
}

/**
 * AtCoder 提交记录。id 用一个高位偏移，和 CF 的提交号不会撞。
 * 只收题库里有的题（ABC/ARC/AGC），其他系列（PAST、典型 90 之类）不进来，
 * 否则做题记录里会出现一堆没有难度、也没法排进计划的题。
 */
const ATCODER_SUBMISSION_ID_BASE = 1_000_000_000_000_000;

export function appendAtcoderSubmissions(handleKey, submissions) {
  const known = new Map(
    db
      .prepare("SELECT native_id, contest_id, idx FROM problems WHERE platform = 'atcoder'")
      .all()
      .map((row) => [row.native_id, row]),
  );
  const insert = db.prepare(`
    INSERT OR IGNORE INTO submissions
      (id, handle_key, contest_id, idx, verdict, created_at, platform)
    VALUES (?, ?, ?, ?, ?, ?, 'atcoder')
  `);

  db.exec('BEGIN');
  try {
    let inserted = 0;
    let skipped = 0;
    for (const submission of submissions) {
      const problem = known.get(submission.nativeId);
      if (submission.id == null || !problem) {
        skipped += 1;
        continue;
      }
      insert.run(
        ATCODER_SUBMISSION_ID_BASE + Number(submission.id),
        handleKey,
        problem.contest_id,
        problem.idx,
        submission.verdict ?? 'OTHER',
        Number(submission.createdAt ?? 0),
      );
      inserted += 1;
    }
    db.exec('COMMIT');
    return { inserted, skipped };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function countAtcoderSolved(handleKey) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT 1 FROM submissions
         WHERE handle_key = ? AND platform = 'atcoder' AND verdict = 'OK'
         GROUP BY contest_id, idx
       )`,
    )
    .get(handleKey);
  return Number(row?.n ?? 0);
}

export function getAtcoderSyncCursor(handleKey) {
  return Number(metaGet(`atcoder_cursor:${handleKey}`) || 0);
}

export function setAtcoderSyncCursor(handleKey, seconds) {
  metaSet(`atcoder_cursor:${handleKey}`, seconds);
}

export function listExtraTasks(handleKey, date) {
  return db
    .prepare('SELECT contest_id, idx FROM extra_tasks WHERE handle_key = ? AND date = ? ORDER BY created_at')
    .all(handleKey, date)
    .map((row) => `${row.contest_id}-${row.idx}`);
}

/** 所有还没过期的「临时加题」，按日期分组，界面按天挂上去。 */
export function listAllExtraTasks(handleKey, fromDate) {
  return db
    .prepare(
      'SELECT date, contest_id, idx FROM extra_tasks WHERE handle_key = ? AND date >= ? ORDER BY date, created_at',
    )
    .all(handleKey, fromDate)
    .map((row) => ({ date: row.date, key: `${row.contest_id}-${row.idx}` }));
}

export function clearExtraTasks(handleKey, date) {
  db.prepare('DELETE FROM extra_tasks WHERE handle_key = ? AND date = ?').run(handleKey, date);
}

// ---------- 训练数据导出 / 导入（换电脑时搬数据用） ----------

/** 导出：设置、勾选进度、屏蔽表、虚拟赛记录、手感反馈。 */
export function exportTrainingData() {
  return {
    app: 'acm-trainer',
    version: 1,
    exportedAt: Date.now(),
    settings: getSettings(),
    progress: db.prepare('SELECT handle_key, target, contest_id, idx, done FROM progress').all(),
    blocked: db
      .prepare('SELECT handle_key, contest_id, idx, name, rating, reason, created_at FROM blocked_problems')
      .all(),
    virtual: db
      .prepare('SELECT handle_key, contest_id, started_at, duration_seconds, finished_at, status FROM virtual_sessions')
      .all(),
    feedback: db
      .prepare('SELECT handle_key, contest_id, idx, feel, created_at FROM problem_feedback')
      .all(),
  };
}

/** 导入：同键覆盖，逐表写回，返回每张表写了多少行。 */
export function importTrainingData(data) {
  const counts = { settings: 0, progress: 0, blocked: 0, virtual: 0, feedback: 0 };
  if (data?.settings && typeof data.settings === 'object') {
    const patch = {};
    for (const [key, value] of Object.entries(data.settings)) patch[key] = String(value ?? '');
    saveSettings(patch);
    counts.settings = Object.keys(patch).length;
  }
  for (const row of Array.isArray(data?.progress) ? data.progress : []) {
    if (!row?.handle_key || !row?.idx) continue;
    setProgress(
      row.handle_key,
      Number(row.target) || 0,
      Number(row.contest_id) || 0,
      String(row.idx),
      Boolean(row.done),
    );
    counts.progress += 1;
  }
  for (const row of Array.isArray(data?.blocked) ? data.blocked : []) {
    if (!row?.handle_key || !row?.idx) continue;
    blockProblem(row.handle_key, {
      contestId: Number(row.contest_id),
      index: String(row.idx),
      name: row.name,
      rating: row.rating,
      reason: row.reason ?? '',
    });
    counts.blocked += 1;
  }
  const insertVirtual = db.prepare(
    `INSERT INTO virtual_sessions (handle_key, contest_id, started_at, duration_seconds, finished_at, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const row of Array.isArray(data?.virtual) ? data.virtual : []) {
    if (!row?.handle_key || !row?.contest_id) continue;
    insertVirtual.run(
      row.handle_key,
      Number(row.contest_id),
      Number(row.started_at) || 0,
      Number(row.duration_seconds) || 0,
      row.finished_at ?? null,
      String(row.status ?? 'finished'),
    );
    counts.virtual += 1;
  }
  for (const row of Array.isArray(data?.feedback) ? data.feedback : []) {
    if (!row?.handle_key || !row?.idx) continue;
    setProblemFeedback(row.handle_key, Number(row.contest_id), String(row.idx), String(row.feel));
    counts.feedback += 1;
  }
  return counts;
}
