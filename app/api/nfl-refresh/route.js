import { NextResponse } from "next/server";
import { buildNFLPrediction, mlToProb } from "@/lib/nflModel";
import { fetchGameWeather, weatherTotalAdjustment, NFL_STADIUMS } from "@/lib/weather";

export const maxDuration = 60;

const TM = {
  ARI: "ARI", ATL: "ATL", BAL: "BAL", BUF: "BUF", CAR: "CAR", CHI: "CHI",
  CIN: "CIN", CLE: "CLE", DAL: "DAL", DEN: "DEN", DET: "DET", GB: "GB",
  HOU: "HOU", IND: "IND", JAX: "JAX", KC: "KC", LAC: "LAC", LAR: "LAR",
  LV: "LV", MIA: "MIA", MIN: "MIN", NE: "NE", NO: "NO", NYG: "NYG",
  NYJ: "NYJ", PHI: "PHI", PIT: "PIT", SEA: "SEA", SF: "SF", TB: "TB",
  TEN: "TEN", WAS: "WAS", WSH: "WAS",
};
function norm(a) { return a ? TM[a.toUpperCase()] || a.toUpperCase() : ""; }
function fuzzy(a, b) {
  if (!a || !b) return false;
  const x = a.toLowerCase().replace(/[^a-z0-9]/g, " ").trim();
  const y = b.toLowerCase().replace(/[^a-z0-9]/g, " ").trim();
  if (x === y || x.includes(y) || y.includes(x)) return true;
  return x.split(/\s+/).filter((w) => w.length > 3).some((w) => y.split(/\s+/).filter((v) => v.length > 3).includes(w));
}

async function fetchNFLTeamStats() {
  try {
    // NOTE: the standings endpoint is apis/v2, NOT apis/site/v2 — the
    // /site/v2 path returns 404 ("Event ID 'null' not found"), which is
    // why every team previously came back "unavailable".
    const resp = await fetch("https://site.api.espn.com/apis/v2/sports/football/nfl/standings", { cache: "no-store" });
    if (!resp.ok) return { error: `${resp.status}`, teams: {} };
    const data = await resp.json();
    const teams = {};
    const walk = (node) => {
      for (const entry of (node?.standings?.entries || [])) {
        const abbr = norm(entry.team?.abbreviation || "");
        const stats = {};
        for (const s of (entry.stats || [])) stats[s.name] = parseFloat(s.value) || 0;
        // ESPN NFL standings give season TOTALS (pointsFor/pointsAgainst),
        // not per-game averages. Divide by games played (wins+losses+ties).
        const w = stats.wins || 0, l = stats.losses || 0, t = stats.ties || 0, gp = w + l + t || 1;
        const ppg = stats.pointsFor ? stats.pointsFor / gp : (stats.avgPointsFor || 0);
        const oppg = stats.pointsAgainst ? stats.pointsAgainst / gp : (stats.avgPointsAgainst || 0);
        const info = { w, l, gp, ppg: +ppg.toFixed(1), oppg: +oppg.toFixed(1) };
        if (abbr && (ppg || oppg)) teams[abbr] = info;
        const name = (entry.team?.displayName || "").toLowerCase();
        if (name && (ppg || oppg)) teams[name] = info;
      }
      for (const c of (node?.children || [])) walk(c);
    };
    walk(data);
    return { teams };
  } catch (e) { return { error: e.message, teams: {} }; }
}

async function fetchRecentNFLDates() {
  // Map team -> list of dates played in the last 14 days, for rest/bye detection.
  // Parallel: the old sequential loop (14 ESPN scoreboard fetches, one
  // after another) is why this route took ~64s on Vercel, where each
  // fetch is slower than locally — the UI then still showed dashes
  // because the refresh had not finished when the browser looked.
  const dates = [];
  for (let i = 1; i <= 14; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    dates.push(d);
  }
  const results = await Promise.all(dates.map(async (d) => {
    const ds = d.toISOString().split("T")[0].replace(/-/g, "");
    try {
      const resp = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${ds}&limit=100`, { cache: "no-store" });
      if (!resp.ok) return null;
      return await resp.json();
    } catch { return null; }
  }));
  const schedule = {};
  for (let idx = 0; idx < results.length; idx++) {
    const data = results[idx];
    if (!data) continue;
    const d = dates[idx];
    for (const ev of (data.events || [])) {
      const comp = ev.competitions?.[0];
      if (!comp) continue;
      for (const t of (comp.competitors || [])) {
        const abbr = norm(t.team?.abbreviation || "");
        if (abbr) { if (!schedule[abbr]) schedule[abbr] = []; schedule[abbr].push(d.toISOString().split("T")[0]); }
      }
    }
  }
  return schedule;
}

function restInfo(schedule, abbr) {
  const dates = schedule[norm(abbr)] || [];
  if (!dates.length) return { isBye: true, daysSinceLast: null };
  const last = new Date(dates.sort().reverse()[0]);
  const days = Math.round((Date.now() - last.getTime()) / 86400000);
  return { isShortWeek: days < 5, isBye: false, daysSinceLast: days };
}

function travelMiles(awayAbbr, homeAbbr) {
  const a = NFL_STADIUMS[norm(awayAbbr)], h = NFL_STADIUMS[norm(homeAbbr)];
  if (!a || !h) return 0;
  const toRad = (x) => (x * Math.PI) / 180;
  const R = 3959;
  const dLat = toRad(h.lat - a.lat), dLon = toRad(h.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(h.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)));
}

async function fetchNFLOdds() {
  const key = process.env.ODDS_API_KEY;
  if (!key) return { error: "No key", games: [] };
  try {
    const r = await fetch(`https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds/?apiKey=${key}&regions=us&markets=totals,spreads,h2h&oddsFormat=american`);
    if (!r.ok) return { error: `odds ${r.status}`, games: [] };
    const games = await r.json() || [];
    return { games, remaining: r.headers.get("x-requests-remaining") };
  } catch (e) { return { error: e.message, games: [] }; }
}

function parseOdds(og, aN, hN, aA, hA) {
  if (!og?.length) return null;
  let m = og.find((o) => (fuzzy(o.away_team, aN) || fuzzy(o.away_team, aA)) && (fuzzy(o.home_team, hN) || fuzzy(o.home_team, hA)));
  if (!m) m = og.find((o) => fuzzy(o.away_team, aN) || fuzzy(o.home_team, hN));
  if (!m) return null;
  let cT = 0, tC = 0, mn = 999, mx = 0, sL = 0, sC = 0, fv = "", aM = 0, hM = 0;
  for (const b of (m.bookmakers || [])) for (const k of (b.markets || [])) {
    if (k.key === "totals") for (const o of (k.outcomes || [])) if (o.name === "Over" && o.point) { cT += o.point; tC++; if (o.point < mn) mn = o.point; if (o.point > mx) mx = o.point; }
    if (k.key === "spreads") for (const o of (k.outcomes || [])) if (o.point && o.point < 0) { sL += Math.abs(o.point); sC++; fv = o.name; }
    if (k.key === "h2h") for (const o of (k.outcomes || [])) { if (fuzzy(o.name, aN) || fuzzy(o.name, aA)) aM = o.price; if (fuzzy(o.name, hN) || fuzzy(o.name, hA)) hM = o.price; }
  }
  return { total: tC > 0 ? Math.round((cT / tC) * 10) / 10 : 0, books: tC, range: { min: mn < 999 ? mn : 0, max: mx }, spread: sC > 0 ? Math.round((sL / sC) * 10) / 10 : 0, fav: fv ? (fuzzy(fv, hN) || fuzzy(fv, hA) ? hA : aA) : "", awayML: aM, homeML: hM };
}

export async function POST(req) {
  const { games, lockedPredictions } = await req.json();
  const locked = lockedPredictions || {};
  const [oddsData, teamData, recentGames] = await Promise.all([fetchNFLOdds(), fetchNFLTeamStats(), fetchRecentNFLDates()]);
  const teamStats = teamData.teams || {};

  const results = [];
  // Weather (NFL only, domes skipped inside fetchGameWeather) — fetched
  // in parallel up front, not one-by-one inside the loop below. The old
  // sequential per-game weather fetches (14 more requests, one after
  // another) were the other half of the ~64s Vercel refresh time.
  const weatherList = await Promise.all(games.map((g) => {
    // Locked/final games never reach the weather code below (early
    // continue), so skip their forecast fetches entirely.
    if (locked[g.espnId || g.id] || g.status === "final") return null;
    return fetchGameWeather(g.homeAbbr, g.startTime);
  }));
  for (let gi = 0; gi < games.length; gi++) {
    const g = games[gi];
    const odds = parseOdds(oddsData.games, g.away, g.home, g.awayAbbr, g.homeAbbr);
    const awayTeam = teamStats[norm(g.awayAbbr)] || teamStats[g.away?.toLowerCase()];
    const homeTeam = teamStats[norm(g.homeAbbr)] || teamStats[g.home?.toLowerCase()];
    const hasTeamData = !!(awayTeam?.ppg && homeTeam?.ppg);
    const lockKey = g.espnId || g.id;
    const status = g.status;
    const base = {
      id: g.id, espnId: g.espnId, status, sport: "nfl",
      awayScore: g.liveScore?.away ?? null, homeScore: g.liveScore?.home ?? null,
      clock: g.liveScore?.clock || "", period: g.liveScore?.period ?? null,
      currentTotal: odds?.total || g.total, currentSpread: odds?.fav ? `${odds.fav} -${odds.spread}` : null,
      oddsRange: odds?.range || null, numBooks: odds?.books || 0,
      oddsSpread: odds?.fav ? { fav: odds.fav, line: -odds.spread } : null,
      oddsTotal: odds?.total || null,
      oddsML: (odds?.awayML || odds?.homeML) ? { away: odds.awayML, home: odds.homeML } : null,
      injuries: null,
    };
    if (locked[lockKey]) { results.push({ ...base, consensus: locked[lockKey].consensus || null, lockedPrediction: locked[lockKey], isNewPrediction: false }); continue; }
    if (status === "final") { results.push({ ...base, consensus: null, lockedPrediction: null, noPregamePrediction: true, isNewPrediction: false }); continue; }

    // Weather (NFL only, domes skipped inside fetchGameWeather).
    const weather = weatherList[gi];
    const wAdj = weatherTotalAdjustment(weather);
    const rest = { away: restInfo(recentGames, g.awayAbbr), home: restInfo(recentGames, g.homeAbbr) };
    const miles = travelMiles(g.awayAbbr, g.homeAbbr);
    const lineTotal = odds?.total || 0;
    const pred = buildNFLPrediction({
      awayPPG: awayTeam?.ppg, homePPG: homeTeam?.ppg, awayOPPG: awayTeam?.oppg, homeOPPG: homeTeam?.oppg,
      gamesPlayed: Math.min(awayTeam?.gp || 0, homeTeam?.gp || 0),
      lineTotal, lineSpread: odds?.spread || 0, spreadFav: odds?.fav || "",
      homeAbbr: g.homeAbbr, awayAbbr: g.awayAbbr, awayML: odds?.awayML || 0, homeML: odds?.homeML || 0,
      rest, travelMiles: miles, weatherAdj: wAdj.points,
    });
    const noPick = !hasTeamData || !lineTotal;
    const consensus = {
      ...pred,
      // Never present a generic league-average total as a team-specific
      // prediction: if team stats are genuinely missing, the model
      // points/total/spread are null, not a made-up 43.
      ...(!hasTeamData ? { modelTotal: null, awayPts: null, homePts: null, modelSpread: null, spreadCall: null, moneylinePick: null } : {}),
      totalCall: noPick ? null : pred.totalCall,
      noPick,
      noPickReason: !hasTeamData ? "Stats unavailable" : !lineTotal ? "No Odds line" : null,
      reasons: [...pred.reasons, ...wAdj.reasons, ...(weather.ok && !weather.dome ? [`Weather ${weather.stadium}: ${weather.tempF != null ? Math.round(weather.tempF) + "F" : ""} wind ${weather.windMph != null ? Math.round(weather.windMph) + " mph" : "?"}`] : weather.dome ? [`${weather.stadium} (dome) — weather skipped`] : ["Weather unavailable"])],
      dataSources: [
        `ESPN standings: ${g.awayAbbr} ${awayTeam ? `${awayTeam.ppg} PPG / ${awayTeam.oppg} OPPG` : "unavailable"} / ${g.homeAbbr} ${homeTeam ? `${homeTeam.ppg} PPG / ${homeTeam.oppg} OPPG` : "unavailable"}`,
        odds?.books ? `Odds API: ${odds.books} books, total ${odds.total} (${odds.range.min}-${odds.range.max})` : "Odds API: no line",
        `Rest: ${g.awayAbbr} ${rest.away.isShortWeek ? "short week" : rest.away.isBye ? "bye" : `${rest.away.daysSinceLast ?? "?"}d since last`} / ${g.homeAbbr} ${rest.home.isShortWeek ? "short week" : rest.home.isBye ? "bye" : `${rest.home.daysSinceLast ?? "?"}d since last`}`,
      ],
      weather: weather.ok ? weather : null,
    };
    results.push({
      ...base, currentTotal: lineTotal || g.total, consensus,
      isNewPrediction: status === "scheduled" || status === undefined,
    });
  }

  return NextResponse.json({
    updates: results, analyzedCount: results.filter((r) => r.isNewPrediction).length, sport: "nfl",
    sources: {
      oddsAPI: oddsData.error ? `x ${oddsData.error}` : `OK ${oddsData.games?.length} (${oddsData.remaining} left)`,
      espnStats: teamData.error ? `x ${teamData.error}` : `OK ${Object.keys(teamStats).length} entries`,
      weather: "Open-Meteo (domes skipped)",
    },
  });
}
