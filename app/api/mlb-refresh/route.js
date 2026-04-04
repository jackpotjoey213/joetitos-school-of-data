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

// Complete MLB abbreviation normalization (ESPN, MLB Stats API, Odds API all use different abbrs)
const TEAM_MAP = {
  // Standard
  "ARI": "ARI", "AZ": "ARI", "ATL": "ATL", "BAL": "BAL", "BOS": "BOS",
  "CHC": "CHC", "CUB": "CHC", "CUBS": "CHC",
  "CHW": "CWS", "CWS": "CWS", "SOX": "CWS", "WHITESOX": "CWS",
  "CIN": "CIN", "CLE": "CLE", "COL": "COL",
  "DET": "DET", "HOU": "HOU", "KC": "KC", "KCR": "KC",
  "LAA": "LAA", "ANA": "LAA", "ANGELS": "LAA",
  "LAD": "LAD", "DODGERS": "LAD",
  "MIA": "MIA", "FLA": "MIA", "MARLINS": "MIA",
  "MIL": "MIL", "MIN": "MIN",
  "NYM": "NYM", "METS": "NYM",
  "NYY": "NYY", "YANKEES": "NYY",
  "OAK": "OAK", "ATH": "OAK", "ATHLETICS": "OAK",
  "PHI": "PHI", "PIT": "PIT",
  "SD": "SD", "SDP": "SD", "PADRES": "SD",
  "SF": "SF", "SFG": "SF", "GIANTS": "SF",
  "SEA": "SEA", "STL": "STL", "CARDINALS": "STL",
  "TB": "TB", "TBR": "TB", "RAYS": "TB",
  "TEX": "TEX", "RANGERS": "TEX",
  "TOR": "TOR", "BLUEJAYS": "TOR",
  "WSH": "WSH", "WAS": "WSH", "NATIONALS": "WSH",
};
function normalizeAbbr(a) { if (!a) return ""; return TEAM_MAP[a.toUpperCase()] || a.toUpperCase(); }

async function fetchMLBPitchers() {
  try {
    const today = new Date().toISOString().split("T")[0];
    const resp = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${today}&hydrate=probablePitcher(note),team`, { cache: "no-store" });
    if (!resp.ok) return { error: `MLB API ${resp.status}`, pitchersByTeam: {}, rawGames: 0 };
    const data = await resp.json();
    
    // Build a lookup: any team identifier -> pitcher info
    const pitchersByTeam = {};
    let gameCount = 0, pitcherCount = 0;
    
    for (const date of (data.dates || [])) {
      for (const g of (date.games || [])) {
        gameCount++;
        for (const side of ["away", "home"]) {
          const team = g.teams?.[side];
          const pitcher = team?.probablePitcher;
          if (!pitcher) continue;
          pitcherCount++;
          const info = { name: pitcher.fullName, id: pitcher.id };
          
          // Store under EVERY possible key for this team
          const abbr = (team.team?.abbreviation || "").toUpperCase();
          const name = (team.team?.name || "").toLowerCase();
          const shortName = (team.team?.shortName || "").toLowerCase();
          const teamName = (team.team?.teamName || "").toLowerCase(); // e.g. "Dodgers"
          const locName = (team.team?.locationName || "").toLowerCase(); // e.g. "Los Angeles"
          
          if (abbr) pitchersByTeam[abbr] = info;
          if (name) pitchersByTeam[name] = info;
          if (shortName) pitchersByTeam[shortName] = info;
          if (teamName) pitchersByTeam[teamName] = info;
          if (locName) pitchersByTeam[locName] = info;
          // Also store normalized abbreviation
          const norm = normalizeAbbr(abbr);
          if (norm) pitchersByTeam[norm] = info;
        }
      }
    }
    return { pitchersByTeam, rawGames: gameCount, pitcherCount };
  } catch (e) { return { error: e.message, pitchersByTeam: {}, rawGames: 0 }; }
}

// Look up a pitcher by trying every possible identifier
function findPitcher(pitchersByTeam, abbr, fullName) {
  if (!pitchersByTeam) return null;
  // Try abbreviation
  const norm = normalizeAbbr(abbr);
  if (pitchersByTeam[norm]) return pitchersByTeam[norm];
  if (pitchersByTeam[abbr]) return pitchersByTeam[abbr];
  if (pitchersByTeam[abbr?.toUpperCase()]) return pitchersByTeam[abbr?.toUpperCase()];
  // Try full team name parts
  if (fullName) {
    const lower = fullName.toLowerCase();
    if (pitchersByTeam[lower]) return pitchersByTeam[lower];
    // Try each word (city name, team name)
    for (const word of lower.split(/\s+/)) {
      if (word.length > 3 && pitchersByTeam[word]) return pitchersByTeam[word];
    }
    // Try last word (usually the nickname like "Dodgers", "Yankees")
    const words = lower.split(/\s+/);
    const last = words[words.length - 1];
    if (pitchersByTeam[last]) return pitchersByTeam[last];
  }
  return null;
}

async function fetchPitcherStats(pid) {
  if (!pid) return null;
  try {
    // Try 2026 first, then 2025 career stats as fallback
    let resp = await fetch(`https://statsapi.mlb.com/api/v1/people/${pid}/stats?stats=season&season=2026&group=pitching`, { cache: "no-store" });
    let data = await resp.json();
    let s = data.stats?.[0]?.splits?.[0]?.stat;
    if (!s || s.inningsPitched === "0.0") {
      // Fallback to 2025 season
      resp = await fetch(`https://statsapi.mlb.com/api/v1/people/${pid}/stats?stats=season&season=2025&group=pitching`, { cache: "no-store" });
      data = await resp.json();
      s = data.stats?.[0]?.splits?.[0]?.stat;
      if (s) s._fromPriorSeason = true;
    }
    if (!s) return null;
    return { era: s.era || "0.00", whip: s.whip || "0.00", wins: s.wins || 0, losses: s.losses || 0, strikeOuts: s.strikeOuts || 0, ip: s.inningsPitched || "0.0", hr: s.homeRuns || 0, bb: s.baseOnBalls || 0, gs: s.gamesStarted || 0, fromPrior: s._fromPriorSeason || false };
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
  if (x === y) return true;
  if (x.includes(y) || y.includes(x)) return true;
  return x.split(/\s+/).filter(w => w.length > 3).some(w => y.split(/\s+/).filter(v => v.length > 3).includes(w));
}

function parseOddsForGame(oddsGames, awayName, homeName, awayAbbr, homeAbbr) {
  if (!oddsGames?.length) return null;
  let match = oddsGames.find(og => (fuzzyMatch(og.away_team, awayName) || fuzzyMatch(og.away_team, awayAbbr)) && (fuzzyMatch(og.home_team, homeName) || fuzzyMatch(og.home_team, homeAbbr)));
  if (!match) match = oddsGames.find(og => fuzzyMatch(og.away_team, awayName) || fuzzyMatch(og.home_team, homeName));
  if (!match) return null;
  let cT = 0, tC = 0, minT = 999, maxT = 0, sL = 0, sC = 0, fav = "", aML = 0, hML = 0;
  for (const bm of (match.bookmakers || [])) for (const mkt of (bm.markets || [])) {
    if (mkt.key === "totals") for (const o of (mkt.outcomes || [])) { if (o.name === "Over" && o.point) { cT += o.point; tC++; if (o.point < minT) minT = o.point; if (o.point > maxT) maxT = o.point; } }
    if (mkt.key === "spreads") for (const o of (mkt.outcomes || [])) { if (o.point && o.point < 0) { sL += Math.abs(o.point); sC++; fav = o.name; } }
    if (mkt.key === "h2h") for (const o of (mkt.outcomes || [])) { if (fuzzyMatch(o.name, awayName) || fuzzyMatch(o.name, awayAbbr)) aML = o.price; if (fuzzyMatch(o.name, homeName) || fuzzyMatch(o.name, homeAbbr)) hML = o.price; }
  }
  return { consensusTotal: tC > 0 ? Math.round((cT / tC) * 10) / 10 : 0, numBooks: tC, totalRange: { min: minT < 999 ? minT : 0, max: maxT }, spreadLine: sC > 0 ? Math.round((sL / sC) * 10) / 10 : 0, favTeam: fav ? (fuzzyMatch(fav, homeName) || fuzzyMatch(fav, homeAbbr) ? homeAbbr : awayAbbr) : "", awayML: aML, homeML: hML };
}

function mlToProb(ml) { if (!ml) return 0.5; return ml < 0 ? Math.abs(ml) / (Math.abs(ml) + 100) : 100 / (ml + 100); }

// Project individual team runs using ML odds + pitcher data + park factor
function projectRuns(modelTotal, awayML, homeML, parkFactor) {
  const awayWP = mlToProb(awayML);
  const homeWP = mlToProb(homeML);
  // Favorites score more runs on average. Use ML-implied win prob to split total.
  // A 60% favorite scores ~55% of the total runs in an average game.
  const homeShare = 0.45 + (homeWP - 0.5) * 0.3; // ranges ~0.38 to ~0.62
  const awayShare = 1 - homeShare;
  const homeRuns = Math.round(modelTotal * homeShare * 10) / 10;
  const awayRuns = Math.round(modelTotal * awayShare * 10) / 10;
  return { awayRuns, homeRuns };
}

export async function POST(req) {
  const { games, lockedPredictions } = await req.json();
  const locked = lockedPredictions || {};

  const [oddsData, mlbData] = await Promise.all([fetchMLBOdds(), fetchMLBPitchers()]);
  const pitchersByTeam = mlbData.pitchersByTeam || {};

  const gameSummaries = games.map(g => {
    const odds = parseOddsForGame(oddsData.games, g.away, g.home, g.awayAbbr, g.homeAbbr);
    // Look up pitchers directly by team name/abbr
    const awayP = findPitcher(pitchersByTeam, g.awayAbbr, g.away);
    const homeP = findPitcher(pitchersByTeam, g.homeAbbr, g.home);
    return { ...g, liveOdds: odds, awayPitcherInfo: awayP, homePitcherInfo: homeP };
  });

  const gamesToAnalyze = gameSummaries.filter(g => g.status !== "final" && g.status !== "live" && !locked[g.id]);

  // Fetch pitcher season stats for all found pitchers in parallel
  const pPromises = [];
  for (const g of gamesToAnalyze) {
    if (g.awayPitcherInfo?.id) pPromises.push(fetchPitcherStats(g.awayPitcherInfo.id).then(s => ({ gid: g.id, side: "away", stats: s, name: g.awayPitcherInfo.name })));
    if (g.homePitcherInfo?.id) pPromises.push(fetchPitcherStats(g.homePitcherInfo.id).then(s => ({ gid: g.id, side: "home", stats: s, name: g.homePitcherInfo.name })));
  }
  const pResults = await Promise.all(pPromises);
  const pMap = {};
  for (const p of pResults) { if (!pMap[p.gid]) pMap[p.gid] = {}; pMap[p.gid][p.side] = { name: p.name, ...(p.stats || {}) }; }

  const results = gameSummaries.map(g => {
    const odds = g.liveOdds, status = g.status;
    if ((status === "final" || status === "live") && locked[g.id]) return { id: g.id, status, sport: "mlb", awayScore: g.liveScore?.away ?? null, homeScore: g.liveScore?.home ?? null, clock: g.liveScore?.clock || "", currentTotal: locked[g.id].line || g.total, consensus: locked[g.id].consensus || null, lockedPrediction: locked[g.id], isNewPrediction: false, currentSpread: null, oddsRange: null, numBooks: 0, oddsSpread: null, oddsTotal: null, oddsML: null, injuries: null };
    if (status === "final" || status === "live") return { id: g.id, status, sport: "mlb", awayScore: g.liveScore?.away ?? null, homeScore: g.liveScore?.home ?? null, clock: g.liveScore?.clock || "", currentTotal: odds?.consensusTotal || g.total, currentSpread: odds?.favTeam ? `${odds.favTeam} -${odds.spreadLine}` : null, oddsRange: odds?.totalRange || null, numBooks: odds?.numBooks || 0, oddsSpread: odds?.favTeam ? { fav: odds.favTeam, line: -odds.spreadLine } : null, oddsTotal: odds?.consensusTotal || null, oddsML: (odds?.awayML || odds?.homeML) ? { away: odds.awayML, home: odds.homeML } : null, consensus: null, lockedPrediction: null, noPregamePrediction: true, isNewPrediction: false, injuries: null };

    // --- SCHEDULED ---
    const pm = pMap[g.id] || {};
    const currentTotal = odds?.consensusTotal || g.total || 8.5;
    const parkFactor = PARK_FACTORS[normalizeAbbr(g.homeAbbr)] || 1.0;
    const hasPitchers = !!(pm.away?.name || pm.home?.name);
    const awayERA = parseFloat(pm.away?.era) || 4.50;
    const homeERA = parseFloat(pm.home?.era) || 4.50;
    const awayWHIP = parseFloat(pm.away?.whip) || 1.35;
    const homeWHIP = parseFloat(pm.home?.whip) || 1.35;

    // Pitcher-based total projection
    const awayPRuns = (awayERA / 9) * 5.5;
    const homePRuns = (homeERA / 9) * 5.5;
    const bpRuns = 1.8;
    const rawModelTotal = (awayPRuns + bpRuns * 0.9) * parkFactor + (homePRuns + bpRuns);
    const modelTotal = Math.round(rawModelTotal * 10) / 10;

    // Use ML odds to split runs between teams (NO MORE TIES)
    const { awayRuns, homeRuns } = projectRuns(modelTotal, odds?.awayML, odds?.homeML, parkFactor);
    const awayWP = mlToProb(odds?.awayML);
    const homeWP = mlToProb(odds?.homeML);

    // --- VOTING ---
    let overW = 0, underW = 0;
    const reasons = [];
    if (odds?.consensusTotal && odds.numBooks >= 2) reasons.push(`Odds: ${odds.numBooks} books avg ${odds.consensusTotal} (${odds.totalRange?.min}-${odds.totalRange?.max})`);

    // Model total vs line
    const modelWeight = hasPitchers ? 3.0 : 1.5;
    const modelEdge = modelTotal - currentTotal;
    if (Math.abs(modelEdge) >= 0.3) {
      if (modelEdge > 0) { overW += modelWeight; reasons.push(`${hasPitchers ? "Pitcher" : "Avg"} model: ${modelTotal} > line ${currentTotal}${hasPitchers ? ` (ERA: ${awayERA}/${homeERA})` : ""}`); }
      else { underW += modelWeight; reasons.push(`${hasPitchers ? "Pitcher" : "Avg"} model: ${modelTotal} < line ${currentTotal}${hasPitchers ? ` (ERA: ${awayERA}/${homeERA})` : ""}`); }
    }

    // WHIP
    if (hasPitchers) {
      const cWHIP = (awayWHIP + homeWHIP) / 2;
      if (cWHIP > 1.40) { overW += 1.0; reasons.push(`WHIP: ${cWHIP.toFixed(2)} (high baserunners = more runs)`); }
      else if (cWHIP < 1.05) { underW += 1.0; reasons.push(`WHIP: ${cWHIP.toFixed(2)} (few baserunners = fewer runs)`); }
    }

    // Park
    if (parkFactor >= 1.05) { overW += 1.5; reasons.push(`Park: ${g.homeAbbr} +${((parkFactor-1)*100).toFixed(0)}% hitter-friendly`); }
    else if (parkFactor <= 0.96) { underW += 1.5; reasons.push(`Park: ${g.homeAbbr} -${((1-parkFactor)*100).toFixed(0)}% pitcher-friendly`); }

    // ML-implied scoring
    if (homeWP > 0.62 || awayWP > 0.62) { overW += 0.5; reasons.push(`Heavy favorite (${Math.max(homeWP,awayWP)*100|0}%) likely piles on runs`); }

    // Pitcher display
    if (pm.away?.name) reasons.push(`${g.awayAbbr} SP: ${pm.away.name} (${pm.away.era} ERA, ${pm.away.whip} WHIP, ${pm.away.wins}-${pm.away.losses}${pm.away.fromPrior ? " *2025" : ""})`);
    else reasons.push(`${g.awayAbbr} SP: TBD (using league avg 4.50 ERA)`);
    if (pm.home?.name) reasons.push(`${g.homeAbbr} SP: ${pm.home.name} (${pm.home.era} ERA, ${pm.home.whip} WHIP, ${pm.home.wins}-${pm.home.losses}${pm.home.fromPrior ? " *2025" : ""})`);
    else reasons.push(`${g.homeAbbr} SP: TBD (using league avg 4.50 ERA)`);

    const totalW = overW + underW;
    const call = overW > underW ? "OVER" : underW > overW ? "UNDER" : "TOSS-UP";
    const agree = totalW > 0 ? (Math.max(overW, underW) / totalW) : 0.5;
    const edge = Math.abs(modelEdge);

    // Better confidence formula
    const votingSigs = reasons.filter(r => !r.startsWith("Odds:") && !r.includes(" SP:")).length;
    let conf = 35; // base
    if (hasPitchers) conf += 15; // pitcher data bonus
    if (edge >= 0.3 && edge <= 1.0) conf += 12;
    else if (edge > 1.0 && edge <= 2.0) conf += 18;
    else if (edge > 2.0 && edge <= 3.0) conf += 10;
    else if (edge > 3.0) conf += 3;
    conf += Math.min(15, votingSigs * 5); // signal count
    conf += Math.round(agree * 10); // agreement
    if (parkFactor >= 1.05 || parkFactor <= 0.96) conf += 5; // significant park
    const strength = Math.min(90, Math.max(25, conf));

    // Moneyline
    let mlPick = null, mlReason = "";
    if (hasPitchers && Math.abs(awayERA - homeERA) > 0.8) {
      const better = awayERA < homeERA ? g.awayAbbr : g.homeAbbr;
      mlPick = better; mlReason = `${better} SP has ${Math.abs(awayERA-homeERA).toFixed(2)} ERA edge`;
    } else if (homeWP > 0.58) { mlPick = g.homeAbbr; mlReason = `${g.homeAbbr} implied ${(homeWP*100).toFixed(0)}% + home`; }
    else if (awayWP > 0.55) { mlPick = g.awayAbbr; mlReason = `${g.awayAbbr} implied ${(awayWP*100).toFixed(0)}% on road`; }

    // Run line
    let rlPick = null, rlReason = "";
    if (hasPitchers && Math.abs(awayERA - homeERA) > 1.5) {
      const better = awayERA < homeERA ? g.awayAbbr : g.homeAbbr;
      rlPick = better; rlReason = `${better} dominant SP (${Math.abs(awayERA-homeERA).toFixed(2)} ERA gap)`;
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
        totalCall: call, strength, spreadCall: rlPick, spreadReason: rlReason,
        moneylinePick: mlPick, moneylineReason: mlReason,
        votes: { over: overW.toFixed(1), under: underW.toFixed(1) }, reasons, modelTotal,
        modelSpread: Math.round((homeRuns - awayRuns) * 10) / 10,
        awayPts: Math.round(awayRuns), homePts: Math.round(homeRuns),
        projPace: null, tournamentRound: null, tournamentDiscount: null,
        liveProjectedTotal: null, awayKenPom: null, homeKenPom: null,
        recentFormTotal: 0, edgeSize: edge.toFixed(1),
        awayPitcher: pm.away || null, homePitcher: pm.home || null,
        parkFactor: parkFactor !== 1.0 ? parkFactor : null,
        awayWinProb: (awayWP * 100).toFixed(0), homeWinProb: (homeWP * 100).toFixed(0)
      },
      isNewPrediction: true, injuries: null,
      matchDebug: g.matchDebug
    };
  });

  return NextResponse.json({
    updates: results, analyzedCount: gamesToAnalyze.length, sport: "mlb",
    pitcherDebug: gamesToAnalyze.map(g => ({ 
      id: g.id, 
      teams: `${g.awayAbbr} (${g.away}) @ ${g.homeAbbr} (${g.home})`,
      awayPitcher: g.awayPitcherInfo?.name || "NOT FOUND",
      homePitcher: g.homePitcherInfo?.name || "NOT FOUND",
      hasPitcherStats: !!(pMap[g.id]?.away || pMap[g.id]?.home)
    })),
    sources: {
      oddsAPI: oddsData.error ? `x ${oddsData.error}` : `OK ${oddsData.games.length} (${oddsData.remaining} left)`,
      mlbStatsAPI: mlbData.error ? `x ${mlbData.error}` : `OK ${mlbData.rawGames} games, ${mlbData.pitcherCount || 0} pitchers, ${Object.keys(pitchersByTeam).length} lookup keys`,
      pitchers: `${Object.keys(pMap).length}/${gamesToAnalyze.length} games with stats`
    }
  });
}
