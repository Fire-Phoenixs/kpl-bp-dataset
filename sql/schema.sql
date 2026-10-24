-- KPL BP Dataset —— SQLite / PostgreSQL 建表语句
-- 载入方式见 scripts/load-sqlite.mjs；CSV 带 UTF-8 BOM，可直接用 Excel 打开。

CREATE TABLE leagues (
  league_id     TEXT PRIMARY KEY,
  league_name   TEXT NOT NULL,
  league_type   TEXT,
  year          INTEGER,
  season        INTEGER,
  start_time    TEXT,
  end_time      TEXT,
  matches       INTEGER,
  games         INTEGER,
  games_with_bp INTEGER,
  games_complete INTEGER
);

CREATE TABLE matches (
  match_id   TEXT PRIMARY KEY,
  league_id  TEXT REFERENCES leagues(league_id),
  league     TEXT,
  year       INTEGER,
  date       TEXT,
  stage      TEXT,          -- 轮次/阶段中文名，如 常规赛、季后赛、擂台赛
  bo         INTEGER,
  venue      TEXT,
  team1      TEXT,
  score1     INTEGER,
  team2      TEXT,
  score2     INTEGER,
  winner     TEXT,
  games      INTEGER
);

CREATE TABLE battles (
  battle_id       TEXT PRIMARY KEY,
  match_id        TEXT REFERENCES matches(match_id),
  game_no         INTEGER,      -- BO 赛制中的第几小局
  league_id       TEXT,
  league          TEXT,
  year            INTEGER,
  league_type     TEXT,
  date            TEXT,
  stage           TEXT,
  bo              INTEGER,
  blue_team       TEXT,
  red_team        TEXT,
  match_score     TEXT,         -- 大比分，如 3:0
  winner_side     TEXT,         -- blue / red
  winner_team     TEXT,
  win_camp        INTEGER,      -- 1=蓝方胜 2=红方胜（官方接口原始字段）
  duration_sec    INTEGER,
  first_pick_side TEXT,         -- 第一手选人的阵营
  bans            INTEGER,      -- 本局禁用动作数（常规 8 或 10）
  picks           INTEGER,      -- 本局选人动作数（完整为 10）
  complete        INTEGER,      -- 1=BP 完整（统计口径），0=残缺/缺失
  blue_bans       TEXT,         -- 分号分隔的 5 个英雄
  red_bans        TEXT,
  blue_picks      TEXT,
  red_picks       TEXT,
  draft_order     TEXT          -- 完整 BP 顺序，如 Bx:沈梦溪 > Rx:鲁班大师 > ...
);

-- 长表：一行一个 BP 动作（bans + picks，含顺序），适合 GROUP BY / 关联分析
CREATE TABLE draft_actions (
  battle_id TEXT REFERENCES battles(battle_id),
  ord       INTEGER,   -- 该局第几个动作（1 起）
  camp      INTEGER,   -- 1=蓝方 2=红方
  side      TEXT,      -- blue / red
  action    TEXT,      -- ban / pick
  hero      TEXT,
  hero_id   INTEGER,
  pos       INTEGER    -- 该英雄的定位序号（仅 pick 有值）
);

-- 选手-英雄对应（每局 10 行；players.jsonl）
CREATE TABLE battle_players (
  battle_id TEXT REFERENCES battles(battle_id),
  side      TEXT,
  hero      TEXT,
  player    TEXT,
  pos       TEXT       -- 位置描述，如 游走 / 打野
);
