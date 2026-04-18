import { NextResponse } from "next/server";
export const maxDuration = 30;

// --- NBA TEAM MAP (all 30 teams) ---
const TM = {
  ATL:"ATL",BOS:"BOS",BKN:"BKN",BRK:"BKN",CHA:"CHA",CHI:"CHI",
  CLE:"CLE",DAL:"DAL",DEN:"DEN",DET:"DET",GS:"GSW",GSW:"GSW",
  HOU:"HOU",IND:"IND",LAC:"LAC",LAL:"LAL",MEM:"MEM",MIA:"MIA",
  MIL:"MIL",MIN:"MIN",NO:"NOP",NOP:"NOP",NYK:"NYK",NY:"NYK",
  OKC:"OKC",ORL:"ORL",PHI:"PHI",PHX:"PHX",POR:"POR",SAC:"SAC",
  SA:"SAS",SAS:"SAS",TOR:"TOR",UTA:"UTA",UTAH:"UTA",WAS:"WAS",WSH:"WAS"
};
function norm(a) { return a ? TM[a.toUpperCase()] || a.toUpperCase() : ""; }
function mlToProb(ml) { if (!ml) return 0.5; return ml < 0 ? Math.abs(ml)/(Math.abs(ml)+100) : 100/(ml+100); }

// League averages for NBA 2025-26
const NBA_AVG = { pace: 100, offRtg: 114, defRtg: 114, ppg: 114 };

// --- FETCH NBA TEAM STATS from NBA Stats API (free) ---
async function fetchNBATeamStats() {
  try {
    // Use ESPN's team stats as a proxy (free, no key)
    const resp = await fetch("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/standings", { cache: "no-store" });
    if (!resp.ok) return { error: `${resp.status}`, teams: {} };
    const data = await resp.json();
    const teams = {};
    for (const group of (data.children || [])) {
      for (const div of (group.children || [])) {
        for (const entry of (div.standings?.entries || [])) {
          const abbr = norm(entry.team?.abbreviation || "");
          const name = (entry.team?.displayName || "").toLowerCase();
          const stats = {};
          for (const s of (entry.stats || [])) { stats[s.name] = parseFloat(s.value) || 0; }
          const w = stats.wins || 0, l = stats.losses || 0, gp = w + l || 1;
          // ESPN standings have ppg, oppg, diff
          const ppg = stats.pointsFor ? stats.pointsFor / gp : stats.avgPointsFor || NBA_AVG.ppg;
          const oppg = stats.pointsAgainst ? stats.pointsAgainst / gp : stats.avgPointsAgainst || NBA_AVG.ppg;
          const info = { w, l, gp, ppg: +ppg.toFixed(1), oppg: +oppg.toFixed(1), diff: +(ppg - oppg).toFixed(1) };
          if (abbr) teams[abbr] = info;
          if (name) teams[name] = info;
          const short = (entry.team?.shortDisplayName || "").toLowerCase();
          if (short) teams[short] = info;
        }
      }
    }
    return { teams };
  } catch (e) { return { error: e.message, teams: {} }; }
}

// Fetch NBA schedule for B2B detection
async function fetchRecentSchedule() {
  const schedule = {}; // team -> array of game dates
  for (let i = 1; i <= 3; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const ds = d.toISOString().split("T")[0].replace(/-/g, "");
    try {
      const resp = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${ds}&limit=50`, { cache: "no-store" });
      if (!resp.ok) continue;
      const data = await resp.json();
      for (const ev of (data.events || [])) {
        const comp = ev.competitions?.[0];
        if (!comp) continue;
        for (const t of (comp.competitors || [])) {
          const abbr = norm(t.team?.abbreviation || "");
          if (abbr) {
            if (!schedule[abbr]) schedule[abbr] = [];
            schedule[abbr].push(d.toISOString().split("T")[0]);
          }
        }
      }
    } catch {}
  }
  return schedule;
}

// Odds API for NBA
async function fetchNBAOdds() {
  const key = process.env.ODDS_API_KEY;
  if (!key) return { error: "No key", games: [] };
  try {
    const r = await fetch(`https://api.the-odds-api.com/v4/sports/basketball_nba/odds/?apiKey=${key}&regions=us&markets=totals,spreads,h2h&oddsFormat=american`);
    return { games: await r.json() || [], remaining: r.headers.get("x-requests-remaining") };
  } catch (e) { return { error: e.message, games: [] }; }
}

function fuzzy(a, b) {
  if (!a || !b) return false;
  const x = a.toLowerCase().replace(/[^a-z0-9]/g, " ").trim();
  const y = b.toLowerCase().replace(/[^a-z0-9]/g, " ").trim();
  if (x === y || x.includes(y) || y.includes(x)) return true;
  return x.split(/\s+/).filter(w => w.length > 3).some(w => y.split(/\s+/).filter(v => v.length > 3).includes(w));
}

function parseOdds(og, aN, hN, aA, hA) {
  if (!og?.length) return null;
  let m = og.find(o => (fuzzy(o.away_team, aN) || fuzzy(o.away_team, aA)) && (fuzzy(o.home_team, hN) || fuzzy(o.home_team, hA)));
  if (!m) m = og.find(o => fuzzy(o.away_team, aN) || fuzzy(o.home_team, hN));
  if (!m) return null;
  let cT=0,tC=0,mn=999,mx=0,sL=0,sC=0,fv="",aM=0,hM=0;
  for (const b of (m.bookmakers||[])) for (const k of (b.markets||[])) {
    if (k.key==="totals") for (const o of (k.outcomes||[])) if (o.name==="Over"&&o.point){cT+=o.point;tC++;if(o.point<mn)mn=o.point;if(o.point>mx)mx=o.point;}
    if (k.key==="spreads") for (const o of (k.outcomes||[])) if (o.point&&o.point<0){sL+=Math.abs(o.point);sC++;fv=o.name;}
    if (k.key==="h2h") for (const o of (k.outcomes||[])) {if(fuzzy(o.name,aN)||fuzzy(o.name,aA))aM=o.price;if(fuzzy(o.name,hN)||fuzzy(o.name,hA))hM=o.price;}
  }
  return { total:tC>0?Math.round(cT/tC*10)/10:0, books:tC, range:{min:mn<999?mn:0,max:mx}, spread:sC>0?Math.round(sL/sC*10)/10:0, fav:fv?(fuzzy(fv,hN)||fuzzy(fv,hA)?hA:aA):"", awayML:aM, homeML:hM };
}

function findTeam(teams, abbr, name) {
  const n = norm(abbr);
  return teams[n] || teams[abbr] || teams[name?.toLowerCase()] || null;
}

// ==========================================
// NBA PREDICTION ENGINE
// ==========================================
function buildNBAPrediction(g, odds, awayTeam, homeTeam, b2bInfo) {
  const line = odds?.total || g.total || 220;
  const spreadLine = odds?.spread || 0;
  
  // --- TEAM STATS ---
  const awayPPG = awayTeam?.ppg || NBA_AVG.ppg;
  const homePPG = homeTeam?.ppg || NBA_AVG.ppg;
  const awayOPPG = awayTeam?.oppg || NBA_AVG.defRtg;
  const homeOPPG = homeTeam?.oppg || NBA_AVG.defRtg;
  const hasTeamData = !!(awayTeam?.ppg && homeTeam?.ppg);

  // --- POSSESSION-BASED PROJECTION ---
  // Estimate pace from PPG (PPG ≈ Pace * PPP, league avg ~100 possessions * 1.14 PPP)
  const awayPace = awayPPG / 1.14 * 100; // rough possession estimate
  const homePace = homePPG / 1.14 * 100;
  const projPace = (awayPace + homePace) / 2; // games played at average of both paces
  
  // Points Per Possession
  const awayOffPPP = awayPPG / (awayPace || 100);
  const homeOffPPP = homePPG / (homePace || 100);
  const awayDefPPP = awayOPPG / (awayPace || 100); // lower = better defense
  const homeDefPPP = homeOPPG / (homePace || 100);
  
  // Projected score: team scores = pace * (their offense PPP adjusted by opponent defense PPP)
  // Away team scores: projPace * awayOffPPP * (homeDefPPP / league_avg_def_ppp)
  const leagueDefPPP = NBA_AVG.defRtg / 100;
  let awayProj = projPace * awayOffPPP * (homeDefPPP / leagueDefPPP);
  let homeProj = projPace * homeOffPPP * (awayDefPPP / leagueDefPPP);

  // --- B2B & REST PENALTIES ---
  const awayB2B = b2bInfo[norm(g.awayAbbr)];
  const homeB2B = b2bInfo[norm(g.homeAbbr)];
  let awayRestPenalty = 0, homeRestPenalty = 0;
  const reasons = [], dataSources = [];
  
  if (awayB2B?.isB2B) { awayRestPenalty = 2.5; reasons.push(`${g.awayAbbr} on B2B (-2.5 pts)`); }
  if (awayB2B?.is3in4) { awayRestPenalty = 4.0; reasons.push(`${g.awayAbbr} 3rd game in 4 nights (-4.0 pts)`); }
  if (homeB2B?.isB2B) { homeRestPenalty = 2.5; reasons.push(`${g.homeAbbr} on B2B (-2.5 pts)`); }
  if (homeB2B?.is3in4) { homeRestPenalty = 4.0; reasons.push(`${g.homeAbbr} 3rd game in 4 nights (-4.0 pts)`); }
  
  awayProj -= awayRestPenalty;
  homeProj -= homeRestPenalty;

  // Home court advantage (+3 points)
  homeProj += 3;

  const modelTotal = Math.round((awayProj + homeProj) * 10) / 10;
  const modelSpread = Math.round((homeProj - awayProj) * 10) / 10;
  const projAway = Math.round(awayProj);
  const projHome = Math.round(homeProj);

  // --- WIN PROBABILITY ---
  const mlAwayWP = mlToProb(odds?.awayML);
  const mlHomeWP = mlToProb(odds?.homeML);
  // Blend ML implied with our spread-based model
  const spreadImpliedHomeWP = modelSpread > 0 ? 0.5 + modelSpread * 0.03 : 0.5 + modelSpread * 0.03;
  const homeWP = hasTeamData ? (mlHomeWP * 0.6 + Math.min(0.95, Math.max(0.05, spreadImpliedHomeWP)) * 0.4) : mlHomeWP;
  const awayWP = 1 - homeWP;
  const maxWP = Math.max(awayWP, homeWP);
  const favAbbr = homeWP > awayWP ? g.homeAbbr : g.awayAbbr;

  // --- VOTING ---
  let overW = 0, underW = 0;
  
  if (odds?.total && odds.books >= 2) dataSources.push(`Odds API: ${odds.books} books, line ${odds.total} (${odds.range.min}-${odds.range.max})`);

  // Model total vs line (3.0x with team data, 1.5x without)
  const pw = hasTeamData ? 3.0 : 1.5;
  const edge = modelTotal - line;
  if (Math.abs(edge) >= 2) {
    if (edge > 0) { overW += pw; reasons.push(`Model: ${modelTotal} > line ${line} (${edge.toFixed(1)} pt edge)`); }
    else { underW += pw; reasons.push(`Model: ${modelTotal} < line ${line} (${Math.abs(edge).toFixed(1)} pt edge)`); }
    dataSources.push(`Pace Model: ${modelTotal} projected total (${pw}x weight)`);
  }

  // Defensive matchup signal
  if (hasTeamData) {
    const avgDef = (awayOPPG + homeOPPG) / 2;
    if (avgDef > NBA_AVG.ppg + 3) { overW += 1.5; reasons.push(`Weak defenses: avg ${avgDef.toFixed(1)} OPPG (league ${NBA_AVG.ppg})`); }
    else if (avgDef < NBA_AVG.ppg - 3) { underW += 1.5; reasons.push(`Strong defenses: avg ${avgDef.toFixed(1)} OPPG`); }
    dataSources.push(`Defense: ${g.awayAbbr} ${awayOPPG.toFixed(1)} OPPG / ${g.homeAbbr} ${homeOPPG.toFixed(1)} OPPG`);
  }

  // Pace signal
  if (hasTeamData) {
    const combinedPace = (awayPPG + homePPG);
    if (combinedPace > NBA_AVG.ppg * 2 + 6) { overW += 1.0; reasons.push(`Fast pace: combined ${combinedPace.toFixed(1)} PPG`); }
    else if (combinedPace < NBA_AVG.ppg * 2 - 6) { underW += 1.0; reasons.push(`Slow pace: combined ${combinedPace.toFixed(1)} PPG`); }
    dataSources.push(`Offense: ${g.awayAbbr} ${awayPPG.toFixed(1)} PPG / ${g.homeAbbr} ${homePPG.toFixed(1)} PPG`);
  }

  // B2B impact on total
  if (awayRestPenalty > 0 || homeRestPenalty > 0) {
    underW += 1.0;
    dataSources.push(`Rest: ${awayRestPenalty > 0 ? g.awayAbbr + " B2B" : ""}${homeRestPenalty > 0 ? (awayRestPenalty > 0 ? " + " : "") + g.homeAbbr + " B2B" : ""}`);
  }

  // Team stats display
  if (awayTeam) reasons.push(`${g.awayAbbr}: ${awayTeam.ppg} PPG, ${awayTeam.oppg} OPPG (${awayTeam.w}-${awayTeam.l})`);
  if (homeTeam) reasons.push(`${g.homeAbbr}: ${homeTeam.ppg} PPG, ${homeTeam.oppg} OPPG (${homeTeam.w}-${homeTeam.l})`);
  reasons.push(`Win prob: ${g.awayAbbr} ${(awayWP*100).toFixed(0)}% / ${g.homeAbbr} ${(homeWP*100).toFixed(0)}%`);

  // O/U call
  const totalW = overW + underW;
  const call = overW > underW ? "OVER" : underW > overW ? "UNDER" : "TOSS-UP";
  const agree = totalW > 0 ? Math.max(overW, underW) / totalW : 0.5;
  const absEdge = Math.abs(edge);

  // Confidence
  let conf = 30;
  if (hasTeamData) conf += 15;
  if (absEdge >= 2 && absEdge <= 5) conf += 12;
  else if (absEdge > 5 && absEdge <= 10) conf += 16;
  else if (absEdge > 10 && absEdge <= 15) conf += 8;
  else if (absEdge > 15) conf += 3;
  conf += Math.min(10, reasons.filter(r => !r.includes("PPG,") && !r.startsWith("Win prob:")).length * 3);
  conf += Math.round(agree * 10);
  if (awayRestPenalty > 0 || homeRestPenalty > 0) conf += 5; // B2B is reliable signal
  const strength = Math.min(88, Math.max(25, conf));

  // Spread pick
  let spreadCall = null, spreadReason = "";
  const modelVsSpread = modelSpread - (-spreadLine); // positive = model favors home more than Vegas
  if (Math.abs(modelVsSpread) >= 2) {
    if (modelSpread > -spreadLine) { spreadCall = g.homeAbbr; spreadReason = `Model spread ${modelSpread > 0 ? "+" : ""}${modelSpread.toFixed(1)} vs line ${-spreadLine}`; }
    else { spreadCall = g.awayAbbr; spreadReason = `Model spread ${modelSpread > 0 ? "+" : ""}${modelSpread.toFixed(1)} vs line ${-spreadLine}`; }
  }
  if (awayRestPenalty > 0 && !spreadCall) { spreadCall = g.homeAbbr; spreadReason = `${g.awayAbbr} B2B penalty favors ${g.homeAbbr}`; }
  if (homeRestPenalty > 0 && !spreadCall) { spreadCall = g.awayAbbr; spreadReason = `${g.homeAbbr} B2B penalty favors ${g.awayAbbr}`; }

  // ML pick
  let mlPick = null, mlReason = "";
  if (homeWP > 0.58) { mlPick = g.homeAbbr; mlReason = `${g.homeAbbr} ${(homeWP*100).toFixed(0)}% + home court`; }
  else if (awayWP > 0.55) { mlPick = g.awayAbbr; mlReason = `${g.awayAbbr} ${(awayWP*100).toFixed(0)}% on road`; }

  return {
    consensus: {
      totalCall: call, strength, spreadCall, spreadReason,
      moneylinePick: mlPick, moneylineReason: mlReason,
      votes: { over: overW.toFixed(1), under: underW.toFixed(1) },
      reasons, dataSources, modelTotal,
      modelSpread, awayPts: projAway, homePts: projHome,
      edgeSize: absEdge.toFixed(1),
      parkFactor: null,
      awayWinProb: (awayWP*100).toFixed(0), homeWinProb: (homeWP*100).toFixed(0),
      awayPitcher: null, homePitcher: null,
      awayPyth: null, homePyth: null,
      projPace: projPace.toFixed(0),
      awayB2B: awayB2B, homeB2B: homeB2B,
      // Compat fields
      tournamentRound: null, tournamentDiscount: null, liveProjectedTotal: null,
      awayKenPom: null, homeKenPom: null, recentFormTotal: 0
    },
    modelTotal, currentTotal: line
  };
}

// ==========================================
// MAIN HANDLER
// ==========================================
export async function POST(req) {
  const { games, lockedPredictions } = await req.json();
  const locked = lockedPredictions || {};

  const [oddsData, teamData, recentGames] = await Promise.all([
    fetchNBAOdds(), fetchNBATeamStats(), fetchRecentSchedule()
  ]);
  const teamStats = teamData.teams || {};

  // Detect B2B for each team
  const today = new Date().toISOString().split("T")[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];
  const twoDaysAgo = new Date(Date.now() - 2*86400000).toISOString().split("T")[0];
  const threeDaysAgo = new Date(Date.now() - 3*86400000).toISOString().split("T")[0];
  
  const b2bInfo = {};
  for (const [team, dates] of Object.entries(recentGames)) {
    const playedYesterday = dates.includes(yesterday);
    const played2ago = dates.includes(twoDaysAgo);
    const played3ago = dates.includes(threeDaysAgo);
    const gamesIn3Days = [yesterday, twoDaysAgo, threeDaysAgo].filter(d => dates.includes(d)).length;
    b2bInfo[team] = { isB2B: playedYesterday, is3in4: gamesIn3Days >= 2, recentGames: gamesIn3Days };
  }

  const gameSummaries = games.map(g => ({
    ...g,
    odds: parseOdds(oddsData.games, g.away, g.home, g.awayAbbr, g.homeAbbr),
    awayTeam: findTeam(teamStats, g.awayAbbr, g.away),
    homeTeam: findTeam(teamStats, g.homeAbbr, g.home)
  }));

  const toAnalyze = gameSummaries.filter(g => !locked[g.espnId || g.id] && g.status !== "final");

  const results = gameSummaries.map(g => {
    const odds = g.odds, status = g.status;
    const lockKey = g.espnId || g.id;

    if (locked[lockKey]) return { id: g.id, espnId: g.espnId, status, sport: "nba", awayScore: g.liveScore?.away??null, homeScore: g.liveScore?.home??null, clock: g.liveScore?.clock||"", currentTotal: locked[lockKey].line||g.total, consensus: locked[lockKey].consensus||null, lockedPrediction: locked[lockKey], isNewPrediction: false, currentSpread: odds?.fav?`${odds.fav} -${odds.spread}`:null, oddsRange: odds?.range||null, numBooks: odds?.books||0, oddsSpread: odds?.fav?{fav:odds.fav,line:-odds.spread}:null, oddsTotal: odds?.total||null, oddsML: (odds?.awayML||odds?.homeML)?{away:odds.awayML,home:odds.homeML}:null, injuries: null };
    if (status === "final") return { id: g.id, espnId: g.espnId, status, sport: "nba", awayScore: g.liveScore?.away??null, homeScore: g.liveScore?.home??null, clock: g.liveScore?.clock||"", currentTotal: odds?.total||g.total, currentSpread: odds?.fav?`${odds.fav} -${odds.spread}`:null, oddsRange: odds?.range||null, numBooks: odds?.books||0, oddsSpread: odds?.fav?{fav:odds.fav,line:-odds.spread}:null, oddsTotal: odds?.total||null, oddsML: (odds?.awayML||odds?.homeML)?{away:odds.awayML,home:odds.homeML}:null, consensus: null, lockedPrediction: null, noPregamePrediction: true, isNewPrediction: false, injuries: null };

    const pred = buildNBAPrediction(g, odds, g.awayTeam, g.homeTeam, b2bInfo);
    return {
      id: g.id, espnId: g.espnId, status, sport: "nba",
      awayScore: g.liveScore?.away??null, homeScore: g.liveScore?.home??null,
      clock: g.liveScore?.clock||null, currentTotal: pred.currentTotal,
      currentSpread: odds?.fav?`${odds.fav} -${odds.spread}`:null,
      oddsRange: odds?.range||null, numBooks: odds?.books||0,
      oddsSpread: odds?.fav?{fav:odds.fav,line:-odds.spread}:null,
      oddsTotal: odds?.total||null,
      oddsML: (odds?.awayML||odds?.homeML)?{away:odds.awayML||0,home:odds.homeML||0}:null,
      consensus: pred.consensus,
      isNewPrediction: status === "scheduled" || status === undefined,
      injuries: null
    };
  });

  return NextResponse.json({
    updates: results, analyzedCount: toAnalyze.length, sport: "nba",
    sources: {
      oddsAPI: oddsData.error ? `x ${oddsData.error}` : `OK ${oddsData.games?.length} (${oddsData.remaining} left)`,
      espnStats: teamData.error ? `x ${teamData.error}` : `OK ${Object.keys(teamStats).length} entries`,
      b2b: `${Object.values(b2bInfo).filter(b => b.isB2B).length} teams on B2B`
    }
  });
}
