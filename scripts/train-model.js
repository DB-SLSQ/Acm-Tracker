// 采集比赛数据，训练「这个人能不能做出这道题」的模型，并和基线对比。
//
// 用法：
//   npm run train                  # 默认抓 300 场，够训练了
//   npm run train -- --contests 20 --reset   # 少量试跑，重头抓
//   npm run train -- --train-only            # 用已经采好的样本重新训练
//
// 数据来源是每场比赛的官方 standings 和 ratingChanges：
// 两个请求就能拿到一场比赛里所有人、每道题的通过情况，以及每个人赛前的分数。
// 所以拉一场比赛只要 2 个请求，300 场大约 10 分钟，比逐个用户抓快几个数量级。
//
// 采集到的样本会存进本地数据库，重跑会自动跳过已经采过的比赛。

import {
  FEATURE_NAMES,
  MODEL_KEY,
  evaluate,
  isModelUseful,
  prepareSample,
  serializeModel,
  trainBaseline,
  trainLogistic,
} from '../lib/model.js';
import * as db from '../lib/db.js';
import { CfError } from '../lib/cf.js';

const BASE = 'https://codeforces.com/api';
const GAP_MS = 2100; // 官方建议的间隔，别把人家接口打爆
const MAX_PARTICIPANTS = 220; // 每场最多留这么多参赛者，控制样本量

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i];
  if (!token.startsWith('--')) continue;
  const [key, inline] = token.replace(/^--/, '').split('=');
  const next = process.argv[i + 1];
  if (inline !== undefined) args.set(key, inline);
  else if (next && !next.startsWith('--')) {
    args.set(key, next);
    i += 1;
  } else args.set(key, true);
}
const WANTED_CONTESTS = Number(args.get('contests') ?? 300);
const RESET = args.has('reset');
const TRAIN_ONLY = args.has('train-only');

let lastCallAt = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callApi(method, params = {}) {
  for (let attempt = 0; attempt <= 4; attempt += 1) {
    const wait = lastCallAt + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    try {
      const url = new URL(`${BASE}/${method}`);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
      const response = await fetch(url, { headers: { 'User-Agent': 'acm-trainer/0.1.4' } });
      const payload = await response.json();
      if (payload.status === 'OK') return payload.result;
      const comment = String(payload.comment ?? `HTTP ${response.status}`).replace(/^\s*\d+:\s*/, '');
      if (!/limit|try again|too many|unavailable|temporar/i.test(comment)) {
        throw new CfError(comment);
      }
    } catch (error) {
      if (attempt === 4) throw error;
      process.stdout.write(`  第 ${attempt + 1} 次失败（${error.message}），稍后重试…\n`);
    }
    await sleep(3000 * (attempt + 1));
  }
  return null;
}

/** 只挑适合训练的场次：官方已结束、有 rating、且参赛者水平跨度大。 */
function pickContests(all, limit) {
  return all
    .filter((contest) => contest.phase === 'FINISHED')
    .filter((contest) => /Div\. ?[234]|Educational|Global Round|Div\. 1 \+ Div\. 2/i.test(contest.name))
    .sort((a, b) => b.id - a.id)
    .slice(0, limit);
}

async function collect(contests) {
  const already = RESET ? new Set() : db.modelSampleContestIds();
  if (RESET) db.clearModelSamples();
  const todo = contests.filter((contest) => !already.has(contest.id));
  console.log(`需要采集 ${todo.length} 场（已跳过 ${contests.length - todo.length} 场）。`);

  let index = 0;
  for (const contest of todo) {
    index += 1;
    process.stdout.write(`[${index}/${todo.length}] ${contest.id} ${contest.name.slice(0, 40)} … `);
    let standings;
    let changes;
    try {
      // 注意：非 gym 比赛只接受「不带任何额外参数」的匿名请求，
      // 加上 from/count 会被 CF 直接拒掉（错误信息里会提示走匿名 GET）。
      standings = await callApi('contest.standings', { contestId: contest.id });
      changes = await callApi('contest.ratingChanges', { contestId: contest.id });
    } catch (error) {
      console.log(`跳过（${error.message}）`);
      continue;
    }
    if (!standings?.rows?.length || !changes?.length) {
      console.log('跳过（没有 rated 成绩）');
      continue;
    }

    const ratingByHandle = new Map(changes.map((row) => [String(row.handle).toLowerCase(), row.oldRating]));
    const problems = standings.problems ?? [];
    const rows = [];

    // standings 按名次排好，直接取前 N 个会全是高手；等距抽样才能覆盖各个分段
    const stride = Math.max(1, Math.ceil(standings.rows.length / MAX_PARTICIPANTS));
    const sampled = standings.rows.filter((_, position) => position % stride === 0);

    for (const standing of sampled) {
      const member = standing.party?.members?.[0]?.handle;
      if (!member) continue;
      const rating = ratingByHandle.get(String(member).toLowerCase());
      if (!Number.isFinite(rating) || rating < 800) continue;

      problems.forEach((problem, position) => {
        const result = standing.problemResults?.[position];
        if (!result) return;
        // 标签口径：这场比赛里他做出来了没有。
        // 没提交的题也算「没做出来」——这是比赛的客观结果，而且「到后面几题就没时间做」
        // 本身就是真实规律，模型会通过题号位置这个特征学到它。
        rows.push({
          contestId: contest.id,
          handle: String(member).toLowerCase(),
          index: problem.index,
          rating,
          solved: result.points > 0 ? 1 : 0,
          problemRating: problem.rating ?? null,
          tags: problem.tags ?? [],
          at: contest.startTime,
        });
      });
    }

    db.saveModelSamples(rows);
    console.log(`${rows.length} 条样本`);
  }
}

function loadSamples(limit = 400000) {
  const total = db.countModelSamples();
  const take = Math.min(limit, total);
  return { samples: db.getModelSamples(take, 0).map(prepareSample), total };
}

function report(name, metrics) {
  const aucText = metrics.auc == null ? '—' : metrics.auc.toFixed(4);
  const loss = metrics.logLoss == null ? '—' : metrics.logLoss.toFixed(4);
  console.log(`  ${name.padEnd(10)} AUC ${aucText}   对数损失 ${loss}   样本 ${metrics.count}`);
}

async function main() {
  console.log('== 采集数据 ==');
  if (!TRAIN_ONLY) {
    const contests = await callApi('contest.list', { gym: 'false' });
    const picked = pickContests(contests, WANTED_CONTESTS);
    console.log(`题库里挑出 ${picked.length} 场适合训练的 rated 比赛。`);
    await collect(picked);
  }

  console.log('\n== 读样本 ==');
  const { samples, total } = loadSamples();
  if (!samples.length) {
    console.log('没有任何样本，先跑采集。');
    process.exit(1);
  }
  console.log(`库里共 ${total} 条样本，本次使用 ${samples.length} 条。`);
  const positive = samples.reduce((sum, row) => sum + row.label, 0) / samples.length;
  console.log(`通过率 ${(positive * 100).toFixed(1)}%（比赛里「做出来」的占比）。`);

  // 按时间切分：用较早的比赛训练，用最近的一批比赛检验，避免用未来数据打分
  const sorted = [...samples].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  const cut = Math.floor(sorted.length * 0.85);
  const train = sorted.slice(0, cut);
  const test = sorted.slice(cut);
  console.log(`训练集 ${train.length} 条，留出集 ${test.length} 条（按比赛时间划分）。`);

  console.log('\n== 训练 ==');
  const weights = trainLogistic(train);
  const baseWeights = trainBaseline(train);
  const metrics = evaluate(weights, test);
  const baseline = evaluate(baseWeights, test);
  report('本模型', metrics);
  report('只看难度差', baseline);
  console.log(`  AUC 提升 ${((metrics.auc ?? 0) - (baseline.auc ?? 0)).toFixed(4)}`);

  console.log('\n== 权重（绝对值越大影响越强）==');
  const named = [...weights]
    .map((value, index) => ({ name: FEATURE_NAMES[index] ?? String(index), value }))
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .slice(0, 8);
  for (const row of named) console.log(`  ${row.value.toFixed(3)}  ${row.name}`);

  const model = {
    weights,
    metrics,
    baseline,
    samples: samples.length,
    contests: db.modelSampleContestIds().size,
    trainedAt: Date.now(),
  };
  db.metaSet(MODEL_KEY, serializeModel(model));
  console.log(
    `\n${isModelUseful(model) ? '模型优于基线，推题时会用它。' : '模型没有明显优于基线，推题继续用原来的规则。'}`,
  );
}

main().catch((error) => {
  console.error('训练失败：', error.message);
  process.exit(1);
});
