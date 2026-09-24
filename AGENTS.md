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

训练计划（按目标 rating 分阶段，钉住不漂、做过的题自动打勾、每行可「换一道」）、
今日任务卡片（当前水平下面：今天哪几题、当日进度条、距计划结束 / 落后几天）、
训练日程（按天排，支持休息日和临时没空、题目顺延）、
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
2. 写更新说明（放 `outputs/release-notes-vX.Y.Z.md`，风格参考旧的那几份：说清改了什么、为什么）
3. 提交并 `git push origin main`
4. 打 tag 推上去：`git push origin vX.Y.Z`

**推完 tag 剩下的交给 GitHub Actions**（`.github/workflows/release.yml`）：它会自动
`npm ci` + `npm run build`，然后把 exe 作为附件建成 Release，正文取自
`outputs/release-notes-<tag>.md`。不用在本机打包，也不用本机存写权限的令牌
——本机那个 GitHub 令牌只有读权限，传不了 Release 附件。

要在本机出安装包（自己装着玩）再 `npm.cmd run build`，产物在 `dist\ACM Trainer Setup x.y.z.exe`。
注意仓库根目录不能有名字坏掉的文件夹（之前几次命令写错环境变量造出来的乱码目录
会让 electron-builder 直接报 lstat ENOENT），`.dev\clean-junk-dirs.mjs` 会清掉它们。

## 踩过的坑（别再踩）

- **Codeforces 接口**：非 gym 比赛的 `contest.standings` 只接受不带任何额外参数的匿名请求，
  加 `from`/`count` 会被直接拒绝。要一页拿全场再自己等距抽样。
- **洛谷难度是 9 档**（中间有「普及」和「提高」两档），配色对应 `public/app.js` 的 `LUOGU_COLORS`。
- **推题模型**：训练完必须按时间切分出留出集，和「只看难度差」的基线比；AUC 不低于 0.75
  且明显优于基线才启用，否则继续用内置规则，界面要写明原因。
- **水平评估的排除区间**：签到题会把标签的 75 分位拖低，默认忽略比当前 rating 低 400 分的题。
- **单个标签占比上限**默认 40%，可在设置里调；算法在 `lib/plan.js` 的 `pickProblems`。
- **训练日程锚在「计划定下来的那天」**（`plan_snapshots.created_at`，界面上是 `plan.generatedAt`），
  不是锚在今天。锚今天的话，勾掉一题后面的题就往前顶，今天这张卡永远显示 0/2，进度条就没意义了。
  「落后几天」按**今天之前**该做完的题算，把今天算进去的话每天一起床就凭空落后一整天。
- **每天一套题要「四档均分」**：练手 / 进阶 / 提升 / 学习，间距 200 分，相对这一阶段的中心
  （`lib/plan.js` 的 `LADDER_TIER_OFFSETS = [-150, 50, 250, 450]`）。用户原话是
  「1600 练手、1800 进阶、2000 提升、2200-2300 学习」——他 1600 分、目标 1900，
  第一阶段中心正好 1750，所以四档就是 1600/1800/2000/2200，平均正好压在目标分上。
  一天几题就顺着发：四题各一道，两题则是「练手+进阶 → 进阶+提升 → 提升+学习 → 学习+练手」
  循环，长期每档一样多。实测第一阶段四档分到 25/19/14/22 题，方向配额仍然是 11/10/10/10/10/10/10/9。
  之前是把打分排序直接按天发，平均每天难度跨度只有 6 分（天天秒签到题）。
- **上面这条要靠 `PLAN_VERSION` 让老计划失效**：钉住的快照里没有 2000 分以上的题，
  不重挑的话新档位根本发不出来。改挑题算法/区间时记得把 `server.js` 的 `PLAN_VERSION` +1。
- **视觉细节用户很敏感**：截图/视频里出现过横向拉伸、徽章出框、颜色不符合直觉，都会被指出来。
- **改 .cmd 脚本**：必须存成 GBK + CRLF，否则中文 Windows 的 cmd 会读成乱码。

## 宣传素材

素材不在仓库里，原先放在 C 盘会话目录 `outputs\video-assets`：
4 分半的宣传视频、v0.1.3 更新视频（短版 1 分 22 秒）、封面、二次元头像、
以及生成它们的脚本（在 `work\` 下：`make-video*.mjs`、`make-cover*.ps1`、`make-slides*.ps1`）。
配音用的是 Edge 在线语音（`work/tools/node_modules/msedge-tts`，女声 zh-CN-XiaoxiaoNeural），
**需要联网，而且它偶尔会掐连接**，脚本里已经做了重试和跳过已生成段落。
