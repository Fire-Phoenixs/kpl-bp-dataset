# 数据来源与合规说明

本文说明本数据集**从哪里来、怎么取、能怎么用、不能用在哪**。所有内容可核查：接口 URL 可直接打开，字段名与归一化逻辑对应 `scripts/collect-kpl-bp-all.mjs`。

---

## 1. 一句话概括

KPL / 世冠 / 挑战者杯 / 年度总决赛的 BP 数据，来自**腾讯官方赛事数据域**——`pvp.qq.com` 赛事数据中心页面（`matchdata/schedule.html`）是 JS 渲染的，页面自身调用的就是本文列出的三个公开接口。采集脚本模拟的是**普通浏览器访客**读取公开赛事数据的行为：不登录、不带 Cookie、不绕过任何反爬、不取账号与个人信息。

---

## 2. 抓取对象

| # | 用途 | 请求 | 说明 |
| --- | --- | --- | --- |
| 0 | 数据页面（人类可读） | `GET https://pvp.qq.com/matchdata/schedule.html?league_id={league_id}` | 前端渲染页；页面内 JS 调用下列接口，故本仓库不解析页面 DOM，直接调用接口 |
| 1 | 赛事列表 | `GET https://prod.comp.smoba.qq.com/leaguesite/leagues/open` | 返回全部赛事元数据（`league_id`、名称、类型、年份、赛季、起止时间、状态） |
| 2 | 赛程 / 场次 | `GET https://prod.comp.smoba.qq.com/leaguesite/matches/open?league_id={league_id}` | 每个赛事的大场列表，含双方战队、比分、阶段，以及 `match_battle_video_list[].battle_id`（小局 ID 来源） |
| 3 | 单局详情 | `GET https://prod.comp.smoba.qq.com/leaguesite/battle/open?battle_id={battle_id}` | **核心**：`bp_list`（逐手 ban/pick）、`battle_player_list`（选手-英雄）、双方经济、胜负、时长 |

请求头只有常规浏览器 UA 与 `Referer: https://pvp.qq.com/`，无任何鉴权信息。

---

## 3. 接口响应结构（节选）

### 3.1 赛事列表 `leagues/open`

真实响应外层为 `{code, message, results: [...]}`。单条赛事（节选）：

```json
{
  "status": 2,
  "league_type_name": "kpl",
  "league_id": "20190001",
  "league_name": "2019KPL春季赛",
  "season": 1,
  "year": 2019,
  "start_time": "2019-03-06 00:00:00",
  "end_time": "2019-06-02 23:59:00",
  "is_top": 1,
  "league_icon": "https://res.edata.qq.com/sgame/static/images/league/20190001.jpg",
  "live_room_address": "https://pvp.qq.com/cp/kpl2026/index.html"
}
```

### 3.2 赛程 `matches/open?league_id=`

真实响应外层为 `{code, message, results: [...]}`，单场（节选）：

```json
{
  "match_id": "2026100201",
  "league_id": "20260004",
  "camp1": { "team_id": "10017", "team_name": "广州TTG", "team_abbreviation": "TTG", "score": 3, "is_win": true },
  "camp2": { "team_id": "10008", "team_name": "深圳DYG", "team_abbreviation": "DYG", "score": 0, "is_win": false },
  "bo": 5,
  "win_camp": 1,
  "status": 2,
  "start_time": "2026-10-02 14:00:00",
  "end_time": "2026-10-02 15:30:44",
  "match_address": "广州",
  "match_stage_name": "lts",
  "match_stage_desc": "擂台赛",
  "cc_match_id": "KPL2026S3M1W1D1",
  "match_battle_video_list": [
    { "battle_id": "1054884368_36_1790920656", "battle_seq": 1, "video_list": [ /* 回放视频，未采集 */ ] }
  ]
}
```

`status` 为 `2` 表示比赛已结束；只有已结束场次才有完整的单局数据。`match_battle_video_list[].battle_id` 是逐局拉取详情的入口，`battle_seq` 即第几小局。

### 3.3 单局详情 `battle/open?battle_id=`

该接口返回**原始字段名**，本仓库在采集时立即归一化写入 `data/raw/battles.jsonl`（下方“原始字段 → 归一化”表）。原始响应中的关键字段结构：

| 分组 | 原始字段 | 说明 |
| --- | --- | --- |
| 顶层 | `battle_id` / `battle_seq` | 小局 ID / BO 内序号 |
| 顶层 | `win_camp` | 胜方阵营：`1` 蓝方、`2` 红方 |
| 顶层 | `game_duration` | 比赛时长，**毫秒**（入库时 `/1000` 取整为 `duration_sec`） |
| BP | `bp_list[]` | 逐手 BP，元素见下表 |
| BP | `bp_list[].camp` | `1` 蓝方、`2` 红方 |
| BP | `bp_list[].is_ban_or_pick` | **`0` = 禁用（ban），`1` = 选择（pick）** |
| BP | `bp_list[].hero_name` / `hero_id` / `position` | 英雄名 / 英雄 ID / 定位序号 |
| 选手 | `battle_player_list[]` | `camp, hero_name, hero_id, player_name, position_desc, kill_num, death_num, assist_num, gold, is_mvp, is_lose_mvp` |
| 队列统计 | `camp1` / `camp2` | `kill_num, assist_num, death_num, gold, kda, push_tower_num, kill_tyrant_num, kill_dark_tyrant_num, kill_big_dragon_num, kill_shadow_dragon_num, kill_storm_dragon_king_num, kill_prophet_dragon_num` |

采集脚本归一化后写入 `data/raw/battles.jsonl` 的一行（真实记录，节选）：

```json
{
  "battle_id": "1054884368_36_1790920656",
  "battle_seq": 1,
  "league": { "id": "20260004", "name": "2026年KPL年度总决赛", "type": "kpl", "year": 2026, "season": 4 },
  "match": { "id": "2026100201", "date": "2026-10-02", "stage_desc": "擂台赛", "bo": 5,
             "team1": { "id": "10017", "name": "广州TTG", "abbr": "TTG", "score": 3, "isWin": true },
             "team2": { "id": "10008", "name": "深圳DYG", "abbr": "DYG", "score": 0, "isWin": false } },
  "win_camp": 2,
  "duration_sec": 832,
  "bp": [ { "camp": 1, "action": "ban", "hero": "沈梦溪", "heroId": 312, "position": 0 } ],
  "bp_count": 20,
  "sides": { "camp1": { "kills": 7, "assists": 19, "deaths": 13, "gold": 41013, "towers": 1 },
             "camp2": { "kills": 13, "assists": 35, "deaths": 7, "gold": 50763, "towers": 6 } },
  "players": [ { "camp": 2, "hero": "夏洛特", "heroId": 536, "player": "萝卜", "pos": "对抗路",
                 "k": 2, "d": 0, "a": 3, "gold": 11107, "mvp": false, "loseMvp": false } ]
}
```

### 3.4 原始字段 → 数据集字段映射

| 原始 | 数据集 | 转换 |
| --- | --- | --- |
| `bp_list[].is_ban_or_pick` | `draft[].action` | `0 → "ban"`，其余 → `"pick"` |
| `bp_list[].camp` | `draft[].camp` | 原样 `1`/`2`；派生 `side`（`side` 仅出现在 `draft-actions.csv`） |
| `bp_list[].hero_name` / `hero_id` | `draft[].hero` / `hid` | 原样 |
| `bp_list[].position` | `draft[].pos` | 缺省 `null`（ban 恒为 `0`） |
| `game_duration`（毫秒） | `duration_sec` | `Math.round(ms / 1000)` |
| `win_camp` | `winner_side` / `win_camp` | `1 → "blue"`、`2 → "red"`；宽表同时保留 `win_camp`（1/2） |
| `camp1/camp2.push_tower_num` | `stats.blue/red.towers` | 原样 |
| `battle_player_list[].player_name` | `players[][2]` | 原样（个别为空串，保留空值） |

---

## 4. robots.txt 核实结果

| URL | 结果 | 说明 |
| --- | --- | --- |
| `https://pvp.qq.com/robots.txt` | **HTTP 404** | 无 `robots.txt`，即无显式禁止规则 |
| `https://www.qq.com/robots.txt` | **200**，内容为 `User-agent: *` + `Disallow:`（空值） | 即不禁止任何路径 |
| `https://prod.comp.smoba.qq.com/robots.txt` | **HTTP 404**（实测 2026-10-24，**仅 1 次请求**） | 返回 145 字节的 `stgw` 404 页：`<html><head><title>404 Not Found</title></head>...<hr><center>stgw</center>`，无 `robots.txt` 规则 |

> 备注：`robots.txt` 404 不等于“授权采集”，只是表示站点未通过 robots 协议声明限制。因此本仓库仍按最小必要原则采集（见下节），并保留完整的来源标注与下架渠道（见 [NOTICE](../NOTICE)）。

---

## 5. 采集参数（可复现）

| 参数 | 值 |
| --- | --- |
| 并发 | **单并发、严格串行**（一个请求结束后才发下一个） |
| 每局间隔 | **300 ms**（`--gap 300`，实测约 2.5 请求/秒） |
| 全量请求量 | 约 **11,141** 次单局详情请求（另有 1 次赛事列表 + 33 次赛程） |
| 全量耗时 | 约 **75 分钟**（不含重试） |
| 重试 | 每请求最多 3 次，单请求超时 20 s；失败记录进 `data/raw/fails.json` |
| 断点续跑 | 已采集的 `battle_id` 自动跳过，可随时中断/恢复 |
| 请求头 | 常规桌面浏览器 UA + `Referer: https://pvp.qq.com/` |
| 不采集 | 账号/Cookie/登录态、选手个人信息、视频、图片、评论、弹幕 |
| 过滤 | 只取 `status == 2`（已结束）的场次与其小局 |

```bash
# 全量（默认串行 300ms，输出 data/raw/）
node scripts/collect-kpl-bp-all.mjs

# 只跑指定赛事 / 调整间隔 / 抽样
node scripts/collect-kpl-bp-all.mjs --league 20250001
node scripts/collect-kpl-bp-all.mjs --gap 500
node scripts/collect-kpl-bp-all.mjs --max-battles 12
```

---

## 6. 字段含义与数据限制

| 项 | 说明 |
| --- | --- |
| `is_ban_or_pick` | 官方原始字段：`0`=禁用、`1`=选择；入库后统一为 `action: "ban" / "pick"` |
| `camp` / `win_camp` | `1`=蓝方、`2`=红方；`win_camp` 与 `winner_side` 同义 |
| `duration_sec` | 由 `game_duration`（毫秒）四舍五入到秒；个别对局缺失为 `null` |
| **2019 年无 BP** | 部分 2019 年对局 `bp_list` 返回空数组（队伍、选手、经济数据仍在）。**BP 覆盖以 2020 年起为主**，准确覆盖量以 `data/stats/summary.json` 为准 |
| 残缺 BP | 上游接口偶发只返回部分动作（例：5 手 pick、6 手、7 手、9 个 ban、19 手）。数据**原样保留**并标 `complete: false`，不补造、不推断 |
| 完整 BP | `picks == 10 && bans ∈ {8, 10}`（KPL 不同年代禁用位 8→10 不等，不做单一常量假设）；只有完整对局参与比率统计 |
| 顺序漂移 | 极少数对局在两次采集之间 `bp_list` 顺序有微调（英雄集合一致），以最新一次采集为准 |
| 大比分 | `blue.score` / `red.score` 是**大场比分**（同一大场每局相同），不是本局击杀 |
| 选手名 | `player_name` 偶尔为空串（官方缺失），保留空值而不猜测 |
| 定位 | `position` 为官方给出的定位序号（0 起，按 pick 顺序），与“分路”不是严格一一对应 |

---

## 7. 数据权利归属

- 赛事、对局、BP、选手与战队名称等数据的**著作权归腾讯 / 王者荣耀赛事方所有**。
- 本仓库**不主张对数据事实部分的版权**，也不授予任何超出权利人许可范围的权利。
- 本仓库自行创作的部分（目录结构、字段设计、统计脚本、文档、校验代码）按 **CC BY-NC 4.0** 授权，见 [LICENSE](../LICENSE)。
- 若权利人提出异议，请通过仓库 Issue 联系，我们会立即删除相关内容（见 [NOTICE](../NOTICE)）。

---

## 8. 允许 / 不建议的用法

**可以（研究与开发）**

- 学术研究、赛事复盘、教学示例、数据可视化
- 训练/评测非商业模型（在遵守 LICENSE 非商业条款的前提下）
- 开发非商业的 BP 辅助工具、报表工具
- 引用统计结论时注明「数据来源：腾讯官方赛事数据接口，整理仓库 <https://github.com/Fire-Phoenixs/kpl-bp-dataset>」

**不建议 / 不允许**

- ❌ 商业再分发：把数据集或其衍生数据打包售卖、作为付费产品/付费 API 的数据源
- ❌ 声称「官方」「腾讯授权」「KPL 官方数据」等
- ❌ 与深色产业链结合（博彩、代练、外挂、账号交易）
- ❌ 大规模抓取原作者页面（如 `pvp.qq.com` 页面本身）而不遵守其条款；本仓库只提供已整理的公开赛事数据，不提供抓取代理服务
- ❌ 用本数据推断或公开选手/战队的非公开信息（如薪资、合同、伤病）

---

## 9. 复现与校验

```bash
# 1) 采集（断点续跑，串行 300ms）
node scripts/collect-kpl-bp-all.mjs

# 2) 编译（在仓库根执行，输出到当前目录）
node scripts/build-kpl-db.mjs --out .

# 3) 校验（与 GitHub Actions 同款，退出码非 0 即失败）
node scripts/validate-dataset.mjs
```

采集产物（`data/raw/`）与本地数据库（`*.sqlite`）不进入版本库，见 [.gitignore](../.gitignore)。

---

## 10. 变更与联系

- 数据更新以 `data/stats/summary.json` 的 `generated_at` / `version` 为准
- 发现字段错误、缺失或权利问题：请开 Issue（<https://github.com/Fire-Phoenixs/kpl-bp-dataset/issues>）
- 本文档最后核实日期：**2026-10-24**（含接口域 `robots.txt` 实测 1 次请求）
