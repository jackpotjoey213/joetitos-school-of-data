import { NextResponse } from "next/server";

export const maxDuration = 30;

const PARK_FACTORS = {
  COL: 1.18, CIN: 1.08, TEX: 1.06, BOS: 1.05, CHC: 1.04, PHI: 1.03,
  BAL: 1.03, MIL: 1.02, ATL: 1.02, MIN: 1.01, ARI: 1.01,
  LAA: 1.00, DET: 1.00, CLE: 1.00, TOR: 0.99, WSH: 0.99,
  PIT: 0.99, KC: 0.98, SEA: 0.98, STL: 0.98, SF: 0.97,
  SD: 0.97, HOU: 0.97, NYY: 0.97, CHW: 0.96, TB: 0.96,
  NYM: 0.96, OAK: 0.95, MIA: 0.95, LAD: 0.96
};

// --- MLB STATS API ---
async function fetchMLBSchedule() {
  try {
    const today = new Date().toISOString().split("T")[0];
    const resp = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${today}&hydrate=probablePitcher(note),team`, { cache: "no-store" });
    if (!resp.ok) return { error: `MLB API ${resp.status}`, games: [] };
    const data = await resp.json();
    const games = [];
    for (const date of (data.dates || [])) {
      for (const g of (date.games || [])) {
        const away = g.teams?.away, home = g.teams?.home;
        games.push({
          gamePk: g.gamePk,
          awayTeam: away?.team?.abbreviation || "",
          homeTeam: home?.team?.abbreviation || "",
          awayPitcher: away?.probablePitcher ? { name: away.probablePitcher.fullName, id: away.probablePitcher.id } : null,
          homePitcher: home?.probablePitcher ? { name: home.probablePitcher.fullName, id: home.probablePitcher.id } : null,
        });
      }
    }
    return { games };
  } catch (e) { return { error: e.message, games: [] }; }
}

async function fetchPitcherStats(pitcherId) {
  if (!pitcherId) return null;
  try {
    const resp = await fetch(`https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=season&season=2026&group=pitching`, { cache: "no-store" });
    if (!resp.ok) return null;
    const data = await resp.json();
    const s = data.stats?.[0]?.splits?.[0]?.stat;
    if (!s) return null;
    return { era: s.era || "0.00", whip: s.whip || "0.00", wins: s.wins || 0, losses: s.losses || 0, strikeOuts: s.strikeOuts || 0, inningsPitched: s.inningsPitched || "0.0", homeRuns: s.homeRuns || 0, walks: s.baseOnBalls || 0, gamesStarted: s.gamesStarted || 0 };
  } catch { return null; }
}

async function fetchMLBOdds() {
  const key = process.env.ODDS_API_KEY;
  if (!key) return { error: "No key", games: [] };
  try {
    const resp = await fetch(`https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${key}&regions=us&markets=totals,spreads,h2h&oddsFormat=american`);
    const remaining = resp.headers.get("x-requests-remaining");
    if (!resp.ok) return { error: `${resp.status}`, games: [], remaining };
    return { games: await resp.json() || [], remaining };
  } catch (e) { return { error: e.message, games: [] }; }
}

function fuzzyMatch(a, b) {
  if (!a || !b) return false;
  const x = a.toLowerCase().replace(/[^a-z0-9]/g, " ").trim();
  const y = b.toLowerCase().replace(/[^a-z0-9]/g, " ").trim();
  if (x.includes(y) || y.includes(x)) return true;
  return x.split(/\s+/).filter(w => w.length > 3).some(w => y.split(/\s+/).filter(v => v.length > 3).includes(w));
}

function parseOddsForGame(oddsGames, awayName, homeName, awayAbbr, homeAbbr) {
  if (!oddsGames?.length) return null;
  let match = oddsGames.find(og => (fuzzyMatch(og.away_team, awayName) || fuzzyMatch(og.away_team, awayAbbr)) && (fuzzyMatch(og.home_team, homeName) || fuzzyMatch(og.home_team, homeAbbr)));
  if (!match) match = oddsGames.find(og => fuzzyMatch(og.away_team, awayName) || fuzzyMatch(og.home_team, homeName));
  if (!match) return null;

  let cTotal = 0, tCount = 0, minT = 999, maxT = 0, sLine = 0, sCount = 0, favTeam = "", awayML = 0, homeML = 0;
  for (const bm of (match.bookmakers || [])) {
    for (const mkt of (bm.markets || [])) {
      if (mkt.key === "totals") for (const oc of (mkt.outcomes || [])) { if (oc.name === "Over" && oc.point) { cTotal += oc.point; tCount++; if (oc.point < minT) minT = oc.point; if (oc.point > maxT) maxT = oc.point; } }
      if (mkt.key === "spreads") for (const oc of (mkt.outcomes || [])) { if (oc.point && oc.point < 0) { sLine += Math.abs(oc.point); sCount++; favTeam = oc.name; } }
      if (mkt.key === "h2h") for (const oc of (mkt.outcomes || [])) { if (fuzzyMatch(oc.name, awayName) || fuzzyMatch(oc.name, awayAbbr)) awayML = oc.price; if (fuzzyMatch(oc.name, homeName) || fuzzyMatch(oc.name, homeAbbr)) homeML = oc.price; }
    }
  }
  return {
    consensusTotal: tCount > 0 ? Math.round((cTotal / tCount) * 10) / 10 : 0, numBooks: tCount,
    totalRange: { min: minT < 999 ? minT : 0, max: maxT },
    spreadLine: sCount > 0 ? Math.round((sLine / sCount) * 10) / 10 : 0,
    favTeam: favTeam ? (fuzzyMatch(favTeam, homeName) || fuzzyMatch(favTeam, homeAbbr) ? homeAbbr : awayAbbr) : "",
    awayML, homeML
  };
}

// Convert American ML to implied win probability
function mlToProb(ml) {
  if (!ml) return 0.5;
  if (ml < 0) return Math.abs(ml) / (Math.abs(ml) + 100);
  return 100 / (ml + 100);
}

export async function POST(req) {
  const { games, lockedPredictions } = await req.json();
  const locked = lockedPredictions || {};

  // Fetch Odds + MLB pitcher data in parallel
  const [oddsData, mlbData] = await Promise.all([fetchMLBOdds(), fetchMLBSchedule()]);

  const gameSummaries = games.map(g => {
    const odds = parseOddsForGame(oddsData.games, g.away, g.home, g.awayAbbr, g.homeAbbr);
    const mlbGame = mlbData.games?.find(mg =>
      fuzzyMatch(mg.awayTeam, g.awayAbbr) || fuzzyMatch(mg.homeTeam, g.homeAbbr) ||
      fuzzyMatch(mg.awayTeam, g.away) || fuzzyMatch(mg.homeTeam, g.home)
    );
    return { ...g, liveOdds: odds, mlbInfo: mlbGame || null };
  });

  const gamesToAnalyze = gameSummaries.filter(g => g.status !== "final" && g.status !== "live" && !locked[g.id]);

  // Fetch pitcher stats for all games in parallel
  const pitcherPromises = [];
  for (const g of gamesToAnalyze) {
    if (g.mlbInfo?.awayPitcher?.id) pitcherPromises.push(fetchPitcherStats(g.mlbInfo.awayPitcher.id).then(s => ({ gameId: g.id, side: "away", stats: s, name: g.mlbInfo.awayPitcher.name })));
    if (g.mlbInfo?.homePitcher?.id) pitcherPromises.push(fetchPitcherStats(g.mlbInfo.homePitcher.id).then(s => ({ gameId: g.id, side: "home", stats: s, name: g.mlbInfo.homePitcher.name })));
  }
  const pitcherResults = await Promise.all(pitcherPromises);
  const pitcherMap = {};
  for (const pr of pitcherResults) {
    if (!pitcherMap[pr.gameId]) pitcherMap[pr.gameId] = {};
    pitcherMap[pr.gameId][pr.side] = { name: pr.name, ...(pr.stats || {}) };
  }

  const results = gameSummaries.map(g => {
    const odds = g.liveOdds, status = g.status;

    // Final/live with lock
    if ((status === "final" || status === "live") && locked[g.id]) {
      return { id: g.id, status, sport: "mlb", awayScore: g.liveScore?.away ?? null, homeScore: g.liveScore?.home ?? null, clock: g.liveScore?.clock || "", currentTotal: locked[g.id].line || g.total, currentSpread: null, oddsRange: null, numBooks: 0, oddsSpread: null, oddsTotal: null, oddsML: null, consensus: locked[g.id].consensus || null, lockedPrediction: locked[g.id], isNewPrediction: false, injuries: null };
    }
    if (status === "final" || status === "live") {
      return { id: g.id, status, sport: "mlb", awayScore: g.liveScore?.away ?? null, homeScore: g.liveScore?.home ?? null, clock: g.liveScore?.clock || "", currentTotal: odds?.consensusTotal || g.total, currentSpread: odds?.favTeam ? `${odds.favTeam} -${odds.spreadLine}` : null, oddsRange: odds?.totalRange || null, numBooks: odds?.numBooks || 0, oddsSpread: odds?.favTeam ? { fav: odds.favTeam, line: -odds.spreadLine } : null, oddsTotal: odds?.consensusTotal || null, oddsML: (odds?.awayML || odds?.homeML) ? { away: odds.awayML, home: odds.homeML } : null, consensus: null, lockedPrediction: null, noPregamePrediction: true, isNewPrediction: false, injuries: null };
    }

    // --- SCHEDULED: Build prediction from pitcher model ---
    const pm = pitcherMap[g.id] || {};
    const currentTotal = odds?.consensusTotal || g.total || 8.5;
    const parkFactor = PARK_FACTORS[g.homeAbbr] || 1.0;

    // Pitcher ERA model
    const awayERA = parseFloat(pm.away?.era) || 4.50;
    const homeERA = parseFloat(pm.home?.era) || 4.50;
    const awayWHIP = parseFloat(pm.away?.whip) || 1.35;
    const homeWHIP = parseFloat(pm.home?.whip) || 1.35;
    const hasPitcherData = !!(pm.away?.name || pm.home?.name);

    // Project runs: each pitcher's ERA predicts runs allowed
    // Away pitcher faces home team, home pitcher faces away team
    // Adjust for park factor and scale (ERA is per 9 innings, starters go ~5.5 innings avg)
    const awayPitcherRuns = (awayERA / 9) * 5.5;  // Runs away pitcher allows (to home team)
    const homePitcherRuns = (homeERA / 9) * 5.5;   // Runs home pitcher allows (to away team)
    const bullpenRunsPerGame = 1.8; // Average bullpen contribution per side
    
    const homeTeamRuns = Math.round((awayPitcherRuns + bullpenRunsPerGame * 0.9) * parkFactor * 10) / 10;
    const awayTeamRuns = Math.round((homePitcherRuns + bullpenRunsPerGame * 1.0) * 10) / 10; // Away team gets no park boost
    const modelTotal = Math.round((homeTeamRuns + awayTeamRuns) * 10) / 10;

    // Moneyline implied probability for win projection
    const awayWinProb = mlToProb(odds?.awayML);
    const homeWinProb = mlToProb(odds?.homeML);

    // --- VOTING ---
    let overW = 0, underW = 0;
    const reasons = [];

    if (odds?.consensusTotal && odds.numBooks >= 2) {
      reasons.push(`Odds API: ${odds.numBooks} books avg ${odds.consensusTotal} (${odds.totalRange?.min}-${odds.totalRange?.max})`);
    }

    // Pitcher model (3.0x weight when we have data, 0 when we don't)
    if (hasPitcherData && Math.abs(modelTotal - currentTotal) >= 0.3) {
      if (modelTotal > currentTotal) { overW += 3.0; reasons.push(`Pitcher model: ${modelTotal} > line ${currentTotal} (ERA: ${awayERA}/${homeERA})`); }
      else { underW += 3.0; reasons.push(`Pitcher model: ${modelTotal} < line ${currentTotal} (ERA: ${awayERA}/${homeERA})`); }
    }

    // WHIP signal (1.5x) - high WHIP = more baserunners = more runs
    if (hasPitcherData) {
      const combinedWHIP = (awayWHIP + homeWHIP) / 2;
      if (combinedWHIP > 1.35 && currentTotal <= 8.5) { overW += 1.0; reasons.push(`WHIP signal: combined ${combinedWHIP.toFixed(2)} (high baserunners)`); }
      else if (combinedWHIP < 1.10 && currentTotal >= 8.0) { underW += 1.0; reasons.push(`WHIP signal: combined ${combinedWHIP.toFixed(2)} (low baserunners)`); }
    }

    // Park factor (1.5x)
    if (parkFactor >= 1.05) { overW += 1.5; reasons.push(`Park: ${g.homeAbbr} +${((parkFactor-1)*100).toFixed(0)}% hitter-friendly`); }
    else if (parkFactor <= 0.96) { underW += 1.5; reasons.push(`Park: ${g.homeAbbr} -${((1-parkFactor)*100).toFixed(0)}% pitcher-friendly`); }

    // Pitcher info (not a vote, just display)
    if (pm.away?.name) reasons.push(`${g.awayAbbr} SP: ${pm.away.name} (${pm.away.era} ERA, ${pm.away.whip} WHIP, ${pm.away.wins}-${pm.away.losses})`);
    else reasons.push(`${g.awayAbbr} SP: TBD`);
    if (pm.home?.name) reasons.push(`${g.homeAbbr} SP: ${pm.home.name} (${pm.home.era} ERA, ${pm.home.whip} WHIP, ${pm.home.wins}-${pm.home.losses})`);
    else reasons.push(`${g.homeAbbr} SP: TBD`);

    const totalW = overW + underW;
    const call = overW > underW ? "OVER" : underW > overW ? "UNDER" : "TOSS-UP";
    const agree = totalW > 0 ? (Math.max(overW, underW) / totalW) : 0.5;
    const sigCount = reasons.filter(r => !r.startsWith("Odds API:") && !r.includes(" SP:")).length;
    const coverage = Math.min(1, sigCount / 2);
    const edge = Math.abs(modelTotal - currentTotal);
    let edgeScore = 0.5;
    if (edge >= 0.3 && edge <= 1.5) edgeScore = 0.9;
    else if (edge > 1.5 && edge <= 2.5) edgeScore = 0.7;
    else if (edge > 2.5) edgeScore = 0.4; // Suspicious for MLB
    else edgeScore = 0.3;
    const strength = Math.min(88, Math.max(28, Math.round((agree * 30) + (coverage * 30) + (edgeScore * 20) + (hasPitcherData ? 10 : 0))));

    // Moneyline pick: favor the team with better pitcher + home field
    let mlPick = null, mlReason = "";
    if (hasPitcherData) {
      const eraGap = awayERA - homeERA; // positive = home pitcher better
      if (eraGap > 0.8) { mlPick = g.homeAbbr; mlReason = `${g.homeAbbr} SP has ${eraGap.toFixed(2)} ERA advantage + home field`; }
      else if (eraGap < -0.8) { mlPick = g.awayAbbr; mlReason = `${g.awayAbbr} SP has ${Math.abs(eraGap).toFixed(2)} ERA advantage on road`; }
      else if (homeWinProb > 0.58) { mlPick = g.homeAbbr; mlReason = `${g.homeAbbr} implied ${(homeWinProb*100).toFixed(0)}% win prob + home field`; }
      else if (awayWinProb > 0.55) { mlPick = g.awayAbbr; mlReason = `${g.awayAbbr} implied ${(awayWinProb*100).toFixed(0)}% despite road`; }
    } else if (homeWinProb > 0.55) {
      mlPick = g.homeAbbr; mlReason = `${g.homeAbbr} ML favorite (${(homeWinProb*100).toFixed(0)}%)`;
    }

    // Run line pick: only pick fav -1.5 if pitcher matchup is dominant
    let rlPick = null, rlReason = "";
    if (hasPitcherData) {
      const eraGap = Math.abs(awayERA - homeERA);
      const favByERA = awayERA > homeERA ? g.homeAbbr : g.awayAbbr;
      if (eraGap > 1.5) { rlPick = favByERA; rlReason = `${favByERA} SP dominates (${eraGap.toFixed(2)} ERA gap)`; }
      else if (eraGap > 1.0 && homeWinProb > 0.6) { rlPick = g.homeAbbr; rlReason = `${g.homeAbbr} strong SP + ${(homeWinProb*100).toFixed(0)}% implied`; }
    }

    return {
      id: g.id, status: g.status, sport: "mlb",
      awayScore: g.liveScore?.away ?? null, homeScore: g.liveScore?.home ?? null,
      clock: g.liveScore?.clock || null, currentTotal,
      currentSpread: odds?.favTeam ? `${odds.favTeam} -${odds.spreadLine}` : null,
      oddsRange: odds?.totalRange || null, numBooks: odds?.numBooks || 0,
      oddsSpread: odds?.favTeam ? { fav: odds.favTeam, line: -odds.spreadLine } : null,
      oddsTotal: odds?.consensusTotal || null,
      oddsML: (odds?.awayML || odds?.homeML) ? { away: odds.awayML || 0, home: odds.homeML || 0 } : null,
      consensus: {
        totalCall: call, strength,
        spreadCall: rlPick, spreadReason: rlReason,
        moneylinePick: mlPick, moneylineReason: mlReason,
        votes: { over: overW.toFixed(1), under: underW.toFixed(1) }, reasons,
        modelTotal,
        modelSpread: Math.round((homeTeamRuns - awayTeamRuns) * 10) / 10,
        awayPts: Math.round(awayTeamRuns), homePts: Math.round(homeTeamRuns),
        projPace: null, tournamentRound: null, tournamentDiscount: null,
        liveProjectedTotal: null, awayKenPom: null, homeKenPom: null,
        recentFormTotal: 0, edgeSize: edge.toFixed(1),
        awayPitcher: pm.away || null, homePitcher: pm.home || null,
        parkFactor: parkFactor !== 1.0 ? parkFactor : null,
        awayWinProb: (awayWinProb * 100).toFixed(0),
        homeWinProb: (homeWinProb * 100).toFixed(0)
      },
      isNewPrediction: true, injuries: null
    };
  });

  return NextResponse.json({
    updates: results, analyzedCount: gamesToAnalyze.length, sport: "mlb",
    sources: {
      oddsAPI: oddsData.error ? `x ${oddsData.error}` : `OK ${oddsData.games.length} games (${oddsData.remaining} req left)`,
      mlbStatsAPI: mlbData.error ? `x ${mlbData.error}` : `OK ${mlbData.games.length} games`,
      pitchers: `${Object.keys(pitcherMap).length} games with pitcher data`
    }
  });
}
