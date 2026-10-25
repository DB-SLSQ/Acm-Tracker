// AI 题解：走 OpenAI 兼容的 /chat/completions（默认指 DeepSeek）。
//
// 只用内置 fetch，不引第三方 SDK —— 这个项目是零运行时依赖。
// 兼容面故意做宽：Base URL / Key / 模型名都由用户自己填，
// 所以 DeepSeek、通义、Kimi、智谱、本地 Ollama、各种中转站都能直接用。

export class AiError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AiError';
  }
}

export const DEFAULT_AI_BASE_URL = 'https://api.deepseek.com/v1';
export const DEFAULT_AI_MODEL = 'deepseek-chat';

/** 想要什么语言的实现。模型不认这个键也无所谓，提示词里同时也写明了。 */
export const AI_LANGS = {
  cpp: 'C++17',
  python: 'Python 3',
};

/** 生成题解可能挺慢（长题 + 长代码），给足时间。 */
const TIMEOUT_MS = 180000;

function problemLabel(problem) {
  if (problem.platform === 'luogu' || problem.platform === 'atcoder') {
    return problem.nativeId ?? `${problem.contestId}-${problem.index}`;
  }
  return `${problem.contestId}${problem.index}`;
}

const PLATFORM_NAMES = {
  codeforces: 'Codeforces',
  atcoder: 'AtCoder',
  luogu: '洛谷',
  nowcoder: '牛客',
  leetcode: '力扣',
};

function buildMessages({ problem, statement, lang }) {
  const langName = AI_LANGS[lang] ?? AI_LANGS.cpp;
  const meta = [
    `题号：${problemLabel(problem)}`,
    `平台：${PLATFORM_NAMES[problem.platform] ?? 'Codeforces'}`,
    problem.name ? `标题：${problem.name}` : '',
    problem.rating ? `难度评分：${problem.rating}` : '',
    Array.isArray(problem.tags) && problem.tags.length ? `标签：${problem.tags.join('、')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const statementPart = statement
    ? `【题面】\n${statement}`
    : '【题面】\n（没能抓到题面，请根据上面的题号与标题判断这是哪一道题；如果确实认不出来，就直说认不出，不要编造题意。）';

  const system = [
    '你是一位算法竞赛教练，擅长把题目讲得让选手自己能写出来。',
    '',
    '针对给出的题目，输出两部分：',
    `1. 思路：讲清楚这题怎么做——关键观察、算法、复杂度，以及容易写错的地方。不要在这里贴代码。`,
    `2. 代码：一份完整、可以直接提交的 ${langName} 实现，包含必要的头文件/导入、主函数、输入输出。`,
    '',
    '严格按下面的格式输出，两个标题的字样不要改动：',
    '',
    '### 思路',
    '（正文，可以用小标题和列表，但不要出现代码块）',
    '',
    '### 代码',
    `\`\`\`${lang === 'python' ? 'python' : 'cpp'}`,
    '（完整代码）',
    '```',
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: `${meta}\n\n${statementPart}` },
  ];
}

/**
 * 从模型回复里把「思路」和「代码」拆开。
 *
 * 优先按 ``` 代码块切；模型偶尔不写标题或者多贴几段，
 * 这里都当「第一段代码块是答案，其余是思路」处理，尽量别浪费一次调用。
 */
export function parseReply(text) {
  const source = String(text ?? '');
  const fence = /```[ \t]*([a-zA-Z0-9+#.-]*)[ \t]*\r?\n([\s\S]*?)```/.exec(source);
  let code = '';
  let lang = 'cpp';
  if (fence) {
    lang = (fence[1] || 'cpp').toLowerCase();
    code = fence[2].trim();
  }
  let idea = fence ? source.slice(0, fence.index) + '\n' + source.slice(fence.index + fence[0].length) : source;
  idea = idea
    .replace(/^[ \t]*#{1,6}[ \t]*(思路|解题思路|分析|做法)[ \t]*$/gim, '')
    .replace(/^[ \t]*#{1,6}[ \t]*(代码|参考代码|实现)[ \t]*$/gim, '')
    .replace(/^[ \t]*```[a-zA-Z0-9+#.-]*[ \t]*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { idea, code, lang: lang === 'python' ? 'python' : 'cpp' };
}

function joinUrl(baseUrl, path) {
  return `${String(baseUrl).replace(/\/+$/, '')}${path}`;
}

/**
 * 生成一道题的题解。
 *
 * @returns {{ idea: string, code: string, lang: string, model: string, fromStatement: boolean }}
 * @throws {AiError} 配置缺失、网络失败、对方报错时抛出（带人话的提示）
 */
export async function generateSolution({ problem, statement, config }) {
  const baseUrl = String(config?.baseUrl ?? '').trim() || DEFAULT_AI_BASE_URL;
  const apiKey = String(config?.apiKey ?? '').trim();
  const model = String(config?.model ?? '').trim() || DEFAULT_AI_MODEL;
  const lang = config?.lang === 'python' ? 'python' : 'cpp';

  if (!apiKey) {
    throw new AiError('还没填 API Key。去「设置 → AI 题解」里填一个，才能生成题解。');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response;
  try {
    response = await fetch(joinUrl(baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: buildMessages({ problem, statement, lang }),
        temperature: 0.2,
        max_tokens: 4096,
        stream: false,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') throw new AiError('等模型回复超时了（超过 3 分钟），可以再试一次。');
    throw new AiError(`连不上 ${baseUrl}：${error.message}`);
  } finally {
    clearTimeout(timer);
  }

  const raw = await response.text();
  if (!response.ok) {
    let hint = raw.slice(0, 300);
    try {
      const parsed = JSON.parse(raw);
      hint = parsed?.error?.message ?? parsed?.message ?? hint;
    } catch {
      /* 不是 JSON 就用原文 */
    }
    if (response.status === 401) throw new AiError('API Key 不对（对方返回 401）。检查一下设置里的 Key。');
    if (response.status === 404) throw new AiError(`这个接口地址不对（404）。检查 Base URL 是不是形如 https://api.deepseek.com/v1`);
    if (response.status === 429) throw new AiError('请求太频繁或者额度用完了（429），等一下再试。');
    throw new AiError(`${model} 返回了 HTTP ${response.status}：${hint}`);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new AiError('对方返回的内容不是 JSON，可能是 Base URL 指错了。');
  }

  const content = payload?.choices?.[0]?.message?.content;
  if (!content) throw new AiError('模型没有返回内容，换个模型或者再试一次。');

  const parsed = parseReply(content);
  if (!parsed.idea && !parsed.code) throw new AiError('模型返回的内容里没找到题解，再试一次看看。');

  return {
    idea: parsed.idea,
    code: parsed.code,
    lang: parsed.lang,
    model,
    fromStatement: Boolean(statement),
  };
}

// ---------- 区域赛备赛计划 ----------
//
// 和题解共用同一份 AI 配置（Base URL / Key / 模型）。不同的是输出必须是结构化 JSON：
// 界面要按阶段画时间线，自由文本没法摆。提示词里写死字段名，解析时再兜一层
// 「模型还是加了代码块 / 多说了两句」的情况，尽量不让用户看到解析失败。

const PREP_SCHEMA = `{
  "overview": "一句话总览，40 字以内",
  "phases": [
    {
      "name": "阶段名，8 字以内",
      "start": "YYYY-MM-DD",
      "end": "YYYY-MM-DD",
      "weekly": 12,
      "focus": ["专题 1", "专题 2"],
      "target": "这阶段的目标难度，例如 1500-1700 过题率 70%",
      "note": "这个阶段具体怎么练，60 字以内"
    }
  ],
  "contestTips": ["赛前 3 天要做什么", "比赛当天的策略"],
  "risks": ["最可能卡住的地方"]
}`;

function buildPrepMessages({ contests, profile, today }) {
  const lines = contests
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((c, i) => `${i + 1}. ${c.date}  ${c.name}${c.note ? `（${c.note}）` : ''}`)
    .join('\n');
  const weak = (profile.weakTags ?? []).length ? profile.weakTags.join('、') : '暂无数据';
  const system = [
    '你是一名带过 ICPC/CCPC 队伍的训练教练，擅长给个人选手排备赛计划。',
    '只输出 JSON，不要任何解释、不要 Markdown 代码块，字段严格按下面这个结构：',
    PREP_SCHEMA,
    '',
    '硬性要求：',
    '1. phases 必须从今天开始、连续覆盖到最近一场比赛当天；后面每一场比赛之间单独成一个阶段。',
    '2. 阶段名用中文短语，不要出现英文缩写堆砌。',
    '3. weekly 是每周建议题量，按选手当前水平给：1300 分左右 8-12 题，1600 分左右 12-16 题，2000 分左右 16-22 题。',
    '4. 比赛前 5-7 天要减量（taper），weekly 至少降 30%，专心复盘和打 VP。',
    '5. focus 只写算法专题（如「线段树」「字符串哈希」），每个阶段 2-4 个，优先补弱项。',
    '6. 最多 6 个阶段；日期必须是合法日期，start 不早于今天。',
  ].join('\n');
  const user = [
    `今天是 ${today}。`,
    '要备赛的比赛：',
    lines,
    '',
    '选手情况：',
    `- Codeforces 当前 rating：${profile.rating ?? '未知'}`,
    `- 刷过题量：${profile.solvedCount ?? 0} 题`,
    `- 最近 30 天通过：${profile.recentSolved ?? 0} 题`,
    `- 弱项专题（做过但没 AC 的题涉及最多）：${weak}`,
    profile.extra ? `- 其他：${profile.extra}` : '',
    '',
    '请按上面的 JSON 结构给出备赛计划。',
  ]
    .filter(Boolean)
    .join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** 从模型回复里抠出 JSON：允许外面包着代码块，或者前后多几句废话。 */
export function parseJsonReply(text) {
  const source = String(text ?? '').trim();
  const fence = /```(?:json)?\s*\r?\n([\s\S]*?)```/i.exec(source);
  const body = fence ? fence[1].trim() : source;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new AiError('模型没有返回 JSON，再试一次。');
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    throw new AiError('模型返回的 JSON 格式不对，再试一次。');
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 把模型给的阶段洗一遍：字段缺失/越界都兜住，界面不至于渲染出空洞。 */
export function normalizePrepPlan(raw, { today }) {
  const phases = Array.isArray(raw?.phases) ? raw.phases : [];
  const clean = [];
  for (const phase of phases.slice(0, 8)) {
    const start = ISO_DATE.test(String(phase?.start ?? '')) ? phase.start : null;
    const end = ISO_DATE.test(String(phase?.end ?? '')) ? phase.end : null;
    if (!start || !end || end < start) continue;
    const weekly = Number(phase?.weekly);
    clean.push({
      name: String(phase?.name ?? '').trim().slice(0, 20) || `阶段 ${clean.length + 1}`,
      start,
      end,
      weekly: Number.isFinite(weekly) ? Math.max(3, Math.min(40, Math.round(weekly))) : 10,
      focus: Array.isArray(phase?.focus)
        ? phase.focus.map((tag) => String(tag).trim().slice(0, 20)).filter(Boolean).slice(0, 4)
        : [],
      target: String(phase?.target ?? '').trim().slice(0, 60),
      note: String(phase?.note ?? '').trim().slice(0, 200),
    });
  }
  if (!clean.length) throw new AiError('模型给的阶段都不合法，再试一次看看。');
  clean.sort((a, b) => (a.start < b.start ? -1 : 1));
  return {
    overview: String(raw?.overview ?? '').trim().slice(0, 200),
    phases: clean,
    contestTips: Array.isArray(raw?.contestTips)
      ? raw.contestTips.map((tip) => String(tip).trim().slice(0, 160)).filter(Boolean).slice(0, 6)
      : [],
    risks: Array.isArray(raw?.risks)
      ? raw.risks.map((tip) => String(tip).trim().slice(0, 160)).filter(Boolean).slice(0, 6)
      : [],
    today,
  };
}

export async function generatePrepPlan({ contests, profile, today, config }) {
  const baseUrl = String(config?.baseUrl ?? '').trim() || DEFAULT_AI_BASE_URL;
  const apiKey = String(config?.apiKey ?? '').trim();
  const model = String(config?.model ?? '').trim() || DEFAULT_AI_MODEL;

  if (!apiKey) {
    throw new AiError('还没填 API Key。去「设置 → AI 题解」里填一个，才能生成备赛计划。');
  }
  if (!Array.isArray(contests) || !contests.length) {
    throw new AiError('先加上至少一场区域赛（名字 + 日期），再生成计划。');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response;
  try {
    response = await fetch(joinUrl(baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: buildPrepMessages({ contests, profile, today }),
        temperature: 0.5,
        max_tokens: 2600,
        stream: false,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') throw new AiError('等模型回复超时了（超过 3 分钟），可以再试一次。');
    throw new AiError(`连不上 ${baseUrl}：${error.message}`);
  } finally {
    clearTimeout(timer);
  }

  const raw = await response.text();
  if (!response.ok) {
    let hint = raw.slice(0, 300);
    try {
      const parsed = JSON.parse(raw);
      hint = parsed?.error?.message ?? parsed?.message ?? hint;
    } catch {
      /* 不是 JSON 就用原文 */
    }
    if (response.status === 401) throw new AiError('API Key 不对（对方返回 401）。检查一下设置里的 Key。');
    if (response.status === 404) throw new AiError('接口地址不对（404），检查 Base URL 是不是形如 https://api.deepseek.com/v1');
    if (response.status === 429) throw new AiError('请求太频繁或者额度用完了（429），等一下再试。');
    throw new AiError(`${model} 返回了 HTTP ${response.status}：${hint}`);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new AiError('对方返回的内容不是 JSON，可能是 Base URL 指错了。');
  }
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) throw new AiError('模型没有返回内容，换个模型或者再试一次。');
  const plan = normalizePrepPlan(parseJsonReply(content), { today });
  return { ...plan, model };
}
