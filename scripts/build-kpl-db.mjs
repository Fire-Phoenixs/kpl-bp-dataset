#!/usr/bin/env node
/**
 * build-kpl-db —— 把 data/raw 的采集结果编译成可发布的 KPL BP 数据集（kpl-bp-dataset/）
 *
 * 输入：
 *   data/raw/leagues.json         腾讯官方赛事接口返回的赛事列表
 *   data/raw/battles.jsonl        采集脚本逐局追加的原始行
 *   data/raw/matches/<league>.json 赛程缓存
 * 输出（仓库目录）：
 *   data/leagues.json  data/matches.csv  data/battles.jsonl  data/battles.csv
 *   data/draft-actions.csv  data/heroes.json
 *   data/stats/{summary,hero-stats-all,hero-stats-by-year,hero-stats-by-league,team-stats}.json
 *   docs/{fields,source}.md  scripts/*  sql/schema.sql
 *
 * 用法：node tools/build-kpl-db.mjs [--out kpl-bp-dataset] [--min-bp 20] [--quiet]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);

const RAW = path.join(ROOT, 'data/raw');
const OUT = path.join(ROOT, opt('--out', 'kpl-bp-dataset'));
const QUIET = has('--quiet');

const log = (...a) => { if (!QUIET) console.log(...a); };
const BOM = '\uFEFF';
const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvLine = (arr) => arr.map(csvCell).join(',');
const sideName = (camp) => (Number(camp) === 1 ? 'blue' : 'red');

/* ---------- 读取原始数据 ---------- */
if (!fs.existsSync(path.join(RAW, 'battles.jsonl'))) {
  console.error('缺少 data/raw/battles.jsonl，先运行 tools/collect-kpl-bp-all.mjs');
  process.exit(1);
}
const leagueDoc = JSON.parse(fs.readFileSync(path.join(RAW, 'leagues.json'), 'utf8'));
const leagueMeta = new Map((leagueDoc.results || []).map((l) => [String(l.league_id), l]));

const rows = [];
let bad = 0;
for (const line of fs.readFileSync(path.join(RAW, 'battles.jsonl'), 'utf8').split('\n')) {
  if (!line.trim()) continue;
  try { rows.push(JSON.parse(line)); } catch { bad++; }
}
log(`读取原始对局 ${rows.length} 行（解析失败 ${bad}）`);

/* 去重：同一 battle_id 只保留一条 */
const byId = new Map();
for (const r of rows) if (!byId.has(r.battle_id)) byId.set(r.battle_id, r);
const battles = [...byId.values()].sort((a, b) => String(a.battle_id).localeCompare(String(b.battle_id)));

/* ---------- 工具 ---------- */
function draftOf(b) {
  return (b.bp || [])
    .filter((x) => x && x.hero)
    .map((x, i) => ({ n: i + 1, camp: Number(x.camp), action: x.action, hero: x.hero, hid: x.heroId, pos: x.position ?? null }));
}
const sidesOf = (draft) => ({
  blue: {
    bans: draft.filter((x) => x.camp === 1 && x.action === 'ban').map((x) => x.hero),
    picks: draft.filter((x) => x.camp === 1 && x.action === 'pick').map((x) => x.hero),
  },
  red: {
    bans: draft.filter((x) => x.camp === 2 && x.action === 'ban').map((x) => x.hero),
    picks: draft.filter((x) => x.camp === 2 && x.action === 'pick').map((x) => x.hero),
  },
});

/* ---------- 1. 赛事索引 ---------- */
const leagueAgg = new Map();
for (const lg of leagueDoc.results || []) leagueAgg.set(String(lg.league_id), { games: 0, withBp: 0, complete: 0, matches: new Set() });
for (const b of battles) {
  const k = String(b.league.id);
  if (!leagueAgg.has(k)) leagueAgg.set(k, { games: 0, withBp: 0, complete: 0, matches: new Set() });
  const a = leagueAgg.get(k);
  a.games++;
  const bp = (b.bp || []).filter((x) => x && x.hero);
  if (bp.length) a.withBp++;
  const picks = bp.filter((x) => x.action === 'pick').length;
  const bans = bp.filter((x) => x.action === 'ban').length;
  if (picks === 10 && (bans === 8 || bans === 10)) a.complete++;
  a.matches.add(b.match.id);
}
const leaguesOut = [...leagueAgg.entries()].map(([id, a]) => {
  const m = leagueMeta.get(id) || {};
  return {
    league_id: id,
    league_name: m.league_name || '',
    league_type: m.league_type_name || '',
    year: m.year ?? null,
    season: m.season ?? null,
    start_time: m.start_time || '',
    end_time: m.end_time || '',
    matches: a.matches.size,
    games: a.games,
    games_with_bp: a.withBp,
    games_complete: a.complete,
  };
}).sort((x, y) => String(x.league_id).localeCompare(String(y.league_id)));

/* ---------- 2. battles.jsonl（精简） ---------- */
const slimRows = battles.map((b) => {
  const draft = draftOf(b);
  const s = sidesOf(draft);
  const firstPick = draft.find((x) => x.action === 'pick');
  const banCount = draft.filter((x) => x.action === 'ban').length;
  const pickCount = draft.filter((x) => x.action === 'pick').length;
  const complete = pickCount === 10 && (banCount === 8 || banCount === 10);
  const blue = b.match.team1 || {};
  const red = b.match.team2 || {};
  const row = {
    battle_id: b.battle_id,
    match_id: b.match.id,
    game_no: b.battle_seq,
    league_id: String(b.league.id),
    league: b.league.name,
    year: b.league.year,
    league_type: b.league.type,
    date: b.match.date,
    stage: b.match.stage_desc || b.match.stage || '',
    bo: b.match.bo,
    blue: { team: blue.name, team_id: blue.id, abbr: blue.abbr, score: blue.score, win: b.win_camp === 1 },
    red: { team: red.name, team_id: red.id, abbr: red.abbr, score: red.score, win: b.win_camp === 2 },
    winner_side: sideName(b.win_camp),
    duration_sec: b.duration_sec,
    stats: {
      blue: b.sides && b.sides.camp1 ? { kills: b.sides.camp1.kills, deaths: b.sides.camp1.deaths, assists: b.sides.camp1.assists, gold: b.sides.camp1.gold, towers: b.sides.camp1.towers } : null,
      red: b.sides && b.sides.camp2 ? { kills: b.sides.camp2.kills, deaths: b.sides.camp2.deaths, assists: b.sides.camp2.assists, gold: b.sides.camp2.gold, towers: b.sides.camp2.towers } : null,
    },
    first_pick_side: firstPick ? sideName(firstPick.camp) : null,
    bans: banCount,
    picks: pickCount,
    complete,
    draft,
  };
  return row;
});

/* 选手-英雄对应：单独成文件，主表保持轻量 */
const playerRows = battles.map((b) => {
  const players = (b.players || []).map((p) => [sideName(p.camp), p.hero, p.player, p.pos]);
  return players.length ? { battle_id: b.battle_id, players } : null;
}).filter(Boolean);

/* ---------- 3. matches.csv ---------- */
const matchMap = new Map();
for (const b of battles) {
  const k = b.match.id;
  if (!matchMap.has(k)) {
    matchMap.set(k, {
      match_id: k, league_id: String(b.league.id), league: b.league.name, year: b.league.year,
      date: b.match.date, stage: b.match.stage_desc || b.match.stage || '', bo: b.match.bo, venue: b.match.venue,
      team1: b.match.team1 && b.match.team1.name, score1: b.match.team1 && b.match.team1.score,
      team2: b.match.team2 && b.match.team2.name, score2: b.match.team2 && b.match.team2.score,
      winner: b.match.team1 && b.match.team1.isWin ? b.match.team1.name : (b.match.team2 && b.match.team2.isWin ? b.match.team2.name : ''),
      games: 0,
    });
  }
  matchMap.get(k).games++;
}
const matches = [...matchMap.values()].sort((a, b) => (a.date === b.date ? String(a.match_id).localeCompare(String(b.match_id)) : String(a.date).localeCompare(String(b.date))));

/* ---------- 4. battles.csv（宽表） ---------- */
const headerBattles = ['battle_id', 'match_id', 'game_no', 'league_id', 'league', 'year', 'league_type', 'date', 'stage', 'bo',
  'blue_team', 'red_team', 'match_score', 'winner_side', 'winner_team', 'win_camp', 'duration_sec',
  'first_pick_side', 'bans', 'picks', 'complete', 'blue_bans', 'red_bans', 'blue_picks', 'red_picks', 'draft_order'];
const battleCsv = [BOM + csvLine(headerBattles)];
for (const r of slimRows) {
  const blueBans = r.draft.filter((x) => x.camp === 1 && x.action === 'ban').map((x) => x.hero);
  const redBans = r.draft.filter((x) => x.camp === 2 && x.action === 'ban').map((x) => x.hero);
  const bluePicks = r.draft.filter((x) => x.camp === 1 && x.action === 'pick').map((x) => x.hero);
  const redPicks = r.draft.filter((x) => x.camp === 2 && x.action === 'pick').map((x) => x.hero);
  battleCsv.push(csvLine([
    r.battle_id, r.match_id, r.game_no, r.league_id, r.league, r.year, r.league_type, r.date, r.stage, r.bo,
    r.blue.team, r.red.team, `${r.blue.score}:${r.red.score}`, r.winner_side, r.winner_side === 'blue' ? r.blue.team : r.red.team,
    r.winner_side === 'blue' ? 1 : 2, r.duration_sec, r.first_pick_side,
    r.bans, r.picks, r.complete ? 1 : 0,
    blueBans.join(';'), redBans.join(';'), bluePicks.join(';'), redPicks.join(';'),
    r.draft.map((x) => `${x.camp === 1 ? 'B' : 'R'}${x.action === 'ban' ? 'x' : 'p'}:${x.hero}`).join(' > '),
  ]));
}

/* ---------- 5. draft-actions.csv（长表） ---------- */
const headerActions = ['battle_id', 'ord', 'camp', 'side', 'action', 'hero', 'hero_id', 'pos'];
const actionRows = [BOM + csvLine(headerActions)];
const heroAggAll = new Map();
const heroAggYear = new Map();
const heroAggLeague = new Map();
const bump = (map, key, hero, field) => {
  let h = map.get(key);
  if (!h) { h = new Map(); map.set(key, h); }
  let s = h.get(hero);
  if (!s) { s = { picks: 0, bans: 0, wins: 0, losses: 0, positions: {} }; h.set(hero, s); }
  s[field]++;
  return s;
};
const heroNames = new Map();

for (const r of slimRows) {
  const yearKey = String(r.year);
  for (const x of r.draft) {
    heroNames.set(x.hid, x.hero);
    // 长表收录全部 BP 动作（含残缺对局），统计口径只用完整对局
    actionRows.push(csvLine([r.battle_id, x.n, x.camp, x.camp === 1 ? 'blue' : 'red', x.action, x.hero, x.hid, x.pos]));
    if (!r.complete) continue;
    const won = (x.camp === 1 && r.winner_side === 'blue') || (x.camp === 2 && r.winner_side === 'red');
    const f = x.action === 'pick' ? 'picks' : 'bans';
    const a1 = bump(heroAggAll, 'all', x.hero, f);
    const a2 = bump(heroAggYear, yearKey, x.hero, f);
    const a3 = bump(heroAggLeague, r.league_id, x.hero, f);
    if (x.action === 'pick') {
      for (const agg of [a1, a2, a3]) { if (won) agg.wins++; else agg.losses++; }
      if (x.pos !== null && x.pos !== undefined) {
        for (const agg of [a1, a2, a3]) agg.positions[x.pos] = (agg.positions[x.pos] || 0) + 1;
      }
    }
  }
}

/* ---------- 6. 统计 ---------- */
function finalizeHeroAgg(aggMap, gamesByKey, banSlotsByKey, pickSlotsByKey) {
  const out = {};
  for (const [key, hmap] of aggMap) {
    const games = gamesByKey(key) || 0;
    const banSlots = banSlotsByKey(key) || 0;
    const pickSlots = pickSlotsByKey(key) || 0;
    const arr = [...hmap.entries()].map(([hero, s]) => {
      const decided = s.wins + s.losses;
      const mainPos = Object.entries(s.positions).sort((a, b) => b[1] - a[1])[0];
      return {
        hero,
        picks: s.picks, bans: s.bans,
        wins: s.wins, losses: s.losses,
        win_rate: decided ? +(s.wins / decided * 100).toFixed(1) : null,
        pick_rate: games ? +(s.picks / games * 100).toFixed(1) : null,
        ban_rate: games ? +(s.bans / games * 100).toFixed(1) : null,
        ban_share_of_slots: banSlots ? +(s.bans / banSlots * 100).toFixed(1) : null,
        presence: games ? +((s.picks + s.bans) / games * 100).toFixed(1) : null,
        main_pos: mainPos ? Number(mainPos[0]) : null,
      };
    }).sort((a, b) => (b.picks + b.bans) - (a.picks + a.bans) || b.wins - a.wins);
    out[key] = { games, ban_slots: banSlots, pick_slots: pickSlots, heroes: arr };
  }
  return out;
}

const gamesWithBp = slimRows.filter((r) => r.complete);
const gamesPartial = slimRows.filter((r) => !r.complete && r.draft.length > 0);
const gamesEmpty = slimRows.filter((r) => !r.draft.length);
const banSlotsAll = gamesWithBp.reduce((a, r) => a + r.draft.filter((x) => x.action === 'ban').length, 0);
const pickSlotsAll = gamesWithBp.reduce((a, r) => a + r.draft.filter((x) => x.action === 'pick').length, 0);
const gamesByLeague = new Map();
for (const r of gamesWithBp) gamesByLeague.set(r.league_id, (gamesByLeague.get(r.league_id) || 0) + 1);
const gamesByYear = new Map();
for (const r of gamesWithBp) gamesByYear.set(String(r.year), (gamesByYear.get(String(r.year)) || 0) + 1);

const heroStatsAll = finalizeHeroAgg(heroAggAll, () => gamesWithBp.length, () => banSlotsAll, () => pickSlotsAll);
const heroStatsByYear = finalizeHeroAgg(heroAggYear,
  (k) => gamesByYear.get(k) || 0,
  (k) => gamesWithBp.filter((r) => String(r.year) === k).reduce((a, r) => a + r.draft.filter((x) => x.action === 'ban').length, 0),
  (k) => gamesWithBp.filter((r) => String(r.year) === k).reduce((a, r) => a + r.draft.filter((x) => x.action === 'pick').length, 0));
const heroStatsByLeague = finalizeHeroAgg(heroAggLeague,
  (k) => gamesByLeague.get(k) || 0,
  (k) => gamesWithBp.filter((r) => r.league_id === k).reduce((a, r) => a + r.draft.filter((x) => x.action === 'ban').length, 0),
  (k) => gamesWithBp.filter((r) => r.league_id === k).reduce((a, r) => a + r.draft.filter((x) => x.action === 'pick').length, 0));

/* 队伍统计 */
const teamAgg = new Map();
for (const r of slimRows) {
  for (const side of ['blue', 'red']) {
    const t = r[side].team;
    if (!t) continue;
    let s = teamAgg.get(t);
    if (!s) { s = { team: t, games: 0, wins: 0, leagues: new Set() }; teamAgg.set(t, s); }
    s.games++;
    if (r.winner_side === side) s.wins++;
    s.leagues.add(r.league_id);
  }
}
const teamStats = [...teamAgg.values()].map((s) => ({
  team: s.team, games: s.games, wins: s.wins, losses: s.games - s.wins,
  win_rate: +(s.wins / s.games * 100).toFixed(1), leagues: s.leagues.size,
})).sort((a, b) => b.games - a.games);

/* 蓝红方、首抢、时长 */
const sideSplit = (keyFn) => {
  const m = new Map();
  for (const r of gamesWithBp) {
    const k = keyFn(r);
    let s = m.get(k);
    if (!s) { s = { games: 0, blue_wins: 0, red_wins: 0, first_pick_blue: 0, first_pick_blue_wins: 0, first_pick_red: 0, first_pick_red_wins: 0, duration_sum: 0, duration_n: 0 }; m.set(k, s); }
    s.games++;
    if (r.winner_side === 'blue') s.blue_wins++; else s.red_wins++;
    if (r.first_pick_side === 'blue') { s.first_pick_blue++; if (r.winner_side === 'blue') s.first_pick_blue_wins++; }
    if (r.first_pick_side === 'red') { s.first_pick_red++; if (r.winner_side === 'red') s.first_pick_red_wins++; }
    if (r.duration_sec) { s.duration_sum += r.duration_sec; s.duration_n++; }
  }
  return Object.fromEntries([...m.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))).map(([k, s]) => [k, {
    games: s.games,
    blue_wins: s.blue_wins, red_wins: s.red_wins,
    blue_win_rate: +(s.blue_wins / s.games * 100).toFixed(1),
    first_pick_side: s.first_pick_blue >= s.first_pick_red ? 'blue' : 'red',
    first_pick_win_rate: s.first_pick_blue >= s.first_pick_red
      ? +(s.first_pick_blue_wins / Math.max(s.first_pick_blue, 1) * 100).toFixed(1)
      : +(s.first_pick_red_wins / Math.max(s.first_pick_red, 1) * 100).toFixed(1),
    avg_duration_min: s.duration_n ? +(s.duration_sum / s.duration_n / 60).toFixed(1) : null,
  }]));
};

/* BP 覆盖分布 */
const bpLenDist = {};
for (const r of slimRows) bpLenDist[r.draft.length] = (bpLenDist[r.draft.length] || 0) + 1;

const summary = {
  dataset: 'KPL BP Dataset',
  version: process.env.DATASET_VERSION || '1.0.0',
  generated_at: new Date().toISOString(),
  source: {
    name: '腾讯官方赛事数据接口（王者荣耀赛事数据中心 pvp.qq.com 页面自身调用的接口）',
    endpoints: [
      'https://prod.comp.smoba.qq.com/leaguesite/leagues/open',
      'https://prod.comp.smoba.qq.com/leaguesite/matches/open?league_id={league_id}',
      'https://prod.comp.smoba.qq.com/leaguesite/battle/open?battle_id={battle_id}',
    ],
    page: 'https://pvp.qq.com/matchdata/schedule.html?league_id={league_id}',
    rights: '赛事与对局数据的著作权归腾讯/王者荣耀赛事方所有；本仓库仅为研究、分析与开发用途的整理结果，非官方、非商业。',
  },
  coverage: {
    leagues: leaguesOut.length,
    years: [...new Set(leaguesOut.map((l) => l.year))].sort(),
    matches: matches.length,
    games: slimRows.length,
    games_with_bp: gamesWithBp.length + gamesPartial.length,
    games_complete: gamesWithBp.length,
    games_partial: gamesPartial.length,
    games_without_bp: gamesEmpty.length,
    games_with_20_actions: slimRows.filter((r) => r.draft.length === 20).length,
    heroes_seen: heroStatsAll.all.heroes.length,
    teams: teamStats.length,
    ban_slots: banSlotsAll,
    pick_slots: pickSlotsAll,
  },
  bp_len_distribution: Object.fromEntries(Object.entries(bpLenDist).sort((a, b) => Number(a[0]) - Number(b[0]))),
  side_stats_all: sideSplit(() => 'all').all,
  side_stats_by_year: sideSplit((r) => String(r.year)),
  side_stats_by_league: sideSplit((r) => r.league_id),
  top_ban: heroStatsAll.all.heroes.filter((h) => h.bans > 0).sort((a, b) => b.bans - a.bans).slice(0, 20).map((h) => ({ hero: h.hero, bans: h.bans, ban_rate: h.ban_rate })),
  top_pick: heroStatsAll.all.heroes.filter((h) => h.picks > 0).sort((a, b) => b.picks - a.picks).slice(0, 20).map((h) => ({ hero: h.hero, picks: h.picks, win_rate: h.win_rate })),
};

/* ---------- 6.5 自动生成 docs/stats.md ---------- */
function renderStatsMd() {
  const L = [];
  const md = summary.coverage;
  L.push('# KPL BP 数据统计速览', '');
  L.push(`> 本文件由 \`tools/build-kpl-db.mjs\` 自动生成（生成时间 ${summary.generated_at}），请勿手工修改。`);
  L.push(`> 统计口径：**只计入 BP 完整的对局**（双方各 5 手选人，且禁用位为 8 或 10，见 §6）；残缺/缺失对局仅计数不参与比率。`, '');

  L.push('## 1. 总览', '');
  L.push('| 指标 | 数值 |', '| --- | --- |');
  L.push(`| 赛事 | ${md.leagues} 个（${md.years[0]}–${md.years[md.years.length - 1]}） |`);
  L.push(`| 大场 | ${md.matches} 场 |`);
  L.push(`| 小局 | ${md.games} 局 |`);
  L.push(`| 完整 BP 对局 | ${md.games_complete} 局（${(md.games_complete / md.games * 100).toFixed(1)}%） |`);
  L.push(`| 残缺 BP 对局 | ${md.games_partial} 局 |`);
  L.push(`| 无 BP 数据对局 | ${md.games_without_bp} 局（主要为 2019 赛季） |`);
  L.push(`| 出现过的英雄 | ${md.heroes_seen} 个 |`);
  L.push(`| 战队 | ${md.teams} 支 |`);
  L.push(`| BP 动作总数 | ${md.ban_slots + md.pick_slots}（ban ${md.ban_slots} / pick ${md.pick_slots}） |`, '');

  L.push('## 2. 按年份', '');
  L.push('| 年份 | 赛事 | 大场 | 小局 | 完整BP | 残缺 | 无BP | 完整率 | 蓝方胜率 | 首抢方胜率 | 均时长(分) |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const y of md.years) {
    const s = summary.side_stats_by_year[String(y)] || {};
    const rows = slimRows.filter((r) => String(r.year) === String(y));
    const complete = rows.filter((r) => r.complete).length;
    const partial = rows.filter((r) => !r.complete && r.draft.length).length;
    const empty = rows.filter((r) => !r.draft.length).length;
    const lgCount = new Set(rows.map((r) => r.league_id)).size;
    const mtCount = new Set(rows.map((r) => r.match_id)).size;
    L.push(`| ${y} | ${lgCount} | ${mtCount} | ${rows.length} | ${complete} | ${partial} | ${empty} | ${(complete / Math.max(rows.length, 1) * 100).toFixed(1)}% | ${s.blue_win_rate ?? '-'}% | ${s.first_pick_win_rate ?? '-'}% | ${s.avg_duration_min ?? '-'} |`);
  }
  L.push('');

  L.push('## 3. 按赛事（BP 完整率）', '');
  L.push('| league_id | 赛事 | 类型 | 年份 | 大场 | 小局 | 完整BP | 完整率 |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const l of leaguesOut) {
    L.push(`| ${l.league_id} | ${l.league_name} | ${l.league_type} | ${l.year} | ${l.matches} | ${l.games} | ${l.games_complete ?? 0} | ${l.games ? ((l.games_complete ?? 0) / l.games * 100).toFixed(1) : '0.0'}% |`);
  }
  L.push('');

  L.push('## 4. 英雄 BP 榜（全量，仅完整对局）', '');
  L.push('ban 率 = 该英雄被禁用的局数 / 完整对局局数；pick 率同理；胜率为被选中时的胜率。', '');
  L.push('| # | 英雄 | ban | ban 率 | pick | pick 率 | 胜率 | 出场+禁用 |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  const rank = [...heroStatsAll.all.heroes].sort((a, b) => (b.picks + b.bans) - (a.picks + a.bans)).slice(0, 30);
  rank.forEach((h, i) => L.push(`| ${i + 1} | ${h.hero} | ${h.bans} | ${h.ban_rate ?? '-'}% | ${h.picks} | ${h.pick_rate ?? '-'}% | ${h.win_rate ?? '-'}% | ${h.presence ?? '-'}% |`));
  L.push('');

  L.push('## 5. 各年 ban 率前 5', '');
  for (const y of md.years) {
    const agg = heroStatsByYear[String(y)];
    if (!agg || !agg.heroes) continue;
    const top = [...agg.heroes].filter((h) => h.bans > 0).sort((a, b) => b.ban_rate - a.ban_rate).slice(0, 5);
    L.push(`- **${y}**（${agg.games} 局）：` + top.map((h) => `${h.hero} ${h.ban_rate}%`).join('、'));
  }
  L.push('');

  L.push('## 6. 口径与数据质量说明', '');
  L.push('- **完整对局**：`picks == 10` 且 `bans ∈ {8, 10}`。KPL 不同年代禁用位数量不同（早期 8 ban、后期 10 ban），故不做单一常量假设。');
  L.push('- **残缺对局**：接口只返回部分 BP（例如只返回 5 手 pick、或 9 个 ban），统计时排除，`data/battles.jsonl` 中保留原始记录并置 `complete: false`。');
  L.push('- **无 BP 对局**：2019 赛季部分对局的 `bp_list` 为空（仍有队伍/选手/经济数据），`draft` 为空数组。');
  L.push('- **同集不同序**：极少数对局在两次采集之间 `bp_list` 顺序发生微调，英雄集合一致；本数据集以最新一次采集为准。');
  L.push('- **阵营**：`camp=1` 为蓝方、`camp=2` 为红方；`win_camp` 与 `winner_side` 同义。');
  L.push('- **ban 率**按「每局被 ban 概率」计（分母=完整对局数）；如需「占全部禁用位的比例」，见 `data/stats/hero-stats-*.json` 的 `ban_share_of_slots`。');
  L.push('');
  return L.join('\n');
}

/* 用真实数字重写 README 的覆盖量区块（<!--COVERAGE--> ... <!--/COVERAGE-->） */
function fillReadmeCoverage() {
  const f = path.join(OUT, 'README.md');
  if (!fs.existsSync(f)) return;
  const text = fs.readFileSync(f, 'utf8');
  const re = /<!--COVERAGE-->[\s\S]*?<!--\/COVERAGE-->/;
  if (!re.test(text)) return;
  const c = summary.coverage;
  const rows = [
    ['赛事数', c.leagues],
    ['年份跨度', `${c.years[0]}–${c.years[c.years.length - 1]}`],
    ['大场（matches）', c.matches],
    ['小局（games）', c.games],
    ['含 BP 的对局', c.games_with_bp],
    ['完整 BP 对局（计入统计）', c.games_complete],
    ['残缺 BP 对局（仅保留、不参与比率）', c.games_partial],
    ['无 BP 对局（2019 年为主）', c.games_without_bp],
    ['出现过的英雄', c.heroes_seen],
    ['战队', c.teams],
    ['BP 动作总数', `${c.ban_slots} ban + ${c.pick_slots} pick`],
  ];
  const table = ['<!--COVERAGE-->', '<!-- 本区块由 tools/build-kpl-db.mjs 自动生成，勿手改 -->', '',
    '| 指标 | 数值 |', '| --- | --- |', ...rows.map(([k, v]) => `| ${k} | ${v} |`), '', '<!--/COVERAGE-->'].join('\n');
  fs.writeFileSync(f, text.replace(re, table), 'utf8');
  log('  README.md 覆盖量区块已回填真实数字');
}

/* ---------- 7. 写盘 ---------- */
const w = (rel, content) => {
  const p = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  const size = fs.statSync(p).size;
  log(`  ${rel.padEnd(42)} ${(size / 1024).toFixed(0)} KB`);
};
const wj = (rel, obj) => w(rel, JSON.stringify(obj, null, 1));
const wjl = (rel, arr) => w(rel, arr.map((r) => JSON.stringify(r)).join('\n') + '\n');

log(`写入 ${path.relative(ROOT, OUT)}/`);
wj('data/leagues.json', leaguesOut);
w('data/matches.csv', matches.length ? BOM + csvLine(['match_id', 'league_id', 'league', 'year', 'date', 'stage', 'bo', 'venue', 'team1', 'score1', 'team2', 'score2', 'winner', 'games'])
  + '\n' + matches.map((m) => csvLine([m.match_id, m.league_id, m.league, m.year, m.date, m.stage, m.bo, m.venue, m.team1, m.score1, m.team2, m.score2, m.winner, m.games])).join('\n') + '\n' : '');
wjl('data/battles.jsonl', slimRows);
wjl('data/players.jsonl', playerRows);
w('data/battles.csv', battleCsv.join('\n') + '\n');
w('data/draft-actions.csv', actionRows.join('\n') + '\n');
wj('data/heroes.json', [...heroNames.entries()].map(([id, name]) => ({ hero_id: id, hero: name })).sort((a, b) => a.hero_id - b.hero_id));
wj('data/stats/summary.json', summary);
fillReadmeCoverage();
wj('data/stats/hero-stats-all.json', heroStatsAll);
wj('data/stats/hero-stats-by-year.json', heroStatsByYear);
wj('data/stats/hero-stats-by-league.json', heroStatsByLeague);
wj('data/stats/team-stats.json', teamStats);
w('docs/stats.md', renderStatsMd());

/* 源数据快照（供复现核对） */
wj('data/provenance/source-leagues.json', (leagueDoc.results || []).map((l) => ({
  league_id: l.league_id, league_name: l.league_name, league_type_name: l.league_type_name,
  year: l.year, season: l.season, start_time: l.start_time, end_time: l.end_time, status: l.status,
})));

/* 脚本与 SQL */
for (const f of ['collect-kpl-bp-all.mjs', 'build-kpl-db.mjs']) {
  const src = path.join(ROOT, 'tools', f);
  if (fs.existsSync(src)) {
    const dest = path.join(OUT, 'scripts', f);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    log(`  scripts/${f}`);
  }
}
w('sql/schema.sql', `-- KPL BP Dataset —— SQLite / PostgreSQL 建表语句
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
`);
log('  文件写入完成');

const totalBytes = (function walk(d) {
  let s = 0;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    s += e.isDirectory() ? walk(p) : fs.statSync(p).size;
  }
  return s;
})(OUT);
log(`\n覆盖：${summary.coverage.leagues} 个赛事 / ${summary.coverage.matches} 场 / ${summary.coverage.games} 局（含 BP ${summary.coverage.games_with_bp} 局）/ ${summary.coverage.heroes_seen} 个英雄 / ${summary.coverage.teams} 支战队`);
log(`输出目录 ${OUT} 共 ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
