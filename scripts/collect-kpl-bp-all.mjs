#!/usr/bin/env node
/**
 * collect-kpl-bp-all —— 采集 KPL 官方赛事全量对局 BP 数据（可断点续跑）
 *
 * 数据来源（腾讯官方赛事数据接口，pvp.qq.com 赛事数据中心页面自身调用的同一套接口）：
 *   GET https://prod.comp.smoba.qq.com/leaguesite/leagues/open            赛事列表
 *   GET https://prod.comp.smoba.qq.com/leaguesite/matches/open?league_id= 赛程列表
 *   GET https://prod.comp.smoba.qq.com/leaguesite/battle/open?battle_id=  单局详情（含 bp_list）
 *
 * 合规口径：
 *   - 只取公开赛事数据（禁用/选择英雄、胜负、时长、战队公开统计），不取任何账号/个人信息；
 *   - 严格串行、不并发，默认每局间隔 300ms；
 *   - 断点续跑：已采集的 battle_id 直接从已有 JSONL 跳过，失败可重试。
 *
 * 用法：
 *   node tools/collect-kpl-bp-all.mjs --max-battles 12     # 抽样验证
 *   node tools/collect-kpl-bp-all.mjs                      # 全量（33 个赛事）
 *   node tools/collect-kpl-bp-all.mjs --league 20250001    # 只跑指定赛事
 *   node tools/collect-kpl-bp-all.mjs --gap 500            # 自定义间隔
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://prod.comp.smoba.qq.com/leaguesite';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);

const GAP = Number(opt('--gap', '300'));
const RAW = path.join(ROOT, opt('--out-dir', 'data/raw'));
const ONLY = opt('--league', '') ? opt('--league', '').split(',').map((s) => s.trim()).filter(Boolean) : null;
const MAX = Number(opt('--max-battles', '0')) || 0;
const RETRY = Number(opt('--retry', '3'));

const F_LEAGUES = path.join(RAW, 'leagues.json');
const D_MATCHES = path.join(RAW, 'matches');
const F_BATTLES = path.join(RAW, 'battles.jsonl');
const F_FAILS = path.join(RAW, 'fails.json');
const F_STATUS = path.join(RAW, 'crawl-status.json');

fs.mkdirSync(D_MATCHES, { recursive: true });

async function getJson(url, tries = RETRY) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, Referer: 'https://pvp.qq.com/' },
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (Number(j.code) !== 200) throw new Error(`code=${j.code} ${j.message || ''}`);
      return j;
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await sleep(1000 * (i + 1));
    }
  }
  throw lastErr;
}

/* ---------- 1. 赛事列表 ---------- */
async function loadLeagues() {
  if (fs.existsSync(F_LEAGUES)) {
    const cached = JSON.parse(fs.readFileSync(F_LEAGUES, 'utf8'));
    if (cached.results && cached.results.length) {
      console.log(`[1/4] 赛事列表（缓存）${cached.results.length} 个`);
      return cached;
    }
  }
  console.log('[1/4] 拉取赛事列表 ...');
  const j = await getJson(`${BASE}/leagues/open`);
  fs.writeFileSync(F_LEAGUES, JSON.stringify(j, null, 1), 'utf8');
  console.log(`      得到 ${j.results.length} 个赛事`);
  return j;
}

/* ---------- 2. 赛程列表 ---------- */
async function loadMatches(league) {
  const f = path.join(D_MATCHES, `${league.league_id}.json`);
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')).results || [];
  const j = await getJson(`${BASE}/matches/open?league_id=${encodeURIComponent(league.league_id)}`);
  fs.writeFileSync(f, JSON.stringify({ fetched_at: new Date().toISOString(), league_id: league.league_id, results: j.results || [] }, null, 1), 'utf8');
  await sleep(400);
  return j.results || [];
}

/* ---------- 3. 由 match 展开 battle 任务 ---------- */
function battleJobs(league, matches) {
  const jobs = [];
  for (const m of matches) {
    if (String(m.status) !== '2') continue; // 只取已结束的场次
    const list = m.match_battle_video_list || [];
    for (const b of list) {
      if (!b || !b.battle_id) continue;
      jobs.push({ league, match: m, battle: b });
    }
  }
  return jobs;
}

/* ---------- 4. 单局详情 → 数据库行 ---------- */
const teamBrief = (c) => c && ({
  id: c.team_id, name: c.team_name, abbr: c.team_abbreviation || '', icon: c.team_icon || '',
  score: c.score, isWin: !!c.is_win,
});

const sideStats = (c) => c && ({
  kills: c.kill_num, assists: c.assist_num, deaths: c.death_num, gold: c.gold,
  kda: c.kda, towers: c.push_tower_num,
  dragons: {
    tyrant: c.kill_tyrant_num || 0, darkTyrant: c.kill_dark_tyrant_num || 0,
    bigDragon: c.kill_big_dragon_num || 0, shadowDragon: c.kill_shadow_dragon_num || 0,
    stormDragonKing: c.kill_storm_dragon_king_num || 0, prophetDragon: c.kill_prophet_dragon_num || 0,
  },
});

function toRow(league, match, battle, d) {
  const bp = (d.bp_list || []).map((x) => ({
    camp: Number(x.camp),
    action: Number(x.is_ban_or_pick) === 0 ? 'ban' : 'pick',
    hero: x.hero_name,
    heroId: x.hero_id,
    position: x.position ?? null,
  }));
  const players = (d.battle_player_list || []).map((p) => ({
    camp: Number(p.camp), hero: p.hero_name, heroId: p.hero_id,
    player: p.player_name || '', pos: p.position_desc || '',
    k: p.kill_num, d: p.death_num, a: p.assist_num, gold: p.gold,
    mvp: !!Number(p.is_mvp), loseMvp: !!Number(p.is_lose_mvp),
  }));
  return {
    battle_id: d.battle_id || battle.battle_id,
    battle_seq: d.battle_seq ?? battle.battle_seq,
    league: {
      id: league.league_id, name: league.league_name,
      type: league.league_type_name, year: league.year, season: league.season,
    },
    match: {
      id: match.match_id, date: (match.start_time || '').slice(0, 10),
      stage_seq: match.match_stage_seq, stage: match.match_stage_name,
      stage_desc: match.match_stage_desc, bo: match.bo, venue: match.match_address || '',
      team1: teamBrief(match.camp1), team2: teamBrief(match.camp2),
      match_winner_camp: match.win_camp,
    },
    win_camp: d.win_camp,
    duration_sec: d.game_duration ? Math.round(d.game_duration / 1000) : null,
    bp,
    bp_count: bp.length,
    sides: { camp1: sideStats(d.camp1), camp2: sideStats(d.camp2) },
    players,
  };
}

/* ---------- main ---------- */
async function main() {
  const t0 = Date.now();
  const leagueDoc = await loadLeagues();
  let leagues = leagueDoc.results || [];
  if (ONLY) leagues = leagues.filter((l) => ONLY.includes(String(l.league_id)));
  leagues.sort((a, b) => String(b.league_id).localeCompare(String(a.league_id))); // 新赛事优先

  console.log(`[2/4] 展开赛程：${leagues.length} 个赛事`);
  const allJobs = [];
  const leagueSummary = [];
  for (const lg of leagues) {
    const matches = await loadMatches(lg);
    const jobs = battleJobs(lg, matches);
    allJobs.push(...jobs);
    leagueSummary.push({ league_id: lg.league_id, league_name: lg.league_name, matches: matches.length, battles: jobs.length });
    console.log(`      ${lg.league_id} ${lg.league_name}：${matches.length} 场 / ${jobs.length} 局`);
    await sleep(300);
  }

  // 去重（同一 battle 可能挂在不同赛事下）
  const seen = new Set();
  const jobs = allJobs.filter((j) => {
    const id = j.battle.battle_id;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  // 断点续跑：读取已采集
  const done = new Set();
  if (fs.existsSync(F_BATTLES)) {
    const lines = fs.readFileSync(F_BATTLES, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try { done.add(JSON.parse(line).battle_id); } catch { /* 忽略半行 */ }
    }
  }
  let todo = jobs.filter((j) => !done.has(j.battle.battle_id));
  if (MAX) todo = todo.slice(0, MAX);

  console.log(`[3/4] 去重后总对局 ${jobs.length} 局，已采集 ${done.size} 局，本次待采 ${todo.length} 局，间隔 ${GAP}ms`);
  if (!todo.length) { console.log('没有待采对局，退出。'); return; }

  const fails = fs.existsSync(F_FAILS) ? JSON.parse(fs.readFileSync(F_FAILS, 'utf8')) : [];
  const out = fs.createWriteStream(F_BATTLES, { flags: 'a' });
  let ok = 0, fail = 0, emptyBp = 0;
  const started = Date.now();

  const writeStatus = (extra = {}) => {
    const elapsed = (Date.now() - started) / 1000;
    const rate = ok ? ok / elapsed : 0;
    const status = {
      updated_at: new Date().toISOString(),
      leagues_total: leagues.length,
      battles_total: jobs.length,
      battles_done_before: done.size,
      this_run: { target: todo.length, ok, fail, empty_bp: emptyBp },
      rate_per_sec: Number(rate.toFixed(2)),
      eta_sec: rate ? Math.round((todo.length - ok - fail) / rate) : null,
      ...extra,
    };
    fs.writeFileSync(F_STATUS, JSON.stringify(status, null, 1), 'utf8');
  };

  for (let i = 0; i < todo.length; i++) {
    const { league, match, battle } = todo[i];
    const label = `${league.league_id}/${match.match_id}/G${battle.battle_seq}`;
    try {
      const j = await getJson(`${BASE}/battle/open?battle_id=${encodeURIComponent(battle.battle_id)}`);
      const row = toRow(league, match, battle, j.data || {});
      out.write(JSON.stringify(row) + '\n');
      ok++;
      if (!row.bp_count) emptyBp++;
    } catch (e) {
      fail++;
      fails.push({ battle_id: battle.battle_id, league_id: league.league_id, match_id: match.match_id, error: e.message, at: new Date().toISOString() });
      console.log(`      ✗ ${label} ${e.message}`);
    }
    if ((i + 1) % 25 === 0 || i === todo.length - 1) {
      const elapsed = (Date.now() - started) / 1000;
      const rate = ok / Math.max(elapsed, 1);
      const eta = rate ? Math.round((todo.length - i - 1) / rate) : 0;
      console.log(`      ${i + 1}/${todo.length} ok=${ok} fail=${fail} bp空=${emptyBp} ${rate.toFixed(2)}局/s ETA ${Math.round(eta / 60)}min`);
      writeStatus();
      fs.writeFileSync(F_FAILS, JSON.stringify(fails.slice(-500), null, 1), 'utf8');
    }
    if (i < todo.length - 1) await sleep(GAP);
  }

  out.end();
  fs.writeFileSync(F_FAILS, JSON.stringify(fails.slice(-500), null, 1), 'utf8');
  writeStatus({ finished_at: new Date().toISOString() });
  fs.writeFileSync(path.join(RAW, 'leagues-summary.json'), JSON.stringify(leagueSummary, null, 1), 'utf8');
  console.log(`[4/4] 完成：成功 ${ok} / 失败 ${fail} / BP 为空 ${emptyBp}，用时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟`);
  console.log(`      输出：${F_BATTLES}（${(fs.statSync(F_BATTLES).size / 1024 / 1024).toFixed(1)} MB）`);
}

main().catch((e) => { console.error('采集失败：' + (e && e.stack || e)); process.exitCode = 1; });
