# ACM 训练台（仓库名 Acm-Tracker）

单人本地使用的 Codeforces 训练工具。Electron 桌面程序 + Node 本地服务 + 原生前端，
**零运行时依赖**（后端只用 Node 自带的 `node:sqlite`，前端没有构建步骤）。
作者：DB_SLSQ（GitHub: DB-SLSQ）。交流群 QQ 1124017564。

## 怎么跑 / 怎么打包

```powershell
npm.cmd start          # 网页版，浏览器开 http://127.0.0.1:5173
npm.cmd run desktop    # 桌面窗口（开发模式）
npm.cmd run build      # 生成安装包到 dist\
npm.cmd run train      # 采集比赛数据并训练推题模型（可加 -- --contests 300）
npm.cmd run sync       # 手动刷新题库
```

注意：用户的 PowerShell 禁止运行 `.ps1`，所以**一律用 `npm.cmd`**，不要用 `npm`。

- 打包已在 `package.json` 里配好 `build.electronDist = node_modules/electron/dist`，
  打包时复用本地已装好的 Electron，不会再下载 110MB。
- 国内网络：npm 官方源和 github.com 都不通，要用镜像
  （`--registry=https://registry.npmmirror.com`、`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`）。

## 数据放在哪

- 打包后的程序：`%APPDATA%\acm-trainer\data\trainer.db`
- 开发模式：项目里的 `data\trainer.db`（已被 .gitignore 忽略）
- 表：`problems`（题库缓存）、`submissions`、`rating_history`、`users`、`contests`、
  `settings`（键值）、`meta`（含训练好的模型 JSON）、`model_samples`（训练样本）、
  `blocked_problems`、`progress`、`platform_stats`、`virtual_sessions`

## 代码约定

- 注释用中文，重点写**为什么**这么做，而不是复述代码在做什么。
- 新增算法要在注释里带实测数据（比如「实测 99 题里 2016 年以前占 43%，加年份权重后降到 18%」）。
- 不引入运行时依赖；需要新工具时优先用 Node 自带能力。
- 答案里不要用「不是 X 而是 Y」这种对比句，也不要写「正确的废话」。

## 已实现的功能

训练计划（按目标 rating 分阶段）、训练日程（按天排，支持休息日和临时没空、题目顺延）、
活动热力图（5 种配色）、平台数据（洛谷难度分布 + 牛客）、做题记录（屏蔽的题可恢复、
做过的题按通过时间倒序）、能力画像（8 大方向 75 分位 + 置信度）、比赛日历、虚拟参赛、
设置（模块开关、四套主题、水平评估的排除区间、单个标签占比上限、推题模型训练）。

题量分配是**按知识方向的配额制**：八个方向差不多，弱项多分一两道（权重 1 + 0.4 × 强度，
最大余数法取整）。实测 99 题的题单分到 16/14/13/13/13/13/13/4（字符串那档是题源不够，
不是算法问题）。某个方向名额凑不齐时，用**轮转补位**（每个方向轮流补一道）而不是按分数堆——
按分数堆会把 greedy/implementation 顶到 40% 以上，等于把配额制废掉。

训练计划里可以勾「隐藏标签」：题单不显示算法方向，「重点补强」那行也会换成模糊说法
（否则等于把信息泄了）。这个开关存在 settings 的 `hide_tags`。

## 发布流程

1. 改 `package.json` 的 `version`
2. `npm.cmd run build`，产物在 `dist\ACM Trainer Setup x.y.z.exe`
3. 写更新说明（放 `outputs/release-notes-vX.Y.Z.md`，风格参考旧的那几份：说清改了什么、为什么）
4. `git push origin main` + `git push origin vX.Y.Z`
5. GitHub 上建 Release：标签选对应 tag，标题写版本号，附件传 exe

## 踩过的坑（别再踩）

- **Codeforces 接口**：非 gym 比赛的 `contest.standings` 只接受不带任何额外参数的匿名请求，
  加 `from`/`count` 会被直接拒绝。要一页拿全场再自己等距抽样。
- **洛谷难度是 9 档**（中间有「普及」和「提高」两档），配色对应 `public/app.js` 的 `LUOGU_COLORS`。
- **推题模型**：训练完必须按时间切分出留出集，和「只看难度差」的基线比；AUC 不低于 0.75
  且明显优于基线才启用，否则继续用内置规则，界面要写明原因。
- **水平评估的排除区间**：签到题会把标签的 75 分位拖低，默认忽略比当前 rating 低 400 分的题。
- **单个标签占比上限**默认 40%，可在设置里调；算法在 `lib/plan.js` 的 `pickProblems`。
- **视觉细节用户很敏感**：截图/视频里出现过横向拉伸、徽章出框、颜色不符合直觉，都会被指出来。
- **改 .cmd 脚本**：必须存成 GBK + CRLF，否则中文 Windows 的 cmd 会读成乱码。

## 宣传素材

素材不在仓库里，原先放在 C 盘会话目录 `outputs\video-assets`：
4 分半的宣传视频、v0.1.3 更新视频（短版 1 分 22 秒）、封面、二次元头像、
以及生成它们的脚本（在 `work\` 下：`make-video*.mjs`、`make-cover*.ps1`、`make-slides*.ps1`）。
配音用的是 Edge 在线语音（`work/tools/node_modules/msedge-tts`，女声 zh-CN-XiaoxiaoNeural），
**需要联网，而且它偶尔会掐连接**，脚本里已经做了重试和跳过已生成段落。
