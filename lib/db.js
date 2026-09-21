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
    PRIMARY KEY (contest_id, idx)
  );

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
    created_at INTEGER NOT NULL
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

// 早期版本没有 extra 列，这里补一次（列已存在时会报错，忽略即可）
try {
  db.exec('ALTER TABLE platform_stats ADD COLUMN extra TEXT');
} catch {
  /* 已经有了 */
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

/** 用最新的 problem set 整体替换题库（约 1 万条，事务内完成，很快）。 */
export function replaceProblems({ problems, problemStatistics }) {
  const solvedCounts = new Map();
  for (const stat of problemStatistics ?? []) {
    solvedCounts.set(`${stat.contestId}-${stat.index}`, Number(stat.solvedCount ?? 0));
  }

  const insert = db.prepare(`
    INSERT OR REPLACE INTO problems (contest_id, idx, name, rating, tags, solved_count, type)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM problems');
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

export function getAllProblems() {
  return db
    .prepare('SELECT contest_id, idx, name, rating, tags, solved_count, type FROM problems')
    .all()
    .map((row) => ({
      contestId: row.contest_id,
      index: row.idx,
      name: row.name,
      rating: row.rating,
      tags: JSON.parse(row.tags),
      solvedCount: row.solved_count,
      type: row.type,
    }));
}

export function normalizeHandle(handle) {
  return String(handle ?? '').trim().toLowerCase();
}

export function saveUser(handleKey, info) {
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

/** 用完整的提交记录整体替换（我们每次都抓全量，所以直接重建最省心）。 */
export function replaceSubmissions(handleKey, submissions) {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO submissions (id, handle_key, contest_id, idx, verdict, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM submissions WHERE handle_key = ?').run(handleKey);
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

export function getSubmissions(handleKey) {
  return db
    .prepare(
      'SELECT id, contest_id, idx, verdict, created_at FROM submissions WHERE handle_key = ? ORDER BY created_at ASC, id ASC',
    )
    .all(handleKey)
    .map((row) => ({
      id: row.id,
      contestId: row.contest_id,
      index: row.idx,
      verdict: row.verdict,
      createdAt: Number(row.created_at),
    }));
}

/**
 * 每日活动统计，用于热力图。
 * solved 是「当天首次通过的题数」，submissions 是当天总提交数。
 * offsetSeconds 用于按用户所在时区归日（客户端传 -getTimezoneOffset()*60）。
 */
export function getDailyActivity(handleKey, offsetSeconds = 0) {
  const solvedRows = db
    .prepare(
      `SELECT date(first_at + ?, 'unixepoch') AS day, COUNT(*) AS n
       FROM (
         SELECT contest_id || '-' || idx AS k, MIN(created_at) AS first_at
         FROM submissions
         WHERE handle_key = ? AND verdict = 'OK'
         GROUP BY k
       )
       GROUP BY day ORDER BY day`,
    )
    .all(offsetSeconds, handleKey);

  const submissionRows = db
    .prepare(
      `SELECT date(created_at + ?, 'unixepoch') AS day, COUNT(*) AS n
       FROM submissions WHERE handle_key = ?
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
             p.name, p.rating, p.tags
      FROM submissions s
      LEFT JOIN problems p ON p.contest_id = s.contest_id AND p.idx = s.idx
      WHERE s.handle_key = ? AND s.verdict = 'OK'
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
      firstAcAt: Number(row.first_ac),
    }));
}

export function countSolved(handleKey) {
  const row = db
    .prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT 1 FROM submissions WHERE handle_key = ? AND verdict = 'OK'
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

/** 增量写入：只补新记录，不删除历史。 */
export function appendSubmissions(handleKey, submissions) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO submissions (id, handle_key, contest_id, idx, verdict, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
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
