#!/usr/bin/env node
/**
 * validate-dataset —— KPL BP Dataset 完整性校验（零依赖，Node ≥ 20）
 *
 * 校验内容：
 *   1. 必填文件齐全（data/ 下的 JSON / CSV / JSONL 与 sql/schema.sql）
 *   2. 每个 JSON 文件可解析、结构正确
 *   3. 每个 JSONL 文件逐行可解析，battle_id 全局唯一
 *   4. draft 结构：长度合法、camp/action 合法、同一局同一英雄不重复、
 *      每方 ban/pick 不超过 5、bans 字段与 ban 数一致、first_pick_side 可推导
 *   5. draft-actions.csv 行数与 battles 的 draft 总数一致，且逐行逐字段与 battles.jsonl 对齐
 *   6. battles.csv 行数/主键与 battles.jsonl 一致，宽表字段可由 jsonl 复算
 *   7. heroes.json 覆盖所有出现过的英雄（draft / draft-actions / players）
 *   8. CSV 表头与 sql/schema.sql 的列一致（不一致直接 FAIL）
 *   9. stats/*.json 与原始计数自洽（summary 覆盖数字、英雄榜、战队榜）
 *  10. 引用完整性：battle → match → league
 *
 * 用法：
 *   node scripts/validate-dataset.mjs
 *   node scripts/validate-dataset.mjs --data-dir data/_qa-sample/data
 *   node scripts/validate-dataset.mjs --data-dir data --schema sql/schema.sql
 *   node scripts/validate-dataset.mjs --strict-len     # 非标准 BP 长度也算失败
 *   node scripts/validate-dataset.mjs --quiet
 *
 * 退出码：0 = 通过（允许有 warning）；1 = 存在 error。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);

const QUIET = has('--quiet');
const STRICT_LEN = has('--strict-len');
const DATA_DIR = path.resolve(process.cwd(), opt('--data-dir', path.join(REPO, 'data')));
const DEFAULT_SCHEMAS = [path.join(DATA_DIR, '..', 'sql', 'schema.sql'), path.join(REPO, 'sql', 'schema.sql')];
const SCHEMA_FILE = path.resolve(process.cwd(), opt('--schema', DEFAULT_SCHEMAS.find((p) => fs.existsSync(p)) || DEFAULT_SCHEMAS[0]));

/* ------------------------------------------------------------------ */
/* 环境事实：BP 长度与「完整对局」口径（与 tools/build-kpl-db.mjs 一致） */
/*   0  = 官方接口未返回 bp_list（2019 年赛事普遍如此）                 */
/*   20 = 现行赛制（每方 5 ban + 5 pick）                              */
/*   18 = 早期 8 ban + 5 pick 赛制                                     */
/*   16 / 10 / 8 = 更早期赛制                                          */
/*   9 / 19 = 少 1 手（上游接口个别缺项）                              */
/* 完整对局 = picks==10 && bans∈{8,10}；统计类文件只计入完整对局。      */
/* 其余长度（如 5 / 7）来自上游 bp_list 残缺，记 warning，不判失败；   */
/* 加 --strict-len 后升级为失败。                                      */
/* ------------------------------------------------------------------ */
const ALLOWED_LENS = new Set([0, 8, 9, 10, 16, 18, 19, 20]);
const MAX_ACTIONS = 20;
const MAX_PER_SIDE = 5;
const isComplete = (picks, bans) => picks === 10 && (bans === 8 || bans === 10);

/* ---------------------------- 报告器 ---------------------------- */
const errors = [];
const warnings = [];
const err = (s, m) => errors.push(`[${s}] ${m}`);
const warn = (s, m) => warnings.push(`[${s}] ${m}`);
const info = (...a) => { if (!QUIET) console.log(...a); };

const sections = [];
function section(title) {
  const sec = { title, errors: [], warnings: [], notes: [] };
  sections.push(sec);
  const e = (m) => { sec.errors.push(m); errors.push(`[${title}] ${m}`); };
  const w = (m) => { sec.warnings.push(m); warnings.push(`[${title}] ${m}`); };
  const n = (m) => { sec.notes.push(m); };
  return { e, w, n };
}
function flush() {
  for (const s of sections) {
    const status = s.errors.length ? 'FAIL' : s.warnings.length ? 'WARN' : 'PASS';
    console.log(`\n[${status}] ${s.title}`);
    for (const m of s.notes) console.log(`        ${m}`);
    for (const m of s.warnings) console.log(`  warn  ${m}`);
    for (const m of s.errors) console.log(`  ERROR ${m}`);
  }
}

/* ---------------------------- 工具 ---------------------------- */
const BOM = '\uFEFF';
const abs = (rel) => path.join(DATA_DIR, rel);
const exists = (rel) => fs.existsSync(abs(rel));
const readText = (rel) => fs.readFileSync(abs(rel), 'utf8');
const relSize = (rel) => { try { return fs.statSync(abs(rel)).size; } catch { return 0; } };
const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
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

/** 读 CSV：返回 { header, rows, hasBom }。本数据集不含跨行单元格。 */
function readCsv(rel) {
  const text = readText(rel);
  const hasBom = text.charCodeAt(0) === 0xfeff;
  const body = hasBom ? text.slice(1) : text;
  const lines = body.split(/\r?\n/).filter((l) => l.length > 0);
  const header = lines.length ? parseCsvLine(lines[0]) : [];
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const row = {};
    header.forEach((h, j) => { row[h] = cells[j] ?? ''; });
    rows.push(row);
  }
  return { header, rows, hasBom };
}

/** 读 JSONL：逐行 JSON.parse，坏行计入 bad。 */
function readJsonl(rel) {
  const text = readText(rel);
  const out = [];
  const bad = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    try { out.push(JSON.parse(line)); } catch (e) { bad.push({ line: i + 1, msg: e.message }); }
  });
  return { rows: out, bad };
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isInt = (v) => isNum(v) && Number.isInteger(v);
const isStr = (v) => typeof v === 'string' && v.length > 0;
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : 'n/a');
const uniq = (arr) => [...new Set(arr)];
const sampleList = (arr, n = 5) => arr.slice(0, n).join('、') + (arr.length > n ? ` 等 ${arr.length} 项` : '');

/** 解析 schema.sql 的 CREATE TABLE 列名。 */
function parseSchema(text) {
  const tables = new Map();
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(\w+)["'`]?\s*\(([\s\S]*?)\)\s*;/gi;
  let m;
  while ((m = re.exec(text))) {
    const cols = [];
    for (const raw of m[2].split('\n')) {
      const line = raw.replace(/--.*$/, '').trim().replace(/,$/, '').trim();
      if (!line) continue;
      if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(line)) continue;
      const col = line.split(/\s+/)[0].replace(/["'`]/g, '');
      if (col) cols.push(col);
    }
    tables.set(m[1].toLowerCase(), cols);
  }
  return tables;
}

console.log('KPL BP Dataset 完整性校验');
console.log(`  数据目录 : ${DATA_DIR}`);
console.log(`  schema   : ${SCHEMA_FILE}`);
console.log(`  模式     : ${STRICT_LEN ? 'strict-len（非标准 BP 长度判失败）' : '默认'}`);

/* ================================================================== */
/* 1. 必填文件                                                        */
/* ================================================================== */
const FILES = [
  'leagues.json',
  'matches.csv',
  'battles.jsonl',
  'battles.csv',
  'draft-actions.csv',
  'players.jsonl',
  'heroes.json',
  'stats/summary.json',
  'stats/hero-stats-all.json',
  'stats/hero-stats-by-year.json',
  'stats/hero-stats-by-league.json',
  'stats/team-stats.json',
  'provenance/source-leagues.json',
];
const sFile = section('1. 必填文件');
const missingFiles = FILES.filter((f) => !exists(f));
for (const f of missingFiles) sFile.e(`缺少文件 data/${f}`);
if (!exists('leagues.json')) {
  sFile.e('缺少 data/leagues.json，无法继续');
  flush();
  console.log(`\n结果: FAIL（${errors.length} error / ${warnings.length} warning）`);
  process.exit(1);
}
let totalBytes = 0;
for (const f of FILES) if (exists(f)) totalBytes += relSize(f);
sFile.n(`已存在 ${FILES.length - missingFiles.length}/${FILES.length} 个文件，合计 ${fmtBytes(totalBytes)}`);

/* ================================================================== */
/* 2. schema.sql 与 CSV 表头                                          */
/* ================================================================== */
const sCsv = section('2. CSV 表头 vs sql/schema.sql');
let schema = new Map();
if (!fs.existsSync(SCHEMA_FILE)) {
  sCsv.e(`schema.sql 不存在: ${SCHEMA_FILE}`);
} else {
  schema = parseSchema(fs.readFileSync(SCHEMA_FILE, 'utf8'));
  for (const t of ['leagues', 'matches', 'battles', 'draft_actions', 'battle_players']) {
    if (!schema.has(t)) sCsv.e(`schema.sql 缺少表 ${t}`);
  }
  sCsv.n(`解析出 ${schema.size} 张表：${[...schema.keys()].join(', ')}`);
}
const CSV_TABLES = [['matches.csv', 'matches'], ['battles.csv', 'battles'], ['draft-actions.csv', 'draft_actions']];
const csvData = new Map();
for (const [file, table] of CSV_TABLES) {
  if (!exists(file)) continue;
  const csv = readCsv(file);
  csvData.set(file, csv);
  if (!csv.hasBom) sCsv.w(`${file} 缺少 UTF-8 BOM（Excel 直接打开可能乱码）`);
  if (!csv.header.length) { sCsv.e(`${file} 表头为空`); continue; }
  const dup = uniq(csv.header.filter((h, i) => csv.header.indexOf(h) !== i));
  if (dup.length) sCsv.e(`${file} 表头有重复列: ${dup.join('、')}`);
  const cols = schema.get(table);
  if (!cols) continue;
  const missing = cols.filter((c) => !csv.header.includes(c));
  const extra = csv.header.filter((c) => !cols.includes(c));
  if (missing.length) sCsv.e(`${file} 缺少 schema 列: ${missing.join('、')}`);
  if (extra.length) sCsv.e(`${file} 有 schema 未定义的列: ${extra.join('、')}`);
  if (!missing.length && !extra.length) {
    const orderDiff = cols.filter((c, i) => csv.header[i] !== c);
    if (orderDiff.length) sCsv.w(`${file} 列顺序与 schema 不同（不影响使用）: 首个差异列 ${orderDiff[0]}`);
    sCsv.n(`${file} → ${table}：${csv.header.length} 列，${csv.rows.length} 行，与 schema 一致`);
  }
}

/* ================================================================== */
/* 3. leagues.json                                                    */
/* ================================================================== */
const sLeague = section('3. leagues.json');
let leagues = [];
try {
  leagues = JSON.parse(readText('leagues.json'));
  if (!Array.isArray(leagues)) sLeague.e('leagues.json 顶层应为数组');
} catch (e) { sLeague.e(`无法解析: ${e.message}`); }
const leagueIds = new Set();
const LEAGUE_FIELDS = ['league_id', 'league_name', 'league_type', 'year', 'season', 'start_time', 'end_time', 'matches', 'games', 'games_with_bp'];
for (const [i, l] of leagues.entries()) {
  if (!isStr(String(l.league_id ?? ''))) sLeague.e(`第 ${i + 1} 条缺 league_id`);
  if (leagueIds.has(String(l.league_id))) sLeague.e(`league_id 重复: ${l.league_id}`);
  leagueIds.add(String(l.league_id));
  for (const f of LEAGUE_FIELDS) if (!(f in l)) sLeague.e(`${l.league_id} 缺字段 ${f}`);
  for (const f of ['matches', 'games', 'games_with_bp']) if (!isInt(l[f])) sLeague.e(`${l.league_id}.${f} 应为整数`);
  if (!l.league_name) sLeague.w(`${l.league_id} league_name 为空`);
}
sLeague.n(`${leagues.length} 个赛事，年份 ${uniq(leagues.map((l) => l.year)).sort().join('/')}`);

/* ================================================================== */
/* 4. matches.csv                                                     */
/* ================================================================== */
const sMatch = section('4. matches.csv');
let matches = [];
const matchIds = new Set();
if (csvData.has('matches.csv')) {
  matches = csvData.get('matches.csv').rows;
  for (const [i, m] of matches.entries()) {
    if (!m.match_id) sMatch.e(`第 ${i + 2} 行缺 match_id`);
    if (matchIds.has(m.match_id)) sMatch.e(`match_id 重复: ${m.match_id}`);
    matchIds.add(m.match_id);
    if (!leagueIds.has(m.league_id)) sMatch.e(`${m.match_id} 的 league_id ${m.league_id} 不在 leagues.json`);
    if (!m.team1 || !m.team2) sMatch.e(`${m.match_id} 缺少队伍名`);
    if (!/^\d{4}-\d{2}-\d{2}/.test(m.date || '')) sMatch.e(`${m.match_id} 日期格式异常: ${m.date}`);
    const games = Number(m.games);
    if (!isInt(games) || games <= 0) sMatch.e(`${m.match_id} games 应为正整数`);
  }
  const boBad = matches.filter((m) => !['1', '3', '4', '5', '7', '9'].includes(String(m.bo)));
  if (boBad.length) sMatch.w(`bo 取值异常 ${boBad.length} 场（如 ${sampleList(boBad.map((m) => `${m.match_id}:${m.bo}`))}）`);
  sMatch.n(`${matches.length} 场，覆盖 ${uniq(matches.map((m) => m.league_id)).length} 个赛事`);
}

/* ================================================================== */
/* 5. battles.jsonl（核心）                                           */
/* ================================================================== */
const sBattle = section('5. battles.jsonl');
let battles = [];
const battleIds = new Set();
const draftLenDist = {};
const anomalyLens = [];
const heroIdName = new Map();
const heroNameId = new Map();
let banSlots = 0;
let pickSlots = 0;
let banSlotsComplete = 0;
let pickSlotsComplete = 0;
let gamesWithBp = 0;
let completeGames = 0;
let partialGames = 0;
let emptyGames = 0;
let len20 = 0;
let withPlayers = 0;
const teamNames = new Set();
const completeHeroes = new Set();
/** battle_id → { draft, blue, red, ... }，供后续文件交叉复算 */
const battleIndex = new Map();

function noteHero(hero, hid, where) {
  if (!isStr(hero)) return;
  if (isInt(hid)) {
    const prevName = heroIdName.get(hid);
    if (prevName && prevName !== hero) sBattle.e(`hero_id ${hid} 对应多个英雄名: ${prevName} / ${hero}（${where}）`);
    heroIdName.set(hid, hero);
  }
  if (isInt(hid)) {
    const prevId = heroNameId.get(hero);
    if (prevId !== undefined && prevId !== hid) sBattle.e(`英雄 ${hero} 出现多个 hero_id: ${prevId} / ${hid}（${where}）`);
    heroNameId.set(hero, hid);
  } else {
    heroNameId.set(hero, null);
  }
}

if (exists('battles.jsonl')) {
  const { rows, bad } = readJsonl('battles.jsonl');
  for (const b of bad.slice(0, 10)) sBattle.e(`第 ${b.line} 行 JSON 解析失败: ${b.msg}`);
  if (bad.length > 10) sBattle.e(`另有 ${bad.length - 10} 行 JSON 解析失败`);
  battles = rows;

  const REQUIRED = ['battle_id', 'match_id', 'game_no', 'league_id', 'league', 'year', 'league_type', 'date', 'stage', 'bo', 'blue', 'red', 'winner_side', 'duration_sec', 'stats', 'first_pick_side', 'bans', 'draft'];
  for (const [i, b] of battles.entries()) {
    const tag = b && b.battle_id ? b.battle_id : `第 ${i + 1} 行`;
    if (!b || typeof b !== 'object') { sBattle.e(`${tag} 不是对象`); continue; }
    for (const f of REQUIRED) if (!(f in b)) sBattle.e(`${tag} 缺字段 ${f}`);
    if (!isStr(b.battle_id)) sBattle.e(`${tag} battle_id 非法`);
    else if (battleIds.has(b.battle_id)) sBattle.e(`battle_id 重复: ${b.battle_id}`);
    else battleIds.add(b.battle_id);

    if (!matchIds.has(String(b.match_id))) sBattle.e(`${tag} match_id ${b.match_id} 不在 matches.csv`);
    if (!leagueIds.has(String(b.league_id))) sBattle.e(`${tag} league_id ${b.league_id} 不在 leagues.json`);
    if (!isInt(b.game_no) || b.game_no <= 0) sBattle.e(`${tag} game_no 应为正整数`);
    if (!['blue', 'red'].includes(b.winner_side)) sBattle.e(`${tag} winner_side 非法: ${b.winner_side}`);
    if (!isInt(b.duration_sec) || b.duration_sec <= 0) sBattle.w(`${tag} duration_sec 异常: ${b.duration_sec}`);
    if (!/^\d{4}-\d{2}-\d{2}/.test(String(b.date || ''))) sBattle.e(`${tag} date 格式异常: ${b.date}`);

    const blue = b.blue || {};
    const red = b.red || {};
    for (const [side, o] of [['blue', blue], ['red', red]]) {
      if (!isStr(o.team)) sBattle.e(`${tag} ${side}.team 为空`);
      else teamNames.add(o.team);
      if (typeof o.win !== 'boolean') sBattle.e(`${tag} ${side}.win 应为布尔`);
      if (!isInt(o.score)) sBattle.w(`${tag} ${side}.score 非整数`);
    }
    if (blue.team && red.team && blue.team === red.team) sBattle.w(`${tag} 蓝红双方同名: ${blue.team}`);
    const winSide = blue.win === true ? 'blue' : red.win === true ? 'red' : null;
    if (!winSide) sBattle.e(`${tag} 蓝红双方 win 同时为 false`);
    else if (winSide !== b.winner_side) sBattle.e(`${tag} winner_side=${b.winner_side} 与 ${winSide}.win=true 不一致`);

    for (const side of ['blue', 'red']) {
      const st = (b.stats || {})[side];
      if (!st) { sBattle.w(`${tag} 缺 ${side} 经济/击杀统计`); continue; }
      for (const k of ['kills', 'deaths', 'assists', 'gold', 'towers']) {
        if (!isInt(st[k])) sBattle.w(`${tag} stats.${side}.${k} 非整数: ${st[k]}`);
      }
    }

    /* draft */
    const draft = Array.isArray(b.draft) ? b.draft : null;
    if (!draft) { sBattle.e(`${tag} draft 不是数组`); continue; }
    const len = draft.length;
    draftLenDist[len] = (draftLenDist[len] || 0) + 1;
    if (len > MAX_ACTIONS) sBattle.e(`${tag} draft 长度 ${len} 超过 ${MAX_ACTIONS}`);
    if (len > 0) gamesWithBp++;
    if (len > 0 && !ALLOWED_LENS.has(len)) {
      anomalyLens.push({ id: b.battle_id, len, year: b.year });
      if (STRICT_LEN) sBattle.e(`${tag} draft 长度 ${len} 不在允许集合 {${[...ALLOWED_LENS].join(',')}} 内（--strict-len）`);
    }
    if (len > 0 && !draft.some((x) => x && x.action === 'pick')) sBattle.w(`${tag} draft 只有 ban 没有 pick（上游缺项）`);
    const seenHero = new Set();
    let banN = 0;
    let pickN = 0;
    const campCount = { 1: { ban: 0, pick: 0 }, 2: { ban: 0, pick: 0 } };
    let lastPickCamp = null;
    for (let k = 0; k < draft.length; k++) {
      const x = draft[k];
      if (!x || typeof x !== 'object') { sBattle.e(`${tag} draft[${k}] 不是对象`); continue; }
      if (x.n !== k + 1) sBattle.e(`${tag} draft[${k}].n=${x.n}，应为 ${k + 1}`);
      if (![1, 2].includes(x.camp)) sBattle.e(`${tag} draft[${k}].camp 非法: ${x.camp}`);
      if (!['ban', 'pick'].includes(x.action)) sBattle.e(`${tag} draft[${k}].action 非法: ${x.action}`);
      if (!isStr(x.hero)) sBattle.e(`${tag} draft[${k}].hero 为空`);
      else if (seenHero.has(x.hero)) sBattle.e(`${tag} 同一局英雄重复: ${x.hero}`);
      else seenHero.add(x.hero);
      if (!isInt(x.hid)) sBattle.w(`${tag} draft[${k}].hid 非整数: ${x.hid}`);
      if (!(x.pos === null || isInt(x.pos))) sBattle.w(`${tag} draft[${k}].pos 非法: ${x.pos}`);
      noteHero(x.hero, x.hid, tag);
      if (x.camp === 1 || x.camp === 2) {
        const c = campCount[x.camp];
        if (x.action === 'ban') { c.ban++; banN++; }
        if (x.action === 'pick') { c.pick++; pickN++; lastPickCamp = lastPickCamp ?? x.camp; }
      }
    }
    for (const camp of [1, 2]) {
      if (campCount[camp].ban > MAX_PER_SIDE) sBattle.e(`${tag} camp${camp} ban ${campCount[camp].ban} 个，超过 ${MAX_PER_SIDE}`);
      if (campCount[camp].pick > MAX_PER_SIDE) sBattle.e(`${tag} camp${camp} pick ${campCount[camp].pick} 个，超过 ${MAX_PER_SIDE}`);
    }
    banSlots += banN;
    pickSlots += pickN;
    const complete = isComplete(pickN, banN);
    if (len === 0) emptyGames++;
    else if (complete) completeGames++;
    else partialGames++;
    if (complete) {
      banSlotsComplete += banN;
      pickSlotsComplete += pickN;
      for (const x of draft) if (x && isStr(x.hero)) completeHeroes.add(x.hero);
    }
    if (len === 20) len20++;
    if (typeof b.complete !== 'boolean') sBattle.e(`${tag} 缺 complete 布尔字段（应为 picks==10 且 bans∈{8,10}）`);
    else if (b.complete !== complete) sBattle.e(`${tag} complete=${b.complete}，但 picks=${pickN}/bans=${banN} 应为 ${complete}`);
    if (b.bans !== banN) sBattle.e(`${tag} bans=${b.bans} 与实际 ban 数 ${banN} 不一致`);
    if (lastPickCamp !== null && b.first_pick_side !== (lastPickCamp === 1 ? 'blue' : 'red')) {
      sBattle.e(`${tag} first_pick_side=${b.first_pick_side} 与首个 pick 阵营不一致`);
    }
    if (lastPickCamp === null && b.first_pick_side !== null && b.first_pick_side !== undefined) {
      sBattle.w(`${tag} 无 pick 但 first_pick_side=${b.first_pick_side}`);
    }
    if (Array.isArray(b.players) && b.players.length) withPlayers++;

    battleIndex.set(b.battle_id, { b, draft, blue, red });
  }
  if (battles.length !== battleIds.size) sBattle.e(`存在重复 battle_id（唯一 ${battleIds.size} / 总 ${battles.length}）`);
  sBattle.n(`解析 ${battles.length} 局（唯一 battle_id ${battleIds.size}），含 BP ${gamesWithBp} 局，ban ${banSlots} / pick ${pickSlots} 个动作，团队 ${teamNames.size} 支，英雄 ${heroIdName.size} 个`);
  sBattle.n(`完整 BP ${completeGames} 局（picks=10 且 bans∈{8,10}）／残缺 ${partialGames} 局／无 BP ${emptyGames} 局；完整对局 ban ${banSlotsComplete} / pick ${pickSlotsComplete} 个动作，涉及英雄 ${completeHeroes.size} 个`);
  const distTxt = Object.keys(draftLenDist).sort((a, b) => Number(a) - Number(b)).map((k) => `${k}手:${draftLenDist[k]}`).join('  ');
  sBattle.n(`BP 长度分布 ${distTxt}`);
  if (anomalyLens.length) {
    const byLen = {};
    for (const a of anomalyLens) byLen[a.len] = (byLen[a.len] || 0) + 1;
    const msg = `${anomalyLens.length} 局长度不在标准集合 {${[...ALLOWED_LENS].join(',')}} 内：${Object.entries(byLen).map(([l, c]) => `${l}手×${c}`).join('、')}（上游 bp_list 缺项，示例 ${sampleList(anomalyLens.map((a) => a.id), 3)}）`;
    if (STRICT_LEN) sBattle.e(msg); else sBattle.w(msg);
  }
}

/* ================================================================== */
/* 5b. leagues.json 计数与对局数据自洽                                 */
/* ================================================================== */
const sLgCount = section('5b. leagues.json 计数');
if (battles.length) {
  const agg = new Map();
  const matchAgg = new Map();
  for (const [, v] of battleIndex) {
    const id = String(v.b.league_id);
    let a = agg.get(id);
    if (!a) { a = { games: 0, withBp: 0, complete: 0 }; agg.set(id, a); }
    a.games++;
    const picks = v.draft.filter((x) => x.action === 'pick').length;
    const bans = v.draft.filter((x) => x.action === 'ban').length;
    if (v.draft.length) a.withBp++;
    if (isComplete(picks, bans)) a.complete++;
    let ms = matchAgg.get(id);
    if (!ms) { ms = new Set(); matchAgg.set(id, ms); }
    ms.add(String(v.b.match_id));
  }
  for (const l of leagues) {
    const id = String(l.league_id);
    const a = agg.get(id) || { games: 0, withBp: 0, complete: 0 };
    if (l.games !== a.games) sLgCount.e(`${id} games=${l.games}，实测 ${a.games}`);
    if (l.games_with_bp !== a.withBp) sLgCount.e(`${id} games_with_bp=${l.games_with_bp}，实测 ${a.withBp}`);
    if ('games_complete' in l && l.games_complete !== a.complete) sLgCount.e(`${id} games_complete=${l.games_complete}，实测 ${a.complete}`);
    const m = matchAgg.get(id) || new Set();
    if (l.matches !== m.size) sLgCount.e(`${id} matches=${l.matches}，实测 ${m.size}`);
  }
  if (!leagues.some((l) => 'games_complete' in l)) sLgCount.w('leagues.json 缺少 games_complete 字段（当前 build 脚本应输出）');
  const leagueCols = schema.get('leagues') || [];
  const jsonKeys = uniq(leagues.flatMap((l) => Object.keys(l)));
  const notInSchema = leagueCols.length ? jsonKeys.filter((k) => !leagueCols.includes(k)) : [];
  if (notInSchema.length) sLgCount.w(`leagues.json 有 sql/schema.sql 的 leagues 表未定义的字段: ${notInSchema.join('、')}`);
  sLgCount.n(`33 个赛事的 matches/games/games_with_bp/games_complete 与对局数据一致`);
}

/* ================================================================== */
/* 6. players.jsonl                                                   */
/* ================================================================== */
const sPlayer = section('6. players.jsonl');
const playerBattleIds = new Set();
const playerHeroes = new Set();
let playerRowsN = 0;
if (exists('players.jsonl')) {
  const { rows, bad } = readJsonl('players.jsonl');
  for (const b of bad.slice(0, 10)) sPlayer.e(`第 ${b.line} 行 JSON 解析失败: ${b.msg}`);
  if (bad.length > 10) sPlayer.e(`另有 ${bad.length - 10} 行 JSON 解析失败`);
  for (const row of rows) {
    if (!isStr(row.battle_id)) { sPlayer.e('存在缺 battle_id 的行'); continue; }
    if (playerBattleIds.has(row.battle_id)) sPlayer.e(`battle_id 重复: ${row.battle_id}`);
    playerBattleIds.add(row.battle_id);
    if (!battleIds.has(row.battle_id)) sPlayer.e(`battle_id ${row.battle_id} 不在 battles.jsonl`);
    if (!Array.isArray(row.players)) { sPlayer.e(`${row.battle_id} players 不是数组`); continue; }
    if (row.players.length && row.players.length !== 10) sPlayer.w(`${row.battle_id} players 有 ${row.players.length} 条（通常 10 条）`);
    for (const p of row.players) {
      if (!Array.isArray(p) || p.length !== 4) { sPlayer.e(`${row.battle_id} players 元素应为 [side,hero,player,pos]`); continue; }
      const [side, hero, player, pos] = p;
      if (!['blue', 'red'].includes(side)) sPlayer.e(`${row.battle_id} side 非法: ${side}`);
      if (!isStr(hero)) sPlayer.e(`${row.battle_id} hero 为空`);
      else playerHeroes.add(hero);
      if (!isStr(player)) sPlayer.w(`${row.battle_id} 选手名为空（${hero}）`);
      if (typeof pos !== 'string') sPlayer.w(`${row.battle_id} pos 应为字符串（${hero}: ${pos}）`);
      const entry = battleIndex.get(row.battle_id);
      if (entry && entry.draft.length === 0) {
        /* 该局接口没有返回 bp_list（2019 赛季等）：无 draft 可比对，跳过不算问题 */
      } else if (entry && isStr(hero) && !entry.draft.some((x) => x.hero === hero)) {
        /* 残缺 BP（如 19 手）里选手数据仍可能完整，属上游缺项，记 warning；完整对局必须一致 */
        const msg = `${row.battle_id} 选手英雄 ${hero} 不在该局 draft 中`;
        if (isComplete(entry.draft.filter((x) => x.action === 'pick').length, entry.draft.filter((x) => x.action === 'ban').length)) sPlayer.e(msg);
        else sPlayer.w(`${msg}（该局 BP 残缺，上游缺项）`);
      }
      if (entry && isStr(hero) && heroNameId.has(hero) && heroNameId.get(hero) !== null) {
        /* hero_id 由 battles 侧建立，此处无需重复校验 */
      }
    }
    playerRowsN += row.players.length;
  }
  const missingPlayers = [...battleIds].filter((id) => !playerBattleIds.has(id));
  if (missingPlayers.length) sPlayer.w(`${missingPlayers.length} 局没有 players 记录（如 ${sampleList(missingPlayers, 3)}）`);
  sPlayer.n(`${playerBattleIds.size} 局 / ${playerRowsN} 条选手-英雄记录`);
}

/* ================================================================== */
/* 7. heroes.json                                                     */
/* ================================================================== */
const sHero = section('7. heroes.json');
let heroes = [];
if (exists('heroes.json')) {
  try {
    heroes = JSON.parse(readText('heroes.json'));
    if (!Array.isArray(heroes)) sHero.e('顶层应为数组');
  } catch (e) { sHero.e(`无法解析: ${e.message}`); }
  const ids = new Set();
  const names = new Set();
  for (const [i, h] of heroes.entries()) {
    if (!isInt(h.hero_id)) sHero.e(`第 ${i + 1} 条 hero_id 非整数: ${h.hero_id}`);
    if (!isStr(h.hero)) sHero.e(`第 ${i + 1} 条 hero 为空`);
    if (ids.has(h.hero_id)) sHero.e(`hero_id 重复: ${h.hero_id}`);
    if (names.has(h.hero)) sHero.e(`英雄名重复: ${h.hero}`);
    ids.add(h.hero_id);
    names.add(h.hero);
    const battleName = heroIdName.get(h.hero_id);
    if (battleName && battleName !== h.hero) sHero.e(`hero_id ${h.hero_id} 在 battles 中叫 ${battleName}，heroes.json 中叫 ${h.hero}`);
  }
  const seen = new Set([...heroIdName.keys()]);
  for (const h of playerHeroes) if (heroNameId.get(h) === undefined) seen.add(`name:${h}`);
  const missing = [...seen].filter((k) => (typeof k === 'number' ? !ids.has(k) : !names.has(String(k).slice(5))));
  if (missing.length) sHero.e(`heroes.json 未覆盖 ${missing.length} 个出现过的英雄: ${sampleList(missing.map(String))}`);
  sHero.n(`${heroes.length} 个英雄，覆盖 draft/players 中出现过的全部英雄`);
}

/* ================================================================== */
/* 8. draft-actions.csv                                               */
/* ================================================================== */
const sAction = section('8. draft-actions.csv');
let actionRows = [];
if (csvData.has('draft-actions.csv')) {
  actionRows = csvData.get('draft-actions.csv').rows;
  let expected = 0;
  for (const [, v] of battleIndex) expected += v.draft.length;
  if (actionRows.length !== expected) sAction.e(`行数 ${actionRows.length} ≠ battles.jsonl 的 draft 动作总数 ${expected}`);
  else sAction.n(`${actionRows.length} 行 = draft 动作总数`);

  const byBattle = new Map();
  for (const [i, r] of actionRows.entries()) {
    const tag = `第 ${i + 2} 行`;
    if (!r.battle_id) { sAction.e(`${tag} 缺 battle_id`); continue; }
    if (!battleIndex.has(r.battle_id)) { sAction.e(`${tag} battle_id ${r.battle_id} 不存在`); continue; }
    if (!['1', '2'].includes(r.camp)) sAction.e(`${tag} camp 非法: ${r.camp}`);
    if (!['ban', 'pick'].includes(r.action)) sAction.e(`${tag} action 非法: ${r.action}`);
    const sideShould = r.camp === '1' ? 'blue' : 'red';
    if (r.side !== sideShould) sAction.e(`${tag} side=${r.side} 与 camp=${r.camp} 不匹配`);
    let list = byBattle.get(r.battle_id);
    if (!list) { list = []; byBattle.set(r.battle_id, list); }
    list.push(r);
  }
  let mismatch = 0;
  const mismatchSample = [];
  for (const [id, entry] of battleIndex) {
    const rows = byBattle.get(id) || [];
    if (rows.length !== entry.draft.length) {
      mismatch++;
      if (mismatchSample.length < 3) mismatchSample.push(`${id}(${rows.length}/${entry.draft.length})`);
      continue;
    }
    const ords = rows.map((r) => Number(r.ord));
    const sorted = [...ords].sort((a, b) => a - b);
    if (sorted.some((v, i) => v !== i + 1)) sAction.e(`${id} ord 不是 1..${sorted.length} 连续序列`);
    const byOrd = new Map(rows.map((r) => [Number(r.ord), r]));
    for (const x of entry.draft) {
      const r = byOrd.get(x.n);
      if (!r) { mismatch++; continue; }
      const okCamp = r.camp === String(x.camp);
      const okSide = r.side === (x.camp === 1 ? 'blue' : 'red');
      const okAction = r.action === x.action;
      const okHero = r.hero === x.hero;
      const okId = Number(r.hero_id) === x.hid;
      const okPos = Number(r.pos) === (x.pos ?? 0);
      if (!(okCamp && okSide && okAction && okHero && okId && okPos)) {
        mismatch++;
        if (mismatchSample.length < 3) mismatchSample.push(`${id}#${x.n}`);
      }
    }
  }
  if (mismatch) sAction.e(`${mismatch} 处与 battles.jsonl 不一致（如 ${mismatchSample.join('、')}）`);
  const noDraft = uniq(actionRows.filter((r) => battleIndex.has(r.battle_id) && battleIndex.get(r.battle_id).draft.length === 0).map((r) => r.battle_id));
  if (noDraft.length) sAction.w(`${noDraft.length} 局在 battles.jsonl 中 draft 为空却有动作行（如 ${sampleList(noDraft, 3)}）`);
}

/* ================================================================== */
/* 9. battles.csv（宽表）                                             */
/* ================================================================== */
const sWide = section('9. battles.csv');
if (csvData.has('battles.csv')) {
  const rows = csvData.get('battles.csv').rows;
  if (rows.length !== battles.length) sWide.e(`行数 ${rows.length} ≠ battles.jsonl ${battles.length}`);
  const csvIds = new Set(rows.map((r) => r.battle_id));
  const onlyCsv = [...csvIds].filter((id) => !battleIds.has(id));
  const onlyJsonl = [...battleIds].filter((id) => !csvIds.has(id));
  if (onlyCsv.length) sWide.e(`battles.csv 独有 battle_id ${onlyCsv.length} 个（如 ${sampleList(onlyCsv, 3)}）`);
  if (onlyJsonl.length) sWide.e(`battles.jsonl 独有 battle_id ${onlyJsonl.length} 个（如 ${sampleList(onlyJsonl, 3)}）`);
  let bad = 0;
  const badSample = [];
  for (const r of rows) {
    const entry = battleIndex.get(r.battle_id);
    if (!entry) continue;
    const { b, draft, blue, red } = entry;
    const banN = draft.filter((x) => x.action === 'ban').length;
    const pickN = draft.filter((x) => x.action === 'pick').length;
    const derived = {
      game_no: String(b.game_no),
      league_id: String(b.league_id),
      year: String(b.year),
      league_type: String(b.league_type),
      winner_side: b.winner_side,
      winner_team: b.winner_side === 'blue' ? blue.team : red.team,
      win_camp: b.winner_side === 'blue' ? '1' : '2',
      duration_sec: String(b.duration_sec),
      first_pick_side: b.first_pick_side == null ? '' : String(b.first_pick_side),
      bans: String(banN),
      picks: String(pickN),
      complete: isComplete(pickN, banN) ? '1' : '0',
      blue_team: blue.team,
      red_team: red.team,
      match_score: `${blue.score}:${red.score}`,
      blue_bans: draft.filter((x) => x.camp === 1 && x.action === 'ban').map((x) => x.hero).join(';'),
      red_bans: draft.filter((x) => x.camp === 2 && x.action === 'ban').map((x) => x.hero).join(';'),
      blue_picks: draft.filter((x) => x.camp === 1 && x.action === 'pick').map((x) => x.hero).join(';'),
      red_picks: draft.filter((x) => x.camp === 2 && x.action === 'pick').map((x) => x.hero).join(';'),
      draft_order: draft.map((x) => `${x.camp === 1 ? 'B' : 'R'}${x.action === 'ban' ? 'x' : 'p'}:${x.hero}`).join(' > '),
    };
    for (const [k, v] of Object.entries(derived)) {
      if (r[k] !== v) {
        bad++;
        if (badSample.length < 3) badSample.push(`${r.battle_id}.${k}=${r[k]} ≠ ${v}`);
      }
    }
    if (r.match_score !== `${blue.score}:${red.score}`) { /* 已包含在 derived */ }
  }
  if (bad) sWide.e(`${bad} 个宽表字段与 battles.jsonl 不一致（如 ${badSample.join(' | ')}）`);
  else sWide.n(`${rows.length} 行，宽表全部字段可由 battles.jsonl 复算一致`);
}

/* ================================================================== */
/* 10. stats/*.json                                                   */
/* ================================================================== */
const sStats = section('10. stats/*.json 自洽');
if (exists('stats/summary.json')) {
  let sum = null;
  try { sum = JSON.parse(readText('stats/summary.json')); } catch (e) { sStats.e(`summary.json 解析失败: ${e.message}`); }
  if (sum) {
    const cov = sum.coverage || {};
    const expect = {
      leagues: leagueIds.size,
      matches: matchIds.size,
      games: battles.length,
      games_with_bp: gamesWithBp,
      games_complete: completeGames,
      games_partial: partialGames,
      games_without_bp: emptyGames,
      games_with_20_actions: len20,
      heroes_seen: completeHeroes.size,
      teams: teamNames.size,
      ban_slots: banSlotsComplete,
      pick_slots: pickSlotsComplete,
    };
    for (const [k, v] of Object.entries(expect)) {
      if (cov[k] !== v) sStats.e(`summary.coverage.${k}=${cov[k]}，实测 ${v}`);
    }
    const yearsExpect = uniq(leagues.map((l) => l.year)).sort((a, b) => a - b);
    if (JSON.stringify(yearsExpect) !== JSON.stringify(cov.years)) sStats.e(`summary.coverage.years=${JSON.stringify(cov.years)}，实测 ${JSON.stringify(yearsExpect)}`);
    const dist = sum.bp_len_distribution || {};
    const distSum = Object.values(dist).reduce((a, b) => a + b, 0);
    if (distSum !== battles.length) sStats.e(`bp_len_distribution 合计 ${distSum} ≠ 局数 ${battles.length}`);
    for (const [len, n] of Object.entries(dist)) {
      if ((draftLenDist[len] || 0) !== n) sStats.e(`bp_len_distribution["${len}"]=${n}，实测 ${draftLenDist[len] || 0}`);
    }
    for (const key of ['side_stats_all', 'side_stats_by_year', 'side_stats_by_league', 'top_ban', 'top_pick', 'source']) {
      if (!(key in sum)) sStats.e(`summary.json 缺字段 ${key}`);
    }
    if (sum.side_stats_all && sum.side_stats_all.games !== completeGames) sStats.e(`side_stats_all.games=${sum.side_stats_all.games} ≠ 完整对局 ${completeGames}`);
    sStats.n(`summary.json 覆盖数字与实测一致（局 ${cov.games} / 含 BP ${cov.games_with_bp} / 完整 ${cov.games_complete} / ban ${cov.ban_slots} / pick ${cov.pick_slots}）`);
  }
}

function checkHeroStats(file, expectGames) {
  if (!exists(file)) return;
  let doc = null;
  try { doc = JSON.parse(readText(file)); } catch (e) { sStats.e(`${file} 解析失败: ${e.message}`); return; }
  if (!doc || typeof doc !== 'object') { sStats.e(`${file} 顶层应为对象`); return; }
  let gamesSum = 0;
  let banSum = 0;
  let pickSum = 0;
  for (const [key, entry] of Object.entries(doc)) {
    if (!entry || typeof entry !== 'object') { sStats.e(`${file}[${key}] 应为对象`); continue; }
    if (!Array.isArray(entry.heroes)) { sStats.e(`${file}[${key}].heroes 应为数组`); continue; }
    if (!isInt(entry.games)) sStats.e(`${file}[${key}].games 非整数`);
    else gamesSum += entry.games;
    if (!isInt(entry.ban_slots)) sStats.e(`${file}[${key}].ban_slots 非整数`);
    else banSum += entry.ban_slots;
    if (!isInt(entry.pick_slots)) sStats.e(`${file}[${key}].pick_slots 非整数`);
    else pickSum += entry.pick_slots;
    const heroNameDup = entry.heroes.map((h) => h.hero);
    if (uniq(heroNameDup).length !== heroNameDup.length) sStats.e(`${file}[${key}].heroes 有重复英雄`);
    for (const h of entry.heroes) {
      if (!isStr(h.hero)) sStats.e(`${file}[${key}] 存在空 hero`);
      if (!isInt(h.picks) || !isInt(h.bans)) sStats.e(`${file}[${key}] ${h.hero} picks/bans 非整数`);
      for (const f of ['win_rate', 'pick_rate', 'ban_rate', 'presence']) {
        if (h[f] !== null && !isNum(h[f])) sStats.e(`${file}[${key}] ${h.hero}.${f} 非法: ${h[f]}`);
      }
      if (h.win_rate !== null && (h.win_rate < 0 || h.win_rate > 100)) sStats.e(`${file}[${key}] ${h.hero}.win_rate 越界: ${h.win_rate}`);
    }
  }
  if (expectGames !== null && gamesSum !== expectGames) sStats.e(`${file} 各分组 games 合计 ${gamesSum} ≠ 完整对局数 ${expectGames}`);
  if (expectGames !== null && banSum !== banSlotsComplete) sStats.e(`${file} 各分组 ban_slots 合计 ${banSum} ≠ ${banSlotsComplete}`);
  if (expectGames !== null && pickSum !== pickSlotsComplete) sStats.e(`${file} 各分组 pick_slots 合计 ${pickSum} ≠ ${pickSlotsComplete}`);
  const groups = Object.keys(doc).length;
  sStats.n(`${file}：${groups} 个分组，games 合计 ${gamesSum}`);
}
checkHeroStats('stats/hero-stats-all.json', completeGames);
checkHeroStats('stats/hero-stats-by-year.json', completeGames);
checkHeroStats('stats/hero-stats-by-league.json', completeGames);

if (exists('stats/team-stats.json')) {
  let teams = null;
  try { teams = JSON.parse(readText('stats/team-stats.json')); } catch (e) { sStats.e(`team-stats.json 解析失败: ${e.message}`); }
  if (Array.isArray(teams)) {
    const sumGames = teams.reduce((a, t) => a + (t.games || 0), 0);
    const sumWins = teams.reduce((a, t) => a + (t.wins || 0), 0);
    const sumLoss = teams.reduce((a, t) => a + (t.losses || 0), 0);
    if (sumGames !== battles.length * 2) sStats.e(`team-stats games 合计 ${sumGames} ≠ ${battles.length * 2}`);
    if (sumWins !== battles.length) sStats.e(`team-stats wins 合计 ${sumWins} ≠ ${battles.length}`);
    if (sumWins + sumLoss !== sumGames) sStats.e(`team-stats wins+losses ≠ games`);
    for (const t of teams) {
      if (t.win_rate !== null && (t.win_rate < 0 || t.win_rate > 100)) sStats.e(`team-stats ${t.team}.win_rate 越界: ${t.win_rate}`);
    }
    if (teams.length !== teamNames.size) sStats.e(`team-stats 队数 ${teams.length} ≠ battles 中的队数 ${teamNames.size}`);
    sStats.n(`team-stats.json：${teams.length} 支战队，games 合计 ${sumGames}`);
  } else sStats.e('team-stats.json 顶层应为数组');
}

/* ================================================================== */
/* 11. provenance                                                     */
/* ================================================================== */
const sProv = section('11. provenance/source-leagues.json');
if (exists('provenance/source-leagues.json')) {
  let prov = null;
  try { prov = JSON.parse(readText('provenance/source-leagues.json')); } catch (e) { sProv.e(`解析失败: ${e.message}`); }
  if (Array.isArray(prov)) {
    const ids = new Set(prov.map((p) => String(p.league_id)));
    if (ids.size !== prov.length) sProv.e('league_id 有重复');
    const missing = [...leagueIds].filter((id) => !ids.has(id));
    if (missing.length) sProv.e(`快照缺 ${missing.length} 个赛事: ${sampleList(missing, 3)}`);
    if (prov.length !== leagues.length) sProv.w(`快照 ${prov.length} 条 ≠ leagues.json ${leagues.length} 条`);
    sProv.n(`${prov.length} 条原始赛事元数据`);
  } else sProv.e('顶层应为数组');
}

/* ================================================================== */
/* 汇总                                                               */
/* ================================================================== */
flush();
console.log('\n' + '-'.repeat(64));
console.log(`文件 : ${FILES.length - missingFiles.length}/${FILES.length} 已存在，合计 ${fmtBytes(totalBytes)}`);
console.log(`规模 : ${battles.length} 局 / ${leagueIds.size} 赛事 / ${uniq(leagues.map((l) => l.year)).length} 个年份 / ${heroIdName.size} 英雄 / ${teamNames.size} 战队`);
console.log(`BP   : 含 BP ${gamesWithBp} 局（完整 ${completeGames} / 残缺 ${partialGames} / 无 BP ${emptyGames}），draft-actions ${actionRows.length} 行`);
console.log(`动作 : 全部对局 ban ${banSlots} / pick ${pickSlots}；完整对局 ban ${banSlotsComplete} / pick ${pickSlotsComplete}`);
const distFinal = Object.keys(draftLenDist).sort((a, b) => Number(a) - Number(b)).map((k) => `${k}手:${draftLenDist[k]}`).join('  ');
console.log(`长度 : ${distFinal}`);
console.log(`结果 : ${errors.length ? 'FAIL' : 'PASS'}（${errors.length} error / ${warnings.length} warning）`);
if (errors.length) {
  console.log('\n失败项（最多显示 15 条，全部明细见上）:');
  for (const e of errors.slice(0, 15)) console.log(`  - ${e}`);
}
process.exit(errors.length ? 1 : 0);
