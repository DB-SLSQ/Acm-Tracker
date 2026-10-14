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
