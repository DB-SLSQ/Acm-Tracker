// 题面抓取：AI 写题解之前，先把「题目本身」读进来。
//
// 抓下来压成文本喂给模型，比只丢一个题号让它自己去认靠谱得多。
// 但**抓不到不算失败**——调用方会退化成「题号 + 标题 + 难度 + 标签」，
// 常见题模型照样认得出来，只是没那么稳。
//
// 各平台现状（2026-10 实测，都是踩过坑才写下来的）：
//   · AtCoder：服务端渲染的静态页，`#task-statement` 里英文日文两份，好抓；
//   · 洛谷：两套坑。① 有 302 + cookie 的挑战，得手动带一次 cookie 再请求
//     （用 redirect: 'follow' 会陷入重定向循环，因为 fetch 不自己管 cookie）；
//     ② `_contentOnly=1` 那个老 JSON 接口**已经失效**，现在整份题面在
//     `<script id="lentille-context">` 的 JSON 里，字段是 content.description /
//     formatI / formatO / hint，而且内容是 Markdown（不是 HTML，别过标签）；
//   · Codeforces：前面挂着 Cloudflare，服务器直连基本都吃 403（Just a moment...），
//     抓不到就降级，不当成错误。

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

/** 题面最多留这么多字符。超长的题（一屏样例的那种）截断，免得把上下文塞爆。 */
const MAX_CHARS = 12000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 带重试的 GET。
 * 本机到 AtCoder / CF 的连接时好时坏（同一条 URL 前一次超时、后一次 300ms 就回来了），
 * 所以重试是必需品，不是优化。
 */
async function get(url, { tries = 3, timeoutMs = 20000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
        signal: controller.signal,
        redirect: 'follow',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < tries - 1) await sleep(600 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

const ENTITIES = {
  '&nbsp;': ' ',
  '&lt;': '<',
  '&gt;': '>',
  '&amp;': '&',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
};

const decodeEntities = (text) => String(text).replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);

/** 把题面 HTML 压成能读的纯文本。只求可读，不做严谨解析。 */
function htmlToText(html) {
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6]|pre|section|table)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '· ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 洛谷的内容本身是 Markdown（含 $LaTeX$、`代码`，还可能有 #include <bits/stdc++.h>），
 * 所以这里**绝不能**走 htmlToText——会把尖括号当标签吃掉。只解实体、压空行。
 */
function tidyMarkdown(text) {
  return decodeEntities(String(text ?? ''))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function clip(text) {
  const value = String(text ?? '').trim();
  return value.length > MAX_CHARS ? `${value.slice(0, MAX_CHARS)}\n…（题面过长，已截断）` : value;
}

/** Codeforces：整块题面在 div.problem-statement 里。CF 前面有 Cloudflare，403 就认了。 */
async function fromCodeforces(problem) {
  const url = `https://codeforces.com/problemset/problem/${problem.contestId}/${problem.index}`;
  const html = await get(url, { tries: 2, timeoutMs: 15000 });
  const start = html.indexOf('problem-statement');
  if (start < 0) return null;
  const text = htmlToText(html.slice(start, start + 80000));
  return text.length > 80 ? text : null;
}

/**
 * AtCoder：#task-statement 里同时放着英文和日文两份题面，英文在后。
 * 优先取英文那份；万一只有日文（部分老题），整块给模型它也看得懂。
 */
async function fromAtCoder(problem) {
  const { nativeContest: contest, nativeId: task } = problem;
  if (!contest || !task) return null;
  const html = await get(`https://atcoder.jp/contests/${contest}/tasks/${task}`);
  const start = html.indexOf('id="task-statement"');
  if (start < 0) return null;
  let body = html.slice(start, start + 80000);
  const english = body.indexOf('class="lang-en"');
  if (english > 0) body = body.slice(english);
  const text = htmlToText(body);
  return text.length > 80 ? text : null;
}

/** 洛谷的页面请求：手动过一遍 cookie 挑战。 */
async function fetchLuoguPage(url) {
  const headers = { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    let response = await fetch(url, { headers, redirect: 'manual', signal: controller.signal });
    if (response.status >= 300 && response.status < 400) {
      const cookies = (response.headers.getSetCookie?.() ?? [])
        .map((value) => value.split(';')[0])
        .join('; ');
      if (!cookies) return null;
      response = await fetch(url, {
        headers: { ...headers, Cookie: cookies },
        redirect: 'follow',
        signal: controller.signal,
      });
    }
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 从洛谷页面里把 problem 数据挖出来。新版在 lentille-context，老版在 _feInjection。 */
function extractLuoguProblem(html) {
  const modern = /<script[^>]*id="lentille-context"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (modern) {
    try {
      const payload = JSON.parse(modern[1]);
      const problem = payload?.data?.problem ?? payload?.problem;
      if (problem) return problem;
    } catch {
      /* 结构变了就往下试老格式 */
    }
  }
  const legacy = /window\._feInjection\s*=\s*JSON\.parse\(decodeURIComponent\("([\s\S]*?)"\)\)/.exec(html);
  if (legacy) {
    try {
      return JSON.parse(decodeURIComponent(legacy[1]))?.currentData?.problem ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

function formatSamples(samples) {
  if (!Array.isArray(samples) || !samples.length) return '';
  const blocks = samples.slice(0, 3).map((pair, i) => {
    const [input, output] = Array.isArray(pair) ? pair : [];
    return `样例 ${i + 1}\n输入：\n${String(input ?? '').trim()}\n输出：\n${String(output ?? '').trim()}`;
  });
  return `## 样例\n\n${blocks.join('\n\n')}`;
}

async function fromLuogu(problem) {
  const pid = problem.nativeId;
  if (!pid) return null;
  const html = await fetchLuoguPage(`https://www.luogu.com.cn/problem/${pid}`);
  const data = html ? extractLuoguProblem(html) : null;
  if (!data) return null;

  const content = Array.isArray(data.content) ? data.content[0] : (data.content ?? {});
  const pick = (key) => tidyMarkdown(content[key] || data[key] || '');
  const title = tidyMarkdown(content.name || data.name || '');

  const parts = [
    title ? `# ${title}` : '',
    pick('background'),
    pick('description'),
    pick('formatI') ? `## 输入格式\n${pick('formatI')}` : '',
    pick('formatO') ? `## 输出格式\n${pick('formatO')}` : '',
    formatSamples(data.samples),
    pick('hint') ? `## 提示\n${pick('hint')}` : '',
  ].filter(Boolean);
  const text = parts.join('\n\n');
  return text.length > 80 ? text : null;
}

/**
 * 抓一道题的题面，返回纯文本；抓不到返回 null。
 * 不抛异常——题解生成不该因为抓不到题面就整个失败。
 */
export async function fetchStatement(problem) {
  const platform = problem?.platform ?? 'codeforces';
  try {
    const text =
      platform === 'atcoder'
        ? await fromAtCoder(problem)
        : platform === 'luogu'
          ? await fromLuogu(problem)
          : await fromCodeforces(problem);
    return text ? clip(text) : null;
  } catch {
    return null;
  }
}
