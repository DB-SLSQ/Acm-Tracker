// 从比赛记录里学「这个人能不能做出这道题」。
//
// 为什么是这个问题，而不是「做了这道题能涨多少分」：
// 后者不是良定义的问题——练什么题不是随机分配的，强的人既做难题也涨分，
// 直接拿「做题 → 涨分」当标签，学出来的是「谁强」而不是「练什么有用」。
// 「给定赛前 rating 和题目条件，能否做出」是个标准二分类问题，能被验证：
// 留出一批比赛不参与训练，看模型预测得准不准，再决定要不要用它推题。
//
// 特征只用到比赛当场能拿到的信息（赛前 rating、题目难度、标签、年份、题号位置），
// 不掺入任何未来信息，所以离线评估的结果和真实使用时的情形是一致的。

import { KNOWLEDGE_AXES, knowledgeAxis, isNoiseTag } from './knowledge.js';

export const MODEL_VERSION = 1;
export const MODEL_KEY = 'solvability_model';

/** 特征名，顺序和 featureVector 的输出一一对应，调参和排错时方便看。 */
export const FEATURE_NAMES = [
  'bias',
  '难度差/200',
  '超纲部分',
  '题目难度/1000',
  ...KNOWLEDGE_AXES.map((axis) => `方向:${axis}`),
  ...KNOWLEDGE_AXES.map((axis) => `方向×超纲:${axis}`),
  '题目年代',
  '题号位置',
  '这场人数偏多',
];

const AXIS_INDEX = new Map(KNOWLEDGE_AXES.map((axis, index) => [axis, index]));

/** 把一条样本变成特征向量。axes 是这道题命中的知识方向（去重后）。 */
export function featureVector({ rating, problemRating, axes, yearsOld, indexPos, fieldSize }) {
  const diff = Math.max(-4, Math.min(4, (problemRating - rating) / 200));
  const over = Math.max(0, diff);
  const vector = new Float64Array(FEATURE_NAMES.length);
  let at = 0;
  vector[at++] = 1;
  vector[at++] = diff;
  vector[at++] = over;
  vector[at++] = Math.max(0, Math.min(2.5, problemRating / 1000));
  for (let i = 0; i < KNOWLEDGE_AXES.length; i += 1) vector[at + i] = axes.includes(i) ? 1 : 0;
  at += KNOWLEDGE_AXES.length;
  for (let i = 0; i < KNOWLEDGE_AXES.length; i += 1) vector[at + i] = axes.includes(i) ? over : 0;
  at += KNOWLEDGE_AXES.length;
  vector[at++] = Math.max(0, Math.min(2, (yearsOld ?? 2) / 6));
  vector[at++] = Math.max(0, Math.min(1.5, (indexPos ?? 3) / 5));
  vector[at++] = fieldSize ? 1 : 0;
  return vector;
}

/** 把从数据库读出来的原始行整理成训练样本：题目标签先归到知识方向。 */
export function prepareSample(row) {
  const axes = [];
  for (const tag of row.tags ?? []) {
    if (isNoiseTag(tag)) continue;
    const axis = knowledgeAxis(tag);
    const index = axis ? AXIS_INDEX.get(axis) : undefined;
    if (index !== undefined && !axes.includes(index)) axes.push(index);
  }
  return {
    ...row,
    problemRating: Math.max(800, Math.min(3500, row.problemRating ?? 1500)),
    axes,
  };
}

export function sigmoid(z) {
  if (z < -30) return 0;
  if (z > 30) return 1;
  return 1 / (1 + Math.exp(-z));
}

export function predict(weights, sample) {
  const vector = featureVector(sample);
  let sum = weights[0];
  for (let i = 1; i < vector.length; i += 1) sum += weights[i] * vector[i];
  return sigmoid(sum);
}

/** 固定的伪随机数发生器：同样的数据每次训练得到同样的结果，方便对比。 */
export function makeRandom(seed = 20260922) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * 逻辑回归 + 小批量梯度下降。
 * 不用深度学习：样本里真正有用的信号是「难度差 + 专题」，线性模型够用，
 * 而且权重能直接看（哪个方向在高难度下更吃力），出问题好查。
 */
export function trainLogistic(samples, { epochs = 12, batchSize = 256, lr = 0.08, l2 = 1e-4, seed = 20260922 } = {}) {
  const random = makeRandom(seed);
  const weights = new Float64Array(FEATURE_NAMES.length);
  const vectors = samples.map((sample) => featureVector(sample));
  const labels = samples.map((sample) => sample.label);
  const order = samples.map((_, index) => index);
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const batch = new Float64Array(weights.length);

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const rate = lr / (1 + epoch * 0.15);
    for (let start = 0; start < order.length; start += batchSize) {
      batch.fill(0);
      const end = Math.min(order.length, start + batchSize);
      for (let k = start; k < end; k += 1) {
        const index = order[k];
        const vector = vectors[index];
        let sum = weights[0];
        for (let i = 1; i < vector.length; i += 1) sum += weights[i] * vector[i];
        const error = sigmoid(sum) - labels[index];
        batch[0] += error;
        for (let i = 1; i < vector.length; i += 1) batch[i] += error * vector[i];
      }
      const scale = rate / (end - start);
      weights[0] -= scale * batch[0];
      for (let i = 1; i < weights.length; i += 1) {
        weights[i] -= scale * (batch[i] + l2 * weights[i]);
      }
    }
  }
  return weights;
}

/** 只带「难度差 + 偏置」的模型：现有的经验规则差不多就是这个水平，用它当基线。 */
export function trainBaseline(samples, options = {}) {
  const simple = samples.map((sample) => ({
    ...sample,
    axes: [],
    indexPos: 0,
    yearsOld: 2,
    fieldSize: false,
  }));
  return trainLogistic(simple, options);
}

/** AUC：随机取一对「做出」和「没做出」的样本，模型给前者更高分的概率。 */
export function auc(scores) {
  const positives = scores.filter((row) => row.label === 1).map((row) => row.score).sort((a, b) => a - b);
  const negatives = scores.filter((row) => row.label === 0).map((row) => row.score).sort((a, b) => a - b);
  if (!positives.length || !negatives.length) return null;
  let total = 0;
  for (const value of positives) {
    let lo = 0;
    let hi = negatives.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (negatives[mid] <= value) lo = mid + 1;
      else hi = mid;
    }
    total += lo;
  }
  return total / (positives.length * negatives.length);
}

export function logLoss(scores) {
  if (!scores.length) return null;
  const sum = scores.reduce((acc, row) => {
    const p = Math.max(1e-6, Math.min(1 - 1e-6, row.score));
    return acc - (row.label === 1 ? Math.log(p) : Math.log(1 - p));
  }, 0);
  return sum / scores.length;
}

export function evaluate(weights, samples) {
  const scores = samples.map((sample) => ({ label: sample.label, score: predict(weights, sample) }));
  const right = scores.filter((row) => (row.score >= 0.5 ? 1 : 0) === row.label).length;
  return {
    auc: auc(scores),
    logLoss: logLoss(scores),
    accuracy: scores.length ? right / scores.length : null,
    count: scores.length,
    positiveRate: scores.length ? scores.reduce((sum, row) => sum + row.label, 0) / scores.length : null,
  };
}

export function serializeModel(model) {
  return JSON.stringify({
    version: MODEL_VERSION,
    featureNames: FEATURE_NAMES,
    weights: [...model.weights],
    metrics: model.metrics,
    baseline: model.baseline,
    samples: model.samples,
    contests: model.contests,
    trainedAt: model.trainedAt,
  });
}

export function parseModel(text) {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed?.version !== MODEL_VERSION || !Array.isArray(parsed.weights)) return null;
    if (parsed.weights.length !== FEATURE_NAMES.length) return null;
    return { ...parsed, weights: Float64Array.from(parsed.weights) };
  } catch {
    return null;
  }
}

/**
 * 模型值不值得用：必须在留出集上明显优于「只看难度差」的基线，否则宁可用原来的规则。
 * 门槛定得保守：AUC 绝对值不低于 0.75，并且要么 AUC 高 0.005 以上，
 * 要么对数损失至少低 1%。避免拿噪声当改进——推题被噪声带偏，用户是感受不到的。
 */
export function isModelUseful(model) {
  const modelAuc = model?.metrics?.auc;
  const baseAuc = model?.baseline?.auc;
  const modelLoss = model?.metrics?.logLoss;
  const baseLoss = model?.baseline?.logLoss;
  if (!Number.isFinite(modelAuc) || !Number.isFinite(baseAuc)) return false;
  const betterAuc = modelAuc - baseAuc >= 0.005;
  const betterLoss = Number.isFinite(modelLoss) && Number.isFinite(baseLoss) && modelLoss <= baseLoss * 0.99;
  return modelAuc >= 0.75 && (betterAuc || betterLoss);
}
