// 按天排布训练计划。
//
// 输入是训练计划里那串有序题目，输出是「哪天做哪几题」。
// 纯计算，不碰 DOM，方便单独测试。

export const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 本地日期 → 'YYYY-MM-DD'。不能用 toISOString，那会按 UTC 算，跨时区会错一天。 */
export function dateKey(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function parseDateKey(key) {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day);
}

export function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addDays(date, count) {
  const next = startOfDay(date);
  next.setDate(next.getDate() + count);
  return next;
}

/** 这一周的开始（周日）。 */
export function startOfWeek(date) {
  return addDays(date, -date.getDay());
}

/**
 * 把题目分配到具体日期。
 *
 * 规则：
 * - 每周的题量摊到该周「可做的日子」上，均分后余数给靠前的几天；
 * - restDays 是每周固定休息的日子（0=周日）；
 * - dayOff 是特定日期不做题，值是原因（例如「聚餐」）；
 * - 第一周如果已经过了一半，按剩余可做天数比例折算，不会把一整周的量压到两三天里。
 */
export function buildSchedule({
  problems = [],
  weekly = 10,
  restDays = [],
  dayOff = {},
  startDate = new Date(),
  maxWeeks = 60,
} = {}) {
  const rest = new Set(restDays.map(Number));
  const off = dayOff ?? {};
  const firstDay = startOfDay(startDate);
  const perWeek = Math.max(1, Math.round(weekly));

  const isOff = (date) => rest.has(date.getDay()) || Object.hasOwn(off, dateKey(date));
  const noteOf = (date) => off[dateKey(date)] ?? null;

  // 先把每天的配额算出来
  const quotaByDate = new Map();
  let cursor = startOfWeek(firstDay);

  for (let week = 0; week < maxWeeks; week += 1) {
    const weekDates = Array.from({ length: 7 }, (_, offset) => addDays(cursor, offset));
    const fullActive = weekDates.filter((date) => !isOff(date)).length;
    // 本周里还没过去、也没被标记休息的日子
    const usable = weekDates.filter((date) => date >= firstDay && !isOff(date));

    if (usable.length && fullActive > 0) {
      const partial = usable.length < fullActive;
      const target = partial
        ? Math.max(1, Math.round((perWeek * usable.length) / fullActive))
        : perWeek;
      const base = Math.floor(target / usable.length);
      let remainder = target - base * usable.length;
      for (const date of usable) {
        quotaByDate.set(dateKey(date), base + (remainder-- > 0 ? 1 : 0));
      }
    }
    cursor = addDays(cursor, 7);
    if (quotaByDate.size > 400) break;
  }

  // 再把题目按顺序填进去
  const sortedDates = [...quotaByDate.keys()].sort();
  const days = [];
  let index = 0;

  for (const key of sortedDates) {
    const quota = quotaByDate.get(key);
    const assigned = problems.slice(index, index + quota);
    index += assigned.length;
    const date = parseDateKey(key);
    days.push({
      date: key,
      weekday: date.getDay(),
      label: WEEKDAY_LABELS[date.getDay()],
      quota,
      problems: assigned,
      stages: [...new Set(assigned.map((problem) => problem.stage).filter((s) => s != null))],
    });
    if (index >= problems.length) break;
  }

  // 休息日也放进来，界面上要能显示「这天不做」
  const horizonEnd = days.length ? days[days.length - 1].date : dateKey(firstDay);
  const restDates = [];
  for (let date = firstDay; dateKey(date) <= horizonEnd; date = addDays(date, 1)) {
    if (isOff(date)) {
      restDates.push({
        date: dateKey(date),
        weekday: date.getDay(),
        label: WEEKDAY_LABELS[date.getDay()],
        reason: noteOf(date),
      });
    }
  }

  const byDate = new Map(days.map((day) => [day.date, day]));
  const totalProblems = days.reduce((sum, day) => sum + day.problems.length, 0);

  return {
    days,
    byDate,
    restDates,
    totalProblems,
    startDate: dateKey(firstDay),
    endDate: days.length ? days[days.length - 1].date : dateKey(firstDay),
    weeks: days.length ? Math.ceil(days.length / Math.max(1, 7 - rest.size)) : 0,
    perActiveDay: days.length ? Math.round((totalProblems / days.length) * 10) / 10 : 0,
  };
}

/**
 * 「今天」这张卡片要用的数据。
 *
 * 日程锚在「计划定下来的那天」而不是今天：同一份计划里每一天做哪几题是固定的，
 * 勾掉一题不会让后面的题往前顶。锚在今天的话，勾完一道题，整条日程就往前挪一格，
 * 今天这张卡片永远显示 0/2，进度条也就没意义了。
 *
 * 「落后几天」按**今天之前**该做完的题算（不含今天），
 * 否则每天早上一起床就凭空落后一整天。落后的题数除以平均每天题量换成天数：
 * 欠 6 题看不出要多久补完，「落后 3 天」一眼就能判断今天要不要加把劲。
 */
export function todayOverview({
  problems = [],
  weekly = 10,
  restDays = [],
  dayOff = {},
  startDate = new Date(),
  today = new Date(),
  doneKeys = new Set(),
} = {}) {
  const keyOf = (problem) => `${problem.contestId}-${problem.index}`;
  const timeline = buildSchedule({ problems, weekly, restDays, dayOff, startDate });
  const todayKey = dateKey(today);
  const todayDay = timeline.byDate.get(todayKey) ?? null;
  const todayProblems = todayDay?.problems ?? [];

  // 今天之前该做完的题（今天这一天的量不算进来，不然每天开局就落后）
  let dueCount = 0;
  for (const day of timeline.days) {
    if (day.date >= todayKey) break;
    dueCount += day.problems.length;
  }
  const doneCount = problems.filter((problem) => doneKeys.has(keyOf(problem))).length;
  const perDay = timeline.perActiveDay || Math.max(1, weekly / 7);
  const nextDay = timeline.days.find((day) => day.date > todayKey) ?? null;

  return {
    startDate: timeline.startDate,
    endDate: timeline.endDate,
    todayKey,
    todayProblems,
    todayDone: todayProblems.filter((problem) => doneKeys.has(keyOf(problem))).length,
    dueCount,
    doneCount,
    totalProblems: problems.length,
    // 正数=落后，负数=超前（把后面几天的题提前做了）
    behindDays: perDay > 0 ? (dueCount - doneCount) / perDay : 0,
    perDay,
    // 距计划原定的结束日还有几个日历天
    daysLeft: Math.round((parseDateKey(timeline.endDate) - startOfDay(today)) / 86400000),
    restDay: timeline.restDates.find((item) => item.date === todayKey) ?? null,
    nextDay,
    inRange:
      problems.length > 0 &&
      (Boolean(todayDay) || timeline.restDates.some((item) => item.date === todayKey)),
  };
}

/** 生成某个月的日历矩阵（按周分组，每行 7 天），用于月视图渲染。 */
export function monthMatrix(year, month) {
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const cells = [];
  for (let date = startOfWeek(first); date <= last; date = addDays(date, 1)) {
    cells.push({
      date: dateKey(date),
      day: date.getDate(),
      weekday: date.getDay(),
      inMonth: date.getMonth() === month,
    });
  }
  while (cells.length % 7 !== 0) {
    const last = parseDateKey(cells[cells.length - 1].date);
    const next = addDays(last, 1);
    cells.push({ date: dateKey(next), day: next.getDate(), weekday: next.getDay(), inMonth: false });
  }
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/**
 * 热力图网格：列是周，行是星期几。
 * 默认从「今天」往前铺 53 周（约一年），和 Codeforces 个人页的做法一致。
 */
export function heatmapWeeks({ end = new Date(), weekCount = 53 } = {}) {
  const start = addDays(startOfWeek(end), -(weekCount - 1) * 7);
  const weeks = [];
  for (let week = 0; week < weekCount; week += 1) {
    const column = [];
    for (let day = 0; day < 7; day += 1) {
      const date = addDays(start, week * 7 + day);
      column.push({
        date: dateKey(date),
        day: date.getDate(),
        month: date.getMonth(),
        weekday: date.getDay(),
        future: date > startOfDay(end),
      });
    }
    weeks.push(column);
  }
  return weeks;
}
