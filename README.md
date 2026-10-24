# KPL BP Dataset — 王者荣耀职业赛事 BP 数据集

> **一句话定位**：把王者荣耀职业赛事（KPL 春季赛/夏季赛/年度总决赛、世界冠军杯、冬季冠军杯、挑战者杯）**逐局的 Ban/Pick（BP）过程**，从腾讯官方赛事数据接口整理成可直接分析的 JSON / CSV / SQLite 数据集——面向复盘、统计研究与工具开发，**非官方、非商业**。

> **数据来源必须先读**：全部 BP 记录来自腾讯官方赛事数据域 `prod.comp.smoba.qq.com`，即 KPL 赛事数据中心页面（`pvp.qq.com/matchdata/`）自身调用的同一套接口。**这是非官方数据**：赛事与对局数据的**著作权归腾讯 / 王者荣耀赛事方所有**，本仓库只是对公开数据的整理与结构化，不主张数据本身的版权。转载、引用或二次分发请**注明数据来源与本仓库链接**（<https://github.com/Fire-Phoenixs/kpl-bp-dataset>），并遵守 [LICENSE](LICENSE) 的非商业条款。详见 [docs/source.md](docs/source.md) 与 [NOTICE](NOTICE)。

- 结构化产物：每局一条 `battles.jsonl` + 每手 BP 一条 `draft-actions.csv` + 宽表 `battles.csv`，三种粒度互相可复算
- 统计产物：英雄 ban/pick/胜率（全量 / 按年 / 按赛事）、战队战绩、蓝红方与首抢方胜率、BP 长度分布
- 可复现：采集脚本 + 编译脚本 + 零依赖校验脚本 + GitHub Actions 自动校验

---

## 1. 数据范围与体量

赛事覆盖：**33 个赛事**，跨 **2019–2026** 年，含 KPL 春季赛、秋季赛、夏季赛、年度总决赛、挑战者杯、世界冠军杯、冬季冠军杯。
采集任务登记的对局总数为 **11,141 局**（来源：采集脚本的 `data/raw/crawl-status.json`）。**实际入库数量以 `data/stats/summary.json` 为准**——下列数字由维护者在发布前用该文件回填：

<!--COVERAGE-->
<!-- 本区块由 tools/build-kpl-db.mjs 自动生成，勿手改 -->

| 指标 | 数值 |
| --- | --- |
| 赛事数 | 33 |
| 年份跨度 | 2019–2026 |
| 大场（matches） | 2887 |
| 小局（games） | 11141 |
| 含 BP 的对局 | 9881 |
| 完整 BP 对局（计入统计） | 9817 |
| 残缺 BP 对局（仅保留、不参与比率） | 64 |
| 无 BP 对局（2019 年为主） | 1260 |
| 出现过的英雄 | 133 |
| 战队 | 83 |
| BP 动作总数 | 85442 ban + 98170 pick |

<!--/COVERAGE-->

> 口径提示：`games_with_bp` 含残缺对局；**所有比率类统计（ban 率、pick 率、胜率、蓝方胜率）只按「完整 BP 对局」计算**——完整 = 双方各 5 手选人（合计 10 手 pick）且禁用位为 8 或 10（即 `picks == 10 && bans ∈ {8, 10}`）。逐局标志见 `data/battles.jsonl` 的 `complete` 字段（布尔）与 `data/battles.csv` 的 `complete` 列（`1`/`0`）。

**已知覆盖边界**：2019 年部分对局的官方接口 `bp_list` 返回空数组（队伍、选手、经济数据仍在），因此 **BP 覆盖以 2020 年起为主**；个别赛事还有少量「残缺 BP」（如只返回 5 手选人、或只有 9 个禁用位），已在数据中打 `complete: false` 标记，不做静默删除。

## 2. 来源与致谢

| 项 | 内容 |
| --- | --- |
| 数据页面 | <https://pvp.qq.com/matchdata/schedule.html?league_id={league_id}>（JS 渲染，页面自身调用的就是下列接口） |
| 赛事列表 | <https://prod.comp.smoba.qq.com/leaguesite/leagues/open> |
| 赛程 / 场次 | <https://prod.comp.smoba.qq.com/leaguesite/matches/open?league_id={league_id}> |
| 单局详情（含 `bp_list`） | <https://prod.comp.smoba.qq.com/leaguesite/battle/open?battle_id={battle_id}> |
| 数据权利 | 赛事与对局数据著作权归 **腾讯 / 王者荣耀赛事方** 所有 |

**采集合规口径**（完整说明见 [docs/source.md](docs/source.md)）：

- 只取**公开赛事数据**：禁用/选择英雄、胜负、比赛时长、战队与选手的公开赛果统计；不登录、不携带 Cookie、不取任何账号或个人信息
- **严格串行、单并发**，每局间隔 300 ms（实测约 2.5 请求/秒），失败重试 3 次，支持断点续跑
- 全量约 11,141 次单局请求，耗时约 75 分钟；不绕过任何反爬措施，不使用代理池
- 相关 `robots.txt` 均已核实：`pvp.qq.com/robots.txt` → 404（无规则）；`www.qq.com/robots.txt` → `User-agent: *` / `Disallow:`（即不禁止）；采集接口域 `prod.comp.smoba.qq.com/robots.txt` → 404（2026-10-24 实测 1 次请求）

致谢：腾讯赛事数据团队提供的公开赛事数据；KPL 各战队与选手的公开比赛记录。

## 3. 目录结构

```text
kpl-bp-dataset/
├─ README.md                  # 本文件
├─ LICENSE                    # 整理结构 / 元数据 / 脚本的许可（CC BY-NC 4.0 + 数据事实不主张版权）
├─ NOTICE                     # 来源、采集日期、免责与非商业声明
├─ data/
│  ├─ leagues.json            # 赛事索引（含 matches / games / games_with_bp / games_complete）
│  ├─ matches.csv             # 大场（BO 系列赛）表
│  ├─ battles.jsonl           # 核心：每行一局，含完整 draft 顺序、双方战队、经济
│  ├─ battles.csv             # 宽表：一行一局，ban/pick 以分号拼接
│  ├─ draft-actions.csv       # 长表：一行一手 BP（分析首选）
│  ├─ players.jsonl           # 选手-英雄对应（每局 10 条）
│  ├─ heroes.json             # hero_id ↔ 英雄名映射
│  ├─ stats/
│  │  ├─ summary.json         # 覆盖量、BP 长度分布、蓝红方/首抢方胜率、英雄榜
│  │  ├─ hero-stats-all.json  # 英雄 BP 与胜率（全量）
│  │  ├─ hero-stats-by-year.json
│  │  ├─ hero-stats-by-league.json
│  │  └─ team-stats.json      # 战队战绩
│  └─ provenance/
│     └─ source-leagues.json  # 赛事原始元数据快照（复现核对用）
├─ docs/
│  ├─ source.md               # 数据来源、接口、robots 核实、合规与使用边界
│  ├─ fields.md               # 完整字段字典（每个文件每个字段）
│  └─ stats.md                # 统计速览（由 build-kpl-db.mjs 自动生成，勿手改）
├─ scripts/
│  ├─ collect-kpl-bp-all.mjs  # 串行采集（断点续跑）
│  ├─ build-kpl-db.mjs        # 由 data/raw 编译出 data/
│  ├─ load-sqlite.mjs         # 一键载入 SQLite（Node ≥ 22.5 内置 node:sqlite）
│  └─ validate-dataset.mjs    # 零依赖完整性校验（CI 同款）
├─ sql/
│  └─ schema.sql              # SQLite / PostgreSQL 建表
├─ .github/workflows/
│  └─ validate.yml            # push / PR 自动跑校验
└─ .gitignore
```

## 4. 字段速查

完整类型、取值与空值说明见 [docs/fields.md](docs/fields.md)。

**`data/battles.jsonl`（一行一局，分析主表）**

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `battle_id` | string | 小局唯一 ID（官方） |
| `match_id` | string | 所属大场 ID |
| `game_no` | int | BO 赛制中的第几小局 |
| `league_id` / `league` | string | 赛事 ID / 赛事名 |
| `year` / `league_type` / `date` / `stage` / `bo` | mixed | 年份、赛事类型、日期（`YYYY-MM-DD`）、轮次中文名、BO 数 |
| `blue` / `red` | object | `{team, team_id, abbr, score, win}`，`score` 为大比分 |
| `winner_side` | `"blue"` / `"red"` | 胜方阵营 |
| `duration_sec` | int | 比赛时长（秒） |
| `stats.blue` / `stats.red` | object | `{kills, deaths, assists, gold, towers}` |
| `first_pick_side` | `"blue"` / `"red"` / null | 第一手选人的阵营 |
| `bans` | int | 本局禁用动作数（8 或 10 为常规，残缺时更少） |
| `picks` | int | 本局选人动作数（完整对局为 10） |
| `complete` | bool | **是否完整 BP**：`picks == 10 && bans ∈ {8,10}`，统计口径据此筛选 |
| `draft` | array | `[{n, camp(1 蓝/2 红), action("ban"/"pick"), hero, hid, pos}]`，按实际 BP 顺序 |

**`data/draft-actions.csv`（一行一手 BP，长表）**

`battle_id, ord, camp, side, action, hero, hero_id, pos`：`ord` 为该局第几手（1 起），`camp` 1=蓝 2=红，`action` `ban`/`pick`，`pos` 为该英雄定位序号（ban 为 0）。适合直接 `GROUP BY hero, action`。

**其它文件**

| 文件 | 粒度 | 关键字段 |
| --- | --- | --- |
| `data/leagues.json` | 一行一赛事 | `league_id, league_name, league_type, year, season, start_time, end_time, matches, games, games_with_bp, games_complete` |
| `data/matches.csv` | 一行一大场 | `match_id, league_id, league, year, date, stage, bo, venue, team1, score1, team2, score2, winner, games` |
| `data/battles.csv` | 一行一小局（宽表，**26 列**） | 在 `battles.jsonl` 基础上展平：`bans` / `picks` / `complete`（`1`/`0`）、`blue_bans / red_bans / blue_picks / red_picks`（分号分隔）、`draft_order`（`Bx:英雄 > Rp:英雄 > ...`）、`win_camp`（1/2） |
| `data/players.jsonl` | 一行一局 | `{battle_id, players: [[side, hero, player, pos], ...]}` |
| `data/heroes.json` | 一行一英雄 | `{hero_id, hero}` |
| `data/stats/summary.json` | 单对象 | `coverage`（见上表）、`bp_len_distribution`、`side_stats_all/by_year/by_league`、`top_ban`、`top_pick`、`source` |
| `data/stats/hero-stats-*.json` | `{all|年份|league_id: {...}}` | 每组 `games, ban_slots, pick_slots, heroes[{hero, picks, bans, wins, losses, win_rate, pick_rate, ban_rate, ban_share_of_slots, presence, main_pos}]` |
| `data/stats/team-stats.json` | 数组 | `[{team, games, wins, losses, win_rate, leagues}]` |
| `data/provenance/source-leagues.json` | 数组 | 赛事原始元数据快照（含 `status`） |

> `ban_rate` / `pick_rate` / `presence` 的分母是**该组的完整对局数**（`games`），不是禁用位总数；`ban_share_of_slots` 才是「占全部禁用位的比例」。

## 5. 快速开始

以下示例都假设在仓库根目录执行：

```bash
git clone https://github.com/Fire-Phoenixs/kpl-bp-dataset.git
cd kpl-bp-dataset
```

> 需要现成的汇总表格（总览、逐年、逐赛事完整率、英雄 BP 榜 Top 30）而不想自己算时，直接看 [docs/stats.md](docs/stats.md)——它由 `scripts/build-kpl-db.mjs` 自动生成，数字与 `data/stats/*.json` 同源。

### 5.1 用 jq 查某英雄的 ban 率

```bash
# 单个英雄：ban 次数 / ban 率（每局被 ban 的概率）/ pick 次数 / 胜率
jq -r '.all.heroes[] | select(.hero=="鲁班大师")
       | "\(.hero)：ban \(.bans) 次（\(.ban_rate)%），pick \(.picks) 次（\(.pick_rate)%），胜率 \(.win_rate)%"' \
   data/stats/hero-stats-all.json

# 全量 ban 率 Top 10
jq -r '.all.heroes | sort_by(-.bans) | .[:10][]
       | "\(.hero)\t\(.bans)\t\(.ban_rate)%\t\(.presence)%"' data/stats/hero-stats-all.json
```

### 5.2 用 pandas 读 `battles.csv` 统计蓝方胜率

```python
import pandas as pd

b = pd.read_csv('data/battles.csv', encoding='utf-8-sig')  # 文件带 BOM，必须用 utf-8-sig
full = b[b.complete == 1]                                  # complete=1 即 picks==10 且 bans∈{8,10}

print(f"总局数 {len(b)}，完整 BP {len(full)} 局")
print(f"蓝方胜率 {100 * (full.winner_side == 'blue').mean():.1f}%")
print(f"首抢方胜率 {100 * (full.first_pick_side == full.winner_side).mean():.1f}%")
print(full.groupby('year').apply(lambda d: round(100 * (d.winner_side == 'blue').mean(), 1)))
```

> `bans` / `picks` / `complete` 已在 `battles.csv` 中展平（`complete` 取 `1`/`0`，等价于 `picks == 10 && bans ∈ {8,10}`）；`battles.jsonl` 里 `complete` 是布尔值，两个文件可交叉验证。

### 5.3 载入 SQLite 后用 SQL 查某赛事的 BP

```bash
node scripts/load-sqlite.mjs --data-dir data --out kpl-bp.sqlite
# 输出各表行数：leagues / matches / battles / draft_actions / battle_players
```

```sql
-- 2026 年 KPL 年度总决赛（league_id=20260004）被 ban 最多的英雄
SELECT hero, COUNT(*) AS bans
FROM draft_actions
WHERE action = 'ban' AND league_id = '20260004'
GROUP BY hero
ORDER BY bans DESC
LIMIT 10;

-- 某英雄在各赛事的 ban 率（分母 = 该赛事「完整 BP」对局数：picks=10 且 bans∈{8,10}）
SELECT a.league_id,
       COUNT(*) AS bans,
       (SELECT COUNT(*) FROM battles b
         WHERE b.league_id = a.league_id AND b.complete = 1) AS games,
       ROUND(100.0 * COUNT(*)
             / NULLIF((SELECT COUNT(*) FROM battles b
                        WHERE b.league_id = a.league_id AND b.complete = 1), 0), 1) AS ban_rate_pct
FROM draft_actions a
WHERE a.action = 'ban' AND a.hero = '鲁班大师'
GROUP BY a.league_id
ORDER BY ban_rate_pct DESC;
```

> `battles` 表已含 `bans` / `picks` / `complete`（`1`/`0`），直接 `WHERE complete = 1` 即可。若手上只有 `draft_actions`（没有 `battles` 表），也可以按 `battle_id` 聚合出同样口径：`GROUP BY battle_id HAVING SUM(action='pick') = 10 AND SUM(action='ban') IN (8,10)`。

> 没有 `sqlite3` 命令行也能查：`node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('kpl-bp.sqlite');console.log(db.prepare('SELECT hero,COUNT(*) n FROM draft_actions WHERE action=\'ban\' GROUP BY hero ORDER BY n DESC LIMIT 5').all())"`

### 5.4 按年份比较英雄 BP 率

```bash
# 鲁班大师逐年 ban 率（数据来自 hero-stats-by-year.json，分母是该年完整对局数）
jq -r 'to_entries[] | .key as $y | .value.heroes[]
       | select(.hero=="鲁班大师")
       | "\($y)\t\(.bans) 次\t\(.ban_rate)%"' data/stats/hero-stats-by-year.json
```

```python
# 不依赖 pandas：直接读编译好的按年统计（分母 = 该年完整对局数）
import json

by_year = json.load(open('data/stats/hero-stats-by-year.json', encoding='utf-8'))
for year in sorted(by_year):
    agg = by_year[year]
    hit = next((h for h in agg['heroes'] if h['hero'] == '鲁班大师'), None)
    if hit:
        print(f"{year}: {hit['bans']} ban / {agg['games']} 局 = {hit['ban_rate']}%")
```

## 6. 统计口径与已知限制

| 项 | 口径 / 限制 |
| --- | --- |
| 完整对局 | `picks == 10 && bans ∈ {8, 10}`（双方各 5 手 pick；禁用位每方 4 或 5 个）；只有完整对局参与 ban/pick/胜率统计（`complete: true`，`battles.csv` 中为 `complete = 1`） |
| 残缺对局 | 上游 `bp_list` 只返回部分动作（例：5/6/7 手、9 个 ban、19 手）；数据保留并标 `complete: false`，不作静默删除或补全 |
| 无 BP 对局 | 2019 年部分赛事 `bp_list` 为空数组（`draft: []`），队伍/选手/经济数据仍保留 |
| 阵营 | `camp=1` 为蓝方、`camp=2` 为红方；`win_camp` 与 `winner_side` 同义（1/2 与 blue/red） |
| 大比分 | `blue.score` / `red.score` 取官方大场比分（同一大场内每局相同），不是本局击杀 |
| 顺序 | 极少数对局在两次采集间 `bp_list` 顺序有微调，英雄集合一致；本数据集以最新一次采集为准 |
| 缺失 | `first_pick_side`、`duration_sec`、部分经济字段在个别对局可能为 `null`，分析前请过滤 |
| 非因果 | 数据只反映「职业赛场实际发生了什么」，不能直接当排位环境的强度结论；版本、教练意图、针对性 ban 都会影响分布 |

## 7. 版本与更新方式

- 版本号：`data/stats/summary.json` 的 `version`（当前 `1.0.0`），`generated_at` 为编译时间
- 更新节奏：不承诺固定周期；KPL 新赛季结束后可按下列步骤重跑

```bash
# 1) 增量采集（已采过的 battle_id 自动跳过，可断点续跑；串行 300ms）
node scripts/collect-kpl-bp-all.mjs

# 2) 重新编译数据集（在仓库根执行，--out . 表示输出到当前目录）
node scripts/build-kpl-db.mjs --out .

# 3) 完整性校验（CI 同款，退出码非 0 即失败）
node scripts/validate-dataset.mjs
```

- 提交前建议：`node scripts/validate-dataset.mjs --data-dir data --strict-len`（把非标准 BP 长度也视为失败）
- 采集产物 `data/raw/` 与 `*.sqlite` 已在 `.gitignore` 中忽略，不进入版本库

## 8. 许可、免责与非商业声明

- **数据**：赛事与对局数据的著作权归 **腾讯 / 王者荣耀赛事方** 所有。本仓库整理者**不主张对数据事实部分的著作权**。
- **整理结构 / 元数据 / 脚本**：按 **CC BY-NC 4.0**（署名—非商业性使用 4.0 国际）授权，见 [LICENSE](LICENSE)。在权利人允许的范围内使用；如与本仓库许可冲突，以权利人要求为准。
- **非官方**：本项目与腾讯、天美工作室群、KPL 官方无隶属或授权关系，不得以「官方数据」「官方合作」名义传播。
- **非商业**：不得将本数据集或其衍生数据用于商业目的（含付费产品、商业模型训练数据集售卖、广告变现等）。
- **免责**：数据按「现状」提供，不保证完整性、准确性或时效性；因使用本数据产生的任何后果由使用者自行承担。
- **下架**：如权利人认为本仓库内容不妥，请通过 Issue 联系，我们会立即删除相关内容。

## 9. 引用

```bibtex
@misc{kpl_bp_dataset,
  title  = {KPL BP Dataset: 王者荣耀职业赛事逐局 Ban/Pick 数据集},
  author = {kpl-bp-dataset contributors},
  year   = {2026},
  note   = {非官方整理，数据著作权归腾讯/王者荣耀赛事方；仅限研究与开发用途},
  url    = {https://github.com/Fire-Phoenixs/kpl-bp-dataset}
}
```
