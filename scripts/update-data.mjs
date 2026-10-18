// Fetches upcoming games from ESPN's public (unofficial) scoreboard endpoints
// and writes them to data.js, which index.html loads.
//
// ESPN no longer reliably accepts date ranges (?dates=YYYYMMDD-YYYYMMDD), so this
// script requests one day at a time and combines the results.
//
// Usage: node scripts/update-data.mjs
// Requires Node 18+ (built-in fetch). No dependencies.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const OUT = fileURLToPath(new URL('../data.js', import.meta.url));
const BASE = 'https://site.api.espn.com/apis/site/v2/sports';

const TZ = 'America/Phoenix';   // defines what "today" means for the fetch window
const DAYS_BACK = 1;            // include yesterday so recent finals show up
const DAYS_AHEAD = 13;          // include this many days after today
const CONCURRENCY = 4;          // simultaneous ESPN requests
const RETRIES = 3;

export const LEAGUES = [
  { k: 'NFL',   path: 'football/nfl' },
  { k: 'NCAAF', path: 'football/college-football', groups: 80, college: true },        // FBS
  { k: 'MLB',   path: 'baseball/mlb' },
  { k: 'NBA',   path: 'basketball/nba' },
  { k: 'NHL',   path: 'hockey/nhl' },
  { k: 'NCAAM', path: 'basketball/mens-college-basketball', groups: 50, college: true } // Division I
];

/* ---------- date window (Arizona calendar days, not UTC) ---------- */

const keyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
export const localKey = (d) => keyFmt.format(d);                       // 'YYYY-MM-DD'
export const shiftKey = (key, n) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

// `start`/`end` are the local days we keep. `request` also includes one buffer day on each
// side, because ESPN may file a late-night game under a neighbouring date; anything outside
// start..end is filtered out after fetching.
export function buildWindow(now = new Date()) {
  const today = localKey(now);
  const start = shiftKey(today, -DAYS_BACK);
  const end = shiftKey(today, DAYS_AHEAD);
  const request = [];
  for (let k = shiftKey(start, -1); k <= shiftKey(end, 1); k = shiftKey(k, 1)) request.push(k.replace(/-/g, ''));
  return { start, end, request };
}
export const inWindow = (g, w) => {
  const k = localKey(new Date(g.t));
  return k >= w.start && k <= w.end;
};

/* ---------- parsing ---------- */

export function parseEvent(league, ev) {
  const comp = ev?.competitions?.[0];
  if (!comp || !Array.isArray(comp.competitors)) return null;
  const home = comp.competitors.find((c) => c.homeAway === 'home');
  const away = comp.competitors.find((c) => c.homeAway === 'away');
  if (!home?.team || !away?.team) return null;

  const statusName = ev.status?.type?.name || comp.status?.type?.name || '';
  if (/CANCEL/i.test(statusName)) return null;

  const t = new Date(ev.date);
  if (Number.isNaN(t.getTime())) return null;

  const label = (c) => {
    const name = league.college ? (c.team.location || c.team.shortDisplayName || c.team.displayName)
                                : c.team.displayName;
    const rank = c.curatedRank?.current;
    return league.college && rank && rank <= 25 ? `#${rank} ${name}` : name;
  };

  const g = {
    ...(ev.id ? { id: String(ev.id) } : {}),
    l: league.k,
    a: label(away),
    h: label(home),
    t: t.toISOString().replace(/\.\d{3}Z$/, 'Z')
  };

  const state = ev.status?.type?.state || comp.status?.type?.state; // pre | in | post
  const sa = parseInt(away.score, 10);
  const sh = parseInt(home.score, 10);
  if (state === 'post' && !Number.isNaN(sa) && !Number.isNaN(sh)) {
    g.sa = sa; g.sh = sh; g.st = 'final';
  } else if (state === 'in' && !Number.isNaN(sa) && !Number.isNaN(sh)) {
    g.sa = sa; g.sh = sh; g.st = 'live';
    const detail = ev.status?.type?.shortDetail || ev.status?.type?.detail;
    if (detail) g.c = detail;
  }

  if (/POSTPONED/i.test(statusName)) g.tag = 'Postponed';
  else if (comp.notes?.[0]?.headline) g.tag = String(comp.notes[0].headline);

  // TV channel(s): prefer national broadcasts, fall back to whatever is listed.
  let names = [];
  if (Array.isArray(comp.broadcasts)) {
    const national = comp.broadcasts.filter((b) => b.market === 'national' || b.market?.type === 'National');
    names = (national.length ? national : comp.broadcasts).flatMap((b) => b.names || []);
  }
  if (!names.length && typeof comp.broadcast === 'string' && comp.broadcast) names = [comp.broadcast];
  names = [...new Set(names)].slice(0, 3);
  if (names.length) g.tv = names.join(', ');

  const line = comp.odds?.[0]?.details;
  if (line && state === 'pre') g.line = String(line);

  return g;
}

/* ---------- fetching (one request per league per day) ---------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function fetchDay(league, day, fetchImpl = fetch, { retryDelayMs = 1500 } = {}) {
  const groups = league.groups ? `&groups=${league.groups}` : '';
  const url = `${BASE}/${league.path}/scoreboard?dates=${day}${groups}&limit=400`;
  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetchImpl(url, { headers: { 'User-Agent': 'sports-tracker-updater' } });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        // 4xx (except rate limiting) will not fix itself on retry.
        err.fatal = res.status >= 400 && res.status < 500 && res.status !== 429;
        throw err;
      }
      const json = await res.json();
      if (!Array.isArray(json.events)) throw new Error('unexpected response shape (no events array)');
      return json.events.map((ev) => parseEvent(league, ev)).filter(Boolean);
    } catch (err) {
      lastErr = err;
      if (err.fatal) break;
      if (attempt < RETRIES) await sleep(attempt * retryDelayMs);
    }
  }
  throw new Error(`${league.k} ${day}: ${lastErr.message}`);
}

// Returns every game found plus the list of days that failed.
export async function fetchLeague(league, window, fetchImpl = fetch, opts) {
  const failedDays = [];
  const perDay = await mapLimit(window.request, CONCURRENCY, async (day) => {
    try {
      return await fetchDay(league, day, fetchImpl, opts);
    } catch (err) {
      failedDays.push(day);
      console.warn(err.message);
      return [];
    }
  });

  // De-duplicate by ESPN event id (fall back to teams+time when an id is missing).
  const seen = new Set();
  const games = [];
  for (const g of perDay.flat()) {
    const key = gameKey(g);
    if (seen.has(key)) continue;
    seen.add(key);
    games.push(g);
  }
  return { games, failedDays };
}

const compositeKey = (g) => `${g.l}|${g.a}|${g.h}|${g.t}`;
export const gameKey = (g) => (g.id ? `${g.l}:${g.id}` : compositeKey(g));

/* ---------- merging with previous data ---------- */

// Use new data when the league loaded fully. Otherwise fill gaps from previous data,
// but only for games still inside the current window, so old games never linger.
export function mergeLeague(newGames, previousGames, window, { complete }) {
  const inside = newGames.filter((g) => inWindow(g, window));
  if (complete) return inside;

  const haveKeys = new Set(inside.map(gameKey));
  const haveComposite = new Set(inside.map(compositeKey));
  const fill = previousGames.filter(
    (g) => inWindow(g, window) && !haveKeys.has(gameKey(g)) && !haveComposite.has(compositeKey(g))
  );
  return [...inside, ...fill];
}

/* ---------- reading / writing data.js ---------- */

async function readExisting() {
  try {
    const txt = await readFile(OUT, 'utf8');
    const m = txt.match(/=\s*(\{[\s\S]*\})\s*;?\s*$/);
    if (!m) return { games: [], updated: {} };
    const json = JSON.parse(m[1]);
    return { games: json.games || [], updated: json.updated || {} };
  } catch {
    return { games: [], updated: {} };
  }
}

export function serialize(games, generated, updated = {}) {
  const body = games.map((g) => JSON.stringify(g)).join(',\n');
  return `window.SPORTS_DATA = {"generated":${JSON.stringify(generated)},"updated":${JSON.stringify(updated)},"games":[\n${body}\n]};\n`;
}

const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const annotate = (msg) => {
  if (process.env.GITHUB_ACTIONS) console.log(`::warning title=Schedule update::${msg}`);
};

/* ---------- main ---------- */

export async function main() {
  const now = new Date();
  const generated = iso(now);
  const window = buildWindow(now);
  const previous = await readExisting();
  console.log(`Window: ${window.start} to ${window.end} (${TZ}); requesting ${window.request.length} days per league`);

  let all = [];
  const updated = { ...previous.updated };
  const problems = [];
  let fullyLoaded = 0;

  for (const league of LEAGUES) {
    const { games, failedDays } = await fetchLeague(league, window);
    const complete = failedDays.length === 0;
    const merged = mergeLeague(games, previous.games.filter((g) => g.l === league.k), window, { complete });
    all.push(...merged);

    if (complete) {
      fullyLoaded++;
      updated[league.k] = generated;
      console.log(`${league.k}: ${merged.length} games`);
    } else {
      const msg = `${league.k}: ${failedDays.length} of ${window.request.length} days failed; kept earlier data for gaps (last full refresh ${updated[league.k] || 'never'})`;
      problems.push(msg);
      console.warn(msg);
    }
  }

  if (fullyLoaded === 0) {
    throw new Error('No league loaded completely; leaving data.js unchanged. ' + problems.join('; '));
  }

  all.sort((x, y) => x.t.localeCompare(y.t) || x.l.localeCompare(y.l) || x.a.localeCompare(y.a));
  await writeFile(OUT, serialize(all, generated, updated));
  console.log(`Wrote ${all.length} games to data.js`);
  problems.forEach(annotate);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    annotate(err.message);
    process.exit(1);
  });
}
