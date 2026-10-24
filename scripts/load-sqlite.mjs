#!/usr/bin/env node
/**
 * load-sqlite —— 把数据集载入一个 SQLite 文件（零依赖：用 Node ≥22.5 内置 node:sqlite）
 *
 * 用法：
 *   node scripts/load-sqlite.mjs                     # 生成 kpl-bp.sqlite
 *   node scripts/load-sqlite.mjs --out kpl.sqlite    # 自定义输出
 *   node scripts/load-sqlite.mjs --data-dir data     # 数据集目录（默认脚本上一级的 data）
 *
 * 载入后可直接查询，例如：
 *   sqlite> SELECT hero, bans, ROUND(ban_rate,1) FROM (SELECT hero, COUNT(*) bans FROM draft_actions WHERE action='ban' GROUP BY hero) ...
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const DATA = path.resolve(process.cwd(), opt('--data-dir', 'data'));
const OUT = path.resolve(process.cwd(), opt('--out', 'kpl-bp.sqlite'));
const SCHEMA = path.resolve(REPO, 'sql/schema.sql');
fs.mkdirSync(path.dirname(OUT), { recursive: true });

if (fs.existsSync(OUT)) fs.unlinkSync(OUT);
const db = new DatabaseSync(OUT);

// 1) 建表
db.exec(fs.readFileSync(SCHEMA, 'utf8'));

// 2) CSV 读取（数据文件带 UTF-8 BOM）
function readCsv(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.length);
  const header = parseLine(lines[0]);
  return lines.slice(1).map((l) => {
    const cells = parseLine(l);
    const row = {};
    header.forEach((h, i) => { row[h] = cells[i] ?? ''; });
    return row;
  });
}
function parseLine(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
const readJsonl = (f) => fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

const insert = (table, cols) => db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
const run = (stmt, rows, pick) => { db.exec('BEGIN'); try { for (const r of rows) stmt.run(...pick(r)); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } };

const leagues = JSON.parse(fs.readFileSync(path.join(DATA, 'leagues.json'), 'utf8'));
db.exec('BEGIN');
const st = insert('leagues', ['league_id', 'league_name', 'league_type', 'year', 'season', 'start_time', 'end_time', 'matches', 'games', 'games_with_bp', 'games_complete']);
for (const l of leagues) st.run(l.league_id, l.league_name, l.league_type, l.year, l.season, l.start_time, l.end_time, l.matches, l.games, l.games_with_bp, l.games_complete ?? null);
db.exec('COMMIT');

run(insert('matches', ['match_id', 'league_id', 'league', 'year', 'date', 'stage', 'bo', 'venue', 'team1', 'score1', 'team2', 'score2', 'winner', 'games']),
  readCsv(path.join(DATA, 'matches.csv')),
  (r) => [r.match_id, r.league_id, r.league, num(r.year), r.date, r.stage, num(r.bo), r.venue, r.team1, num(r.score1), r.team2, num(r.score2), r.winner, num(r.games)]);

run(insert('battles', ['battle_id', 'match_id', 'game_no', 'league_id', 'league', 'year', 'league_type', 'date', 'stage', 'bo', 'blue_team', 'red_team', 'match_score', 'winner_side', 'winner_team', 'win_camp', 'duration_sec', 'first_pick_side', 'bans', 'picks', 'complete', 'blue_bans', 'red_bans', 'blue_picks', 'red_picks', 'draft_order']),
  readCsv(path.join(DATA, 'battles.csv')),
  (r) => [r.battle_id, r.match_id, num(r.game_no), r.league_id, r.league, num(r.year), r.league_type, r.date, r.stage, num(r.bo), r.blue_team, r.red_team, r.match_score, r.winner_side, r.winner_team, num(r.win_camp), num(r.duration_sec), r.first_pick_side, num(r.bans), num(r.picks), num(r.complete), r.blue_bans, r.red_bans, r.blue_picks, r.red_picks, r.draft_order]);

run(insert('draft_actions', ['battle_id', 'ord', 'camp', 'side', 'action', 'hero', 'hero_id', 'pos']),
  readCsv(path.join(DATA, 'draft-actions.csv')),
  (r) => [r.battle_id, num(r.ord), num(r.camp), r.side, r.action, r.hero, num(r.hero_id), num(r.pos)]);

const playerRows = [];
for (const row of readJsonl(path.join(DATA, 'players.jsonl'))) {
  for (const [side, hero, player, pos] of row.players) playerRows.push([row.battle_id, side, hero, player, pos]);
}
run(insert('battle_players', ['battle_id', 'side', 'hero', 'player', 'pos']), playerRows, (r) => r);

db.exec(`
CREATE INDEX idx_battles_league ON battles(league_id);
CREATE INDEX idx_battles_match ON battles(match_id);
CREATE INDEX idx_draft_hero ON draft_actions(hero);
CREATE INDEX idx_draft_action ON draft_actions(action);
CREATE INDEX idx_draft_battle ON draft_actions(battle_id);
CREATE INDEX idx_players_hero ON battle_players(hero);
`);

const count = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
console.log(`已生成 ${OUT}`);
for (const t of ['leagues', 'matches', 'battles', 'draft_actions', 'battle_players']) {
  console.log(`  ${t.padEnd(14)} ${count(t)} 行`);
}
db.close();
