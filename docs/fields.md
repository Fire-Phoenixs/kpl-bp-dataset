# 字段字典

本文件逐个说明 `data/` 下所有文件的字段：**类型、含义、示例、空值情况**。类型按 JSON 语义标注（CSV 里的数字列在纯文本中仍是字符串，需自行转换）。

通用约定：

- **空值**：JSON 用 `null`，CSV 用空单元格（空字符串）。下文“可空”指这两种形式都可能出现。
- **百分比**：`*_rate` / `presence` / `*_pct` 均为 **0–100 的数值**（保留 1 位小数），不是 0–1 小数。
- **阵营**：`camp` / `win_camp` 用 `1`=蓝方、`2`=红方；`side` / `winner_side` 用 `"blue"` / `"red"`。两套写法一一对应。
- **ID**：`battle_id`、`match_id`、`league_id`、`team_id` 都是**字符串**（可能含下划线或前导零），不要当数字处理。
- **时间**：`date` 为 `YYYY-MM-DD`；`start_time` / `end_time` 为 `YYYY-MM-DD HH:MM:SS`；`generated_at` 为 ISO 8601（UTC）。

---

## 1. `data/leagues.json`

数组，一行一个赛事（含无对局的赛事，计数为 0）。

| 字段 | 类型 | 含义 | 示例 | 空值 / 备注 |
| --- | --- | --- | --- | --- |
| `league_id` | string | 赛事 ID | `"20260004"` | 否；主键 |
| `league_name` | string | 赛事中文名 | `"2026年KPL年度总决赛"` | 可能为空串（赛事元数据缺失时） |
| `league_type` | string | 赛事类型 | `"kpl"` / `"world_champion_cup"` / `"winter_champion_cup"` | 可空 |
| `year` | int | 年份 | `2026` | 可空 |
| `season` | int | 赛季序号 | `4` | 可空；`0` 表示季前赛等特殊阶段 |
| `start_time` | string | 开赛时间 | `"2026-10-02 00:00:00"` | 可能为空串 |
| `end_time` | string | 结束时间 | `"2026-11-14 23:59:59"` | 可能为空串 |
| `matches` | int | 大场数 | `40` | 否 |
| `games` | int | 小局数 | `159` | 否 |
| `games_with_bp` | int | 有 BP 的小局数（含残缺） | `159` | 否 |
| `games_complete` | int | **完整 BP** 小局数（计入统计口径） | `159` | 否 |

---

## 2. `data/matches.csv`

utf-8 带 BOM，一行一个大场（BO 系列赛）。

| 列 | 类型 | 含义 | 示例 | 空值 / 备注 |
| --- | --- | --- | --- | --- |
| `match_id` | string | 大场 ID | `"2026100201"` | 否；主键 |
| `league_id` | string | 所属赛事 ID | `"20260004"` | 否 |
| `league` | string | 赛事名（冗余） | `"2026年KPL年度总决赛"` | 否 |
| `year` | int | 年份 | `2026` | 否 |
| `date` | string | 比赛日期 | `"2026-10-14"` | 否 |
| `stage` | string | 轮次 / 阶段中文名 | `"擂台赛"`、`"常规赛第一轮"` | 可能为空串 |
| `bo` | int | 赛制 BO 数 | `5`、`7` | 否 |
| `venue` | string | 举办城市 / 场馆 | `"上海"` | 可能为空串 |
| `team1` | string | 队伍 1 名称 | `"重庆狼队"` | 否 |
| `score1` | int | 队伍 1 大场比分 | `1` | 否 |
| `team2` | string | 队伍 2 名称 | `"杭州LGD.NBW"` | 否 |
| `score2` | int | 队伍 2 大场比分 | `3` | 否 |
| `winner` | string | 胜队名 | `"杭州LGD.NBW"` | 可能为空串（平局/数据缺失） |
| `games` | int | 该场小局数 | `4` | 否 |

---

## 3. `data/battles.jsonl`

**核心文件**。每行一个 JSON 对象 = 一个小局，按 `battle_id` 排序。

### 3.1 顶层

| 字段 | 类型 | 含义 | 示例 | 空值 / 备注 |
| --- | --- | --- | --- | --- |
| `battle_id` | string | 小局唯一 ID（官方） | `"1054884368_10_1791982621"` | 否；主键，全局唯一 |
| `match_id` | string | 所属大场 ID | `"2026101402"` | 否 |
| `game_no` | int | BO 内第几小局（1 起） | `3` | 否 |
| `league_id` | string | 赛事 ID | `"20260004"` | 否 |
| `league` | string | 赛事名 | `"2026年KPL年度总决赛"` | 否 |
| `year` | int | 年份 | `2026` | 否 |
| `league_type` | string | 赛事类型 | `"kpl"` | 可空 |
| `date` | string | 比赛日期 | `"2026-10-14"` | 否 |
| `stage` | string | 轮次 / 阶段 | `"擂台赛"` | 可能为空串 |
| `bo` | int | 该场 BO 数 | `5` | 否 |
| `blue` | object | 蓝方信息 | 见 3.2 | 否 |
| `red` | object | 红方信息 | 见 3.2 | 否 |
| `winner_side` | string | 胜方阵营 | `"red"` | 否；`"blue"` / `"red"` |
| `duration_sec` | int | 比赛时长（秒） | `887` | **可空**（上游缺 `game_duration`） |
| `stats` | object | 双方经济/击杀统计 | 见 3.3 | 否（子项可空） |
| `first_pick_side` | string | 第一手选人的阵营 | `"blue"` | **可空**（该局无 pick 时为 `null`） |
| `bans` | int | 本局 ban 动作数 | `10` | 否；常规为 8 或 10，残缺时更少 |
| `picks` | int | 本局 pick 动作数 | `10` | 否；完整对局必为 10 |
| `complete` | bool | **是否完整 BP**：`picks==10 && bans∈{8,10}` | `true` | 否；统计口径据此筛选，`battles.csv` 中同一字段为 `1`/`0` |
| `draft` | array | 逐手 BP，按实际顺序 | 见 3.4 | 否；无 BP 时为空数组 `[]` |

> 选手-英雄对应不在本文件里，见 [`players.jsonl`](#6-dataplayersjsonl)；举办城市见 `matches.csv` 的 `venue`。

### 3.2 `blue` / `red` 子对象

| 字段 | 类型 | 含义 | 示例 | 空值 / 备注 |
| --- | --- | --- | --- | --- |
| `team` | string | 战队全名 | `"重庆狼队"` | 否 |
| `team_id` | string | 战队 ID（官方） | `"10001"` | 可能为空串 |
| `abbr` | string | 战队缩写 | `"狼队"`、`"LGD"` | **可空**（部分战队官方未给缩写） |
| `score` | int | 该场**大比分**（非本局击杀） | `1` | 否 |
| `win` | bool | 本局是否获胜 | `false` | 否；蓝红双方恰有一个 `true` |

### 3.3 `stats.blue` / `stats.red`

| 字段 | 类型 | 含义 | 示例 | 空值 / 备注 |
| --- | --- | --- | --- | --- |
| `kills` | int | 击杀数 | `7` | 整体 `stats.blue` / `stats.red` **可能为 `null`**（上游无该队统计） |
| `deaths` | int | 死亡数 | `13` | 同上 |
| `assists` | int | 助攻数 | `19` | 同上 |
| `gold` | int | 总经济 | `41013` | 同上 |
| `towers` | int | 推塔数 | `1` | 同上 |

### 3.4 `draft[]` 元素

按真实 BP 顺序排列（`n` 从 1 连续递增）。

| 字段 | 类型 | 含义 | 示例 | 空值 / 备注 |
| --- | --- | --- | --- | --- |
| `n` | int | 该局第几手（1 起） | `1` | 否 |
| `camp` | int | 阵营 | `1` | 否；`1`=蓝、`2`=红 |
| `action` | string | 动作类型 | `"ban"` | 否；`"ban"` / `"pick"` |
| `hero` | string | 英雄中文名 | `"关羽"` | 否；同一局内不重复 |
| `hid` | int | 英雄 ID | `140` | 可能为 `null`（上游缺 `hero_id`） |
| `pos` | int | 定位序号 | `0` | 可空；`ban` 恒为 `0`，`pick` 为官方定位序号（0 起） |

---

## 4. `data/battles.csv`

utf-8 带 BOM，宽表：一行一小局，**共 26 列，所有字段可由 `battles.jsonl` 复算**（校验脚本会逐字段比对）。列顺序：

| 列 | 类型 | 含义 | 示例 |
| --- | --- | --- | --- |
| `battle_id` | string | 小局 ID | `"1054884368_10_1791982621"` |
| `match_id` | string | 大场 ID | `"2026101402"` |
| `game_no` | int | 第几小局 | `3` |
| `league_id` | string | 赛事 ID | `"20260004"` |
| `league` | string | 赛事名 | `"2026年KPL年度总决赛"` |
| `year` | int | 年份 | `2026` |
| `league_type` | string | 赛事类型 | `"kpl"` |
| `date` | string | 日期 | `"2026-10-14"` |
| `stage` | string | 轮次 | `"擂台赛"` |
| `bo` | int | BO 数 | `5` |
| `blue_team` / `red_team` | string | 蓝/红战队名 | `"重庆狼队"` / `"杭州LGD.NBW"` |
| `match_score` | string | 大比分（蓝:红） | `"1:3"` |
| `winner_side` | string | 胜方 | `"red"` |
| `winner_team` | string | 胜队名 | `"杭州LGD.NBW"` |
| `win_camp` | int | 胜方阵营 | `2`（1=蓝、2=红） |
| `duration_sec` | int | 时长（秒） | `887` |
| `first_pick_side` | string | 首抢方 | `"blue"` |
| `bans` | int | 本局 ban 动作数 | `10`（残缺时更少） |
| `picks` | int | 本局 pick 动作数 | `10` |
| `complete` | int | **是否完整 BP**（`1`/`0`），等价于 `picks==10 && bans∈{8,10}` | `1` |
| `blue_bans` / `red_bans` | string | 蓝/红 ban 英雄，`;` 分隔 | `"关羽;钟馗;镜;墨子;哪吒"` |
| `blue_picks` / `red_picks` | string | 蓝/红 pick 英雄，`;` 分隔 | `"盾山;艾琳;曹操;王维;夏侯惇"` |
| `draft_order` | string | 完整顺序，`Bx`=蓝 ban、`Bp`=蓝 pick、`Rx`=红 ban、`Rp`=红 pick | `"Bx:关羽 > Rx:鲁班大师 > Bp:盾山 > ..."` |

> 空值：`blue_bans` 等在某方没有 ban/pick 时为空串。`complete` 在本文件中是 **`1`/`0` 整数**（`battles.jsonl` 里是布尔），过滤完整对局直接用 `complete = 1`；`bans` / `picks` 列也已展平，便于不加载 jsonl 时直接筛选。

---

## 5. `data/draft-actions.csv`

utf-8 带 BOM，长表：**一行一手 BP**，分析首选（可直接 `GROUP BY hero, action`）。

| 列 | 类型 | 含义 | 示例 | 空值 / 备注 |
| --- | --- | --- | --- | --- |
| `battle_id` | string | 小局 ID | `"1054884368_10_1791982621"` | 否 |
| `ord` | int | 该局第几手（1 起） | `1` | 否 |
| `camp` | int | 阵营 | `1` | 否 |
| `side` | string | 阵营字符串 | `"blue"` | 否 |
| `action` | string | 动作 | `"ban"` | 否 |
| `hero` | string | 英雄名 | `"关羽"` | 否 |
| `hero_id` | int | 英雄 ID | `140` | 可空 |
| `pos` | int | 定位序号 | `0` | 否（`ban` 为 0） |

> 行数恒等于 `battles.jsonl` 所有 `draft` 长度之和（含残缺对局的动作），校验脚本会比对。

---

## 6. `data/players.jsonl`

每行一局，记录选手-英雄对应（一行 10 条，个别对局少于 10 条）。

| 字段 | 类型 | 含义 | 示例 | 空值 / 备注 |
| --- | --- | --- | --- | --- |
| `battle_id` | string | 小局 ID | `"1054884368_10_1791982621"` | 否；主键 |
| `players` | array | `[side, hero, player, pos]` 四元组数组 | 见下 | 否；可为空数组 |
| `players[][0]` | string | 阵营 | `"red"` | 否 |
| `players[][1]` | string | 英雄名 | `"阿古朵"` | 否 |
| `players[][2]` | string | 选手 ID / 昵称 | `"断雨"` | **可能为空串**（官方未提供） |
| `players[][3]` | string | 位置描述（中文分路） | `"打野"`、`"发育路"`、`"游走"` | 可能为空串 |

```json
{"battle_id":"1054884368_10_1791982621",
 "players":[["red","阿古朵","断雨","打野"],["blue","盾山","信","游走"]]}
```

> `pos` 这里是**文字分路**（与 `draft[].pos` 的数字定位序号不是同一套编码）。

---

## 7. `data/heroes.json`

数组，一行一个英雄（按 `hero_id` 升序）。

| 字段 | 类型 | 含义 | 示例 | 空值 / 备注 |
| --- | --- | --- | --- | --- |
| `hero_id` | int | 英雄 ID | `140` | 否；唯一 |
| `hero` | string | 英雄名 | `"关羽"`、`"元流之子(辅助)"` | 否；唯一 |

> 覆盖所有在 `draft` / `draft-actions.csv` / `players.jsonl` 中出现过的英雄；同一 ID 与名称一一对应（校验脚本会检查冲突）。

---

## 8. `data/stats/summary.json`

单个对象。**所有比率类字段的分母是完整对局数**（`games_complete`）。

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `dataset` | string | `"KPL BP Dataset"` |
| `version` | string | 数据集版本，如 `"1.0.0"` |
| `generated_at` | string | 编译时间（ISO 8601，UTC） |
| `source` | object | `{name, endpoints[], page, rights}`，来源与权利声明 |
| `coverage` | object | 覆盖量，见下表 |
| `bp_len_distribution` | object | `{"20": 1488, "19": 6, ...}`：BP 长度 → 局数（**全部**对局） |
| `side_stats_all` | object | 全量阵营/首抢胜率，见 8.2 |
| `side_stats_by_year` | object | `{"2026": {...}, ...}`，同上结构 |
| `side_stats_by_league` | object | `{"20260004": {...}, ...}`，同上结构 |
| `top_ban` | array | Top 20：`[{hero, bans, ban_rate}]` |
| `top_pick` | array | Top 20：`[{hero, picks, win_rate}]` |

### 8.1 `coverage`

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `leagues` | int | 赛事数 |
| `years` | int[] | 年份列表（升序） |
| `matches` | int | 大场数 |
| `games` | int | 小局总数 |
| `games_with_bp` | int | 有 BP 的小局数（= `games_complete` + `games_partial`） |
| `games_complete` | int | 完整 BP 小局数（统计口径） |
| `games_partial` | int | 残缺 BP 小局数（仅保留，不计入比率） |
| `games_without_bp` | int | 无 BP 小局数（`draft` 为空，2019 年为主） |
| `games_with_20_actions` | int | BP 恰好 20 手的局数 |
| `heroes_seen` | int | 完整对局中出现过的英雄数 |
| `teams` | int | 出现过的战队数 |
| `ban_slots` | int | 完整对局的 ban 动作总数 |
| `pick_slots` | int | 完整对局的 pick 动作总数 |

### 8.2 `side_stats_*` 子对象

| 字段 | 类型 | 含义 | 示例 |
| --- | --- | --- | --- |
| `games` | int | 该组完整对局数 | `1488` |
| `blue_wins` | int | 蓝方胜场 | `788` |
| `red_wins` | int | 红方胜场 | `700` |
| `blue_win_rate` | number | 蓝方胜率（%） | `53.9` |
| `first_pick_side` | string | 该组更常见的首抢方 | `"blue"` |
| `first_pick_win_rate` | number | 首抢方胜率（%） | `54.2` |
| `avg_duration_min` | number | 平均时长（分钟） | `16.0`；无时长数据时 `null` |

---

## 9. `data/stats/hero-stats-*.json`

顶层是「分组 → 聚合」的映射：

| 文件 | 顶层键 | 说明 |
| --- | --- | --- |
| `hero-stats-all.json` | 仅 `"all"` | 全量 |
| `hero-stats-by-year.json` | `"2019"`、`"2020"`… | 按年份 |
| `hero-stats-by-league.json` | `"20190001"`… | 按赛事 ID |

每个分组：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `games` | int | 该组**完整**对局数（所有比率的分母） |
| `ban_slots` | int | 该组 ban 动作总数（`ban_share_of_slots` 的分母） |
| `pick_slots` | int | 该组 pick 动作总数 |
| `heroes` | array | 该组英雄列表，按 `picks + bans` 降序 |

`heroes[]` 元素：

| 字段 | 类型 | 含义 | 空值 |
| --- | --- | --- | --- |
| `hero` | string | 英雄名 | 否 |
| `picks` | int | 被选次数 | 否 |
| `bans` | int | 被禁次数 | 否 |
| `wins` | int | 被选时的胜场 | 否 |
| `losses` | int | 被选时的负场 | 否 |
| `win_rate` | number | 胜率（%）= wins/(wins+losses) | 可空（无 pick） |
| `pick_rate` | number | pick 率（%）= picks/games | 可空（`games=0`） |
| `ban_rate` | number | ban 率（%）= bans/games，**每局被 ban 的概率** | 可空 |
| `ban_share_of_slots` | number | 该英雄 ban 数 / 全部 ban 位（%） | 可空 |
| `presence` | number | 出场+禁用率（%）= (picks+bans)/games | 可空 |
| `main_pos` | int | 最主要的定位序号 | 可空（无 pick） |

---

## 10. `data/stats/team-stats.json`

数组，一行一支战队。覆盖**全部**小局（含残缺/无 BP，因为战队战绩与 BP 无关）。

| 字段 | 类型 | 含义 | 示例 |
| --- | --- | --- | --- |
| `team` | string | 战队名 | `"重庆狼队"` |
| `games` | int | 出场小局数 | `42` |
| `wins` | int | 小局胜场 | `25` |
| `losses` | int | 小局负场 | `17` |
| `win_rate` | number | 小局胜率（%） | `59.5` |
| `leagues` | int | 参与过的赛事数（去重） | `3` |

> 一致性：所有 `games` 之和 = 小局总数 × 2；`wins` 之和 = 小局总数。校验脚本会检查。

---

## 11. `data/provenance/source-leagues.json`

数组，赛事原始元数据快照（未经过计数加工，用于复现核对）。

| 字段 | 类型 | 含义 | 示例 |
| --- | --- | --- | --- |
| `league_id` | string | 赛事 ID | `"20190001"` |
| `league_name` | string | 赛事名 | `"2019KPL春季赛"` |
| `league_type_name` | string | 官方类型名 | `"kpl"` |
| `year` | int | 年份 | `2019` |
| `season` | int | 赛季序号 | `1` |
| `start_time` | string | 开赛时间 | `"2019-03-06 00:00:00"` |
| `end_time` | string | 结束时间 | `"2019-06-02 23:59:00"` |
| `status` | int | 官方赛事状态（`2` = 已结束） | `2` |

---

## 12. 缺失与异常速查

| 现象 | 出现在 | 处理方式 |
| --- | --- | --- |
| `draft: []` | 2019 年部分对局 | 正常保留（官方无 BP），`complete: false` |
| `draft` 长度 5/6/7/9/19 | 个别赛事 | 上游缺项，保留并标 `complete: false`，不参与比率统计 |
| `stats.blue` / `stats.red` 为 `null` | 个别对局 | 原始数据无该队统计 |
| `duration_sec` 为 `null` | 个别对局 | 上游无 `game_duration` |
| `first_pick_side` 为 `null` | 无 pick 的对局 | 无法推导 |
| `red.abbr` / `blue.abbr` 为空串 | 个别战队 | 官方未提供缩写 |
| `players[][2]`（选手名）为空串 | 个别记录 | 官方缺失，不猜测 |
| `venue` 为空串 | 个别大场 | 官方无场地信息 |
| 同一局英雄重复 | **不应出现** | 校验脚本判失败 |
| `battle_id` 重复 | **不应出现** | 校验脚本判失败 |
