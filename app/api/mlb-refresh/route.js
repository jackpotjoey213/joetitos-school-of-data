import { NextResponse } from "next/server";
export const maxDuration = 30;

// --- CALIBRATION CONSTANTS ---
const LEAGUE_SCORING_ADJUSTMENT = 0.92; // Backtest showed +0.36 runs OVER bias, this corrects it
const LEAGUE_AVG_ERA = 4.10; // 2026 MLB league average ERA for regression

// --- CONSTANTS ---
const PARK_FACTORS = {
  COL:1.18,CIN:1.08,TEX:1.06,BOS:1.05,CHC:1.04,PHI:1.03,BAL:1.03,MIL:1.02,
  ATL:1.02,MIN:1.01,ARI:1.01,LAA:1.00,DET:1.00,CLE:1.00,TOR:0.99,WSH:0.99,
  PIT:0.99,KC:0.98,SEA:0.98,STL:0.98,SF:0.97,SD:0.97,HOU:0.97,NYY:0.97,
  CHW:0.96,CWS:0.96,TB:0.96,NYM:0.96,OAK:0.95,MIA:0.95,LAD:0.96
};
const TM={ARI:"ARI",AZ:"ARI",ATL:"ATL",BAL:"BAL",BOS:"BOS",CHC:"CHC",CUB:"CHC",CHW:"CWS",CWS:"CWS",CIN:"CIN",CLE:"CLE",COL:"COL",DET:"DET",HOU:"HOU",KC:"KC",KCR:"KC",LAA:"LAA",ANA:"LAA",LAD:"LAD",MIA:"MIA",FLA:"MIA",MIL:"MIL",MIN:"MIN",NYM:"NYM",NYY:"NYY",OAK:"OAK",ATH:"OAK",PHI:"PHI",PIT:"PIT",SD:"SD",SDP:"SD",SF:"SF",SFG:"SF",SEA:"SEA",STL:"STL",TB:"TB",TBR:"TB",TEX:"TEX",TOR:"TOR",WSH:"WSH",WAS:"WSH"};
function norm(a){if(!a)return"";return TM[a.toUpperCase()]||a.toUpperCase();}

// ==========================================
// SABERMETRIC FUNCTIONS
// ==========================================

// Pythagorean Win% with 1.83 exponent
function pythagWinPct(rs, ra) {
  if (!rs || !ra || ra === 0) return 0.5;
  const exp = 1.83;
  return Math.pow(rs, exp) / (Math.pow(rs, exp) + Math.pow(ra, exp));
}

// Log-5: True head-to-head win probability
// Given team A's true talent (pA) and team B's true talent (pB)
function log5WinProb(pA, pB) {
  if (!pA || !pB) return 0.5;
  return (pA * (1 - pB)) / (pA * (1 - pB) + pB * (1 - pA));
}

// Runs Created (simplified Bill James): (H + BB) * TB / (AB + BB)
// We approximate from API-SPORTS data
function runsCreated(hits, walks, totalBases, atBats) {
  if (!atBats || atBats === 0) return 0;
  return ((hits + walks) * totalBases) / (atBats + walks);
}

// ML odds to implied probability (kept as fallback)
function mlToProb(ml){if(!ml)return 0.5;return ml<0?Math.abs(ml)/(Math.abs(ml)+100):100/(ml+100);}

// ==========================================
// DATA FETCHING
// ==========================================

// MLB Stats API: Team standings with RS/RA for Pythagorean
async function fetchTeamStandings() {
  try {
    const [sResp, pResp] = await Promise.all([
      fetch("https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&season=2026&standingsTypes=regularSeason&hydrate=team", { cache: "no-store" }),
      fetch("https://statsapi.mlb.com/api/v1/teams/stats?stats=season&season=2026&group=pitching&sportIds=1", { cache: "no-store" })
    ]);
    if (!sResp.ok) return { error: `${sResp.status}`, teams: {} };
    const data = await sResp.json();
    const teams = {};
    for (const rec of (data.records || [])) {
      for (const tr of (rec.teamRecords || [])) {
        const abbr = norm(tr.team?.abbreviation || "");
        const name = (tr.team?.name || "").toLowerCase();
        const rs = tr.runsScored || 0, ra = tr.runsAllowed || 0;
        const w = tr.wins || 0, l = tr.losses || 0, gp = w + l || 1;
        const pyth = pythagWinPct(rs, ra);
        const info = { rs, ra, w, l, gp, rpg: +(rs/gp).toFixed(2), rapg: +(ra/gp).toFixed(2), pyth, reliefERA: 4.20 };
        if (abbr) teams[abbr] = info;
        if (name) teams[name] = info;
        const teamName = (tr.team?.teamName || "").toLowerCase();
        if (teamName) teams[teamName] = info;
      }
    }
    // Overlay team pitching ERA (approximation for bullpen)
    if (pResp.ok) {
      try {
        const pData = await pResp.json();
        for (const split of (pData.stats?.[0]?.splits || [])) {
          const a = norm(split.team?.abbreviation || "");
          if (a && teams[a]) teams[a].reliefERA = parseFloat(split.stat?.era) || 4.20;
        }
      } catch {}
    }
    return { teams };
  } catch (e) { return { error: e.message, teams: {} }; }
}

// MLB Stats API: Probable pitchers
async function fetchMLBPitchers() {
  try {
    const today = new Date().toISOString().split("T")[0];
    const resp = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${today}&hydrate=probablePitcher(note),team`, { cache: "no-store" });
    if (!resp.ok) return { error: `${resp.status}`, map: {}, count: 0 };
    const data = await resp.json();
    const map = {};
    let count = 0;
    for (const d of (data.dates || [])) for (const g of (d.games || [])) {
      for (const side of ["away","home"]) {
        const t = g.teams?.[side], p = t?.probablePitcher;
        if (!p) continue;
        count++;
        const info = { name: p.fullName, id: p.id };
        const a = (t.team?.abbreviation||"").toUpperCase();
        [a, norm(a), (t.team?.name||"").toLowerCase(), (t.team?.teamName||"").toLowerCase(), (t.team?.locationName||"").toLowerCase(), (t.team?.shortName||"").toLowerCase()].forEach(k => { if (k) map[k] = info; });
      }
    }
    return { map, count };
  } catch (e) { return { error: e.message, map: {}, count: 0 }; }
}

function findPitcher(map, abbr, name) {
  if (!map) return null;
  for (const k of [norm(abbr), abbr, abbr?.toUpperCase()]) if (map[k]) return map[k];
  if (name) { const l=name.toLowerCase(); if(map[l])return map[l]; const w=l.split(/\s+/); for(const x of w)if(x.length>3&&map[x])return map[x]; if(map[w[w.length-1]])return map[w[w.length-1]]; }
  return null;
}

// Pitcher stats + game logs (last 3 starts)
async function fetchPitcherFull(pid) {
  if (!pid) return null;
  try {
    const [sResp, gResp] = await Promise.all([
      fetch(`https://statsapi.mlb.com/api/v1/people/${pid}/stats?stats=season&season=2026&group=pitching`),
      fetch(`https://statsapi.mlb.com/api/v1/people/${pid}/stats?stats=gameLog&season=2026&group=pitching`)
    ]);
    let season = (await sResp.json()).stats?.[0]?.splits?.[0]?.stat;
    if (!season || !season.inningsPitched || season.inningsPitched === "0.0") {
      const fb = await fetch(`https://statsapi.mlb.com/api/v1/people/${pid}/stats?stats=season&season=2025&group=pitching`);
      season = (await fb.json()).stats?.[0]?.splits?.[0]?.stat;
      if (season) season._prior = true;
    }
    let recentStarts = [];
    try {
      const gl = (await gResp.json()).stats?.[0]?.splits || [];
      recentStarts = gl.slice(-3).map(s => ({ ip: parseFloat(s.stat?.inningsPitched||"0"), er: s.stat?.earnedRuns||0, h: s.stat?.hits||0, k: s.stat?.strikeOuts||0, bb: s.stat?.baseOnBalls||0 }));
    } catch {}
    let recentERA = null;
    if (recentStarts.length > 0) {
      const tIP = recentStarts.reduce((a,s)=>a+s.ip,0), tER = recentStarts.reduce((a,s)=>a+s.er,0);
      recentERA = tIP > 0 ? Math.round(tER/tIP*9*100)/100 : null;
    }
    if (!season) return null;
    return { era:season.era||"0.00", whip:season.whip||"0.00", wins:season.wins||0, losses:season.losses||0, k:season.strikeOuts||0, ip:season.inningsPitched||"0.0", hr:season.homeRuns||0, bb:season.baseOnBalls||0, gs:season.gamesStarted||0, fromPrior:!!season._prior, recentStarts, recentERA, k9:parseFloat(season.inningsPitched)>0?(season.strikeOuts/parseFloat(season.inningsPitched)*9).toFixed(1):"0.0" };
  } catch { return null; }
}

// API-SPORTS: Team batting (hits, walks, total bases, at bats, doubles, triples, HRs for ISO)
async function fetchTeamBatting() {
  const key = process.env.API_SPORTS_KEY;
  if (!key) return {};
  try {
    const resp = await fetch("https://v1.baseball.api-sports.io/teams/statistics?league=1&season=2026", { headers: { "x-apisports-key": key } });
    if (!resp.ok) return {};
    const data = await resp.json();
    const teams = {};
    for (const t of (data.response || [])) {
      const name = (t.team?.name || "").toLowerCase();
      const gp = t.games?.played || 1;
      const ab = t.games?.at_bats?.total || 0;
      const hits = t.games?.hits?.total?.total || 0;
      const doubles = t.games?.doubles?.total || 0;
      const triples = t.games?.triples?.total || 0;
      const hr = t.games?.home_runs?.total || 0;
      const walks = t.games?.bases_on_balls?.total || 0;
      const tb = t.games?.total_bases?.total || 0;
      // Item #4: ISO = (2B + 2*3B + 3*HR) / AB = extra bases / AB
      const extraBases = doubles + triples * 2 + hr * 3;
      const iso = ab > 0 ? extraBases / ab : 0.140;
      // Item #3: Walk rate = BB / (AB + BB) — plate discipline
      const walkRate = (ab + walks) > 0 ? walks / (ab + walks) : 0.08;
      if (name) teams[name] = { rpg: parseFloat(t.games?.runs?.total?.average)||0, hpg: parseFloat(t.games?.hits?.total?.average)||0, hits, walks, totalBases: tb, atBats: ab, gp, iso, walkRate, hr, doubles, triples };
    }
    return teams;
  } catch { return {}; }
}

// Odds API
async function fetchOdds() {
  const key = process.env.ODDS_API_KEY;
  if (!key) return { error: "No key", games: [] };
  try {
    const r = await fetch(`https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${key}&regions=us&markets=totals,spreads,h2h&oddsFormat=american`);
    return { games: await r.json()||[], remaining: r.headers.get("x-requests-remaining") };
  } catch (e) { return { error: e.message, games: [] }; }
}

function fuzzy(a,b){if(!a||!b)return false;const x=a.toLowerCase().replace(/[^a-z0-9]/g," ").trim(),y=b.toLowerCase().replace(/[^a-z0-9]/g," ").trim();if(x===y||x.includes(y)||y.includes(x))return true;return x.split(/\s+/).filter(w=>w.length>3).some(w=>y.split(/\s+/).filter(v=>v.length>3).includes(w));}

function parseOdds(og,aN,hN,aA,hA){
  if(!og?.length)return null;
  let m=og.find(o=>(fuzzy(o.away_team,aN)||fuzzy(o.away_team,aA))&&(fuzzy(o.home_team,hN)||fuzzy(o.home_team,hA)));
  if(!m)m=og.find(o=>fuzzy(o.away_team,aN)||fuzzy(o.home_team,hN));
  if(!m)return null;
  let cT=0,tC=0,mn=999,mx=0,sL=0,sC=0,fv="",aM=0,hM=0;
  for(const b of(m.bookmakers||[]))for(const k of(b.markets||[])){
    if(k.key==="totals")for(const o of(k.outcomes||[]))if(o.name==="Over"&&o.point){cT+=o.point;tC++;if(o.point<mn)mn=o.point;if(o.point>mx)mx=o.point;}
    if(k.key==="spreads")for(const o of(k.outcomes||[]))if(o.point&&o.point<0){sL+=Math.abs(o.point);sC++;fv=o.name;}
    if(k.key==="h2h")for(const o of(k.outcomes||[])){{if(fuzzy(o.name,aN)||fuzzy(o.name,aA))aM=o.price;if(fuzzy(o.name,hN)||fuzzy(o.name,hA))hM=o.price;}}
  }
  return{total:tC>0?Math.round(cT/tC*10)/10:0,books:tC,range:{min:mn<999?mn:0,max:mx},spread:sC>0?Math.round(sL/sC*10)/10:0,fav:fv?(fuzzy(fv,hN)||fuzzy(fv,hA)?hA:aA):"",awayML:aM,homeML:hM};
}

function findTeamStats(standings, teamBatting, abbr, fullName) {
  const n = norm(abbr);
  return standings[n] || standings[abbr] || standings[fullName?.toLowerCase()] || null;
}

function findBatting(teamBatting, fullName) {
  if (!fullName) return null;
  const l = fullName.toLowerCase();
  if (teamBatting[l]) return teamBatting[l];
  const words = l.split(/\s+/);
  for (const w of words) if (w.length > 3 && teamBatting[w]) return teamBatting[w];
  return null;
}

// ==========================================
// SABERMETRIC PREDICTION ENGINE
// ==========================================
function buildPrediction(g, odds, awayP, homeP, parkFactor, standings, teamBatting) {
  const line = odds?.total || g.total || 8.5;
  const hasSP = !!(awayP?.name || homeP?.name);
  
  // --- PITCHER DATA ---
  const rawAwayERA = parseFloat(awayP?.era) || 4.50;
  const rawHomeERA = parseFloat(homeP?.era) || 4.50;
  const awayWHIP = parseFloat(awayP?.whip) || 1.35;
  const homeWHIP = parseFloat(homeP?.whip) || 1.35;
  
  // Calibration #3: Regress ERA toward league average to prevent wild swings
  // regressedERA = (rawERA + LEAGUE_AVG_ERA) / 2
  const awayERA = (rawAwayERA + LEAGUE_AVG_ERA) / 2;
  const homeERA = (rawHomeERA + LEAGUE_AVG_ERA) / 2;
  
  // Weighted ERA: 60% last 3 starts (regressed), 40% season (regressed)
  const awayRecentRegressed = awayP?.recentERA != null ? (awayP.recentERA + LEAGUE_AVG_ERA) / 2 : awayERA;
  const homeRecentRegressed = homeP?.recentERA != null ? (homeP.recentERA + LEAGUE_AVG_ERA) / 2 : homeERA;
  const awayEffERA = awayP?.recentERA != null ? awayRecentRegressed * 0.6 + awayERA * 0.4 : awayERA;
  const homeEffERA = homeP?.recentERA != null ? homeRecentRegressed * 0.6 + homeERA * 0.4 : homeERA;

  // --- TEAM DATA (Improvement #1: Pythagorean Win%) ---
  const awayTeam = findTeamStats(standings, teamBatting, g.awayAbbr, g.away);
  const homeTeam = findTeamStats(standings, teamBatting, g.homeAbbr, g.home);
  const awayPyth = awayTeam?.pyth || 0.5;
  const homePyth = homeTeam?.pyth || 0.5;
  const awayRPG = awayTeam?.rpg || 4.5;
  const homeRPG = homeTeam?.rpg || 4.5;
  const awayRAPG = awayTeam?.rapg || 4.5;
  const homeRAPG = homeTeam?.rapg || 4.5;
  const hasPyth = !!(awayTeam?.rs && homeTeam?.rs);

  // --- LOG-5 WIN PROBABILITY (Improvement #2) ---
  // Use Pythagorean if available, otherwise fall back to ML odds
  const mlAwayWP = mlToProb(odds?.awayML);
  const mlHomeWP = mlToProb(odds?.homeML);
  const log5Away = hasPyth ? log5WinProb(awayPyth, homePyth) : mlAwayWP;
  const log5Home = hasPyth ? 1 - log5Away : mlHomeWP;
  // Calibration #2: Dampen ML edge with 60% Vegas / 40% Log-5 blend
  // This prevents overconfident edges (20%+ divergences from market)
  const awayWP = hasPyth ? (mlAwayWP * 0.6 + log5Away * 0.4) : mlAwayWP;
  const homeWP = hasPyth ? (mlHomeWP * 0.6 + log5Home * 0.4) : mlHomeWP;
  const maxWP = Math.max(awayWP, homeWP);
  const favAbbr = homeWP > awayWP ? g.homeAbbr : g.awayAbbr;

  // --- RUNS CREATED MOMENTUM (Improvement #3) ---
  const awayBat = findBatting(teamBatting, g.away);
  const homeBat = findBatting(teamBatting, g.home);
  let awayRC = 0, homeRC = 0, hasRC = false;
  if (awayBat?.hits && awayBat?.atBats) { awayRC = runsCreated(awayBat.hits, awayBat.walks||0, awayBat.totalBases||awayBat.hits, awayBat.atBats) / awayBat.gp; hasRC = true; }
  if (homeBat?.hits && homeBat?.atBats) { homeRC = runsCreated(homeBat.hits, homeBat.walks||0, homeBat.totalBases||homeBat.hits, homeBat.atBats) / homeBat.gp; hasRC = true; }
  // RC momentum: if team is creating runs above average (4.5), it's a boost
  const avgRC = 4.5;
  const awayMomentum = hasRC && awayRC > 0 ? (awayRC / avgRC) : 1.0;
  const homeMomentum = hasRC && homeRC > 0 ? (homeRC / avgRC) : 1.0;

  // --- RUN PROJECTION ---
  // Item #1: Blend starter ERA (60%) with team bullpen/relief ERA (40%)
  const awayTeamRelief = awayTeam?.reliefERA || 4.20;
  const homeTeamRelief = homeTeam?.reliefERA || 4.20;
  const awayPitchScore = awayEffERA * 0.6 + awayTeamRelief * 0.4;
  const homePitchScore = homeEffERA * 0.6 + homeTeamRelief * 0.4;
  
  const awayStRuns = (awayPitchScore / 9) * 5.5;
  const homeStRuns = (homePitchScore / 9) * 5.5;
  const bpRuns = 1.2; // Reduced since bullpen ERA is now in pitchScore
  const earlySzn = Math.max(1, Math.floor((Date.now() - new Date("2026-03-27").getTime()) / 86400000));
  const earlyFactor = earlySzn <= 14 ? 0.95 : 1.0;

  // Item #4: ISO power multiplier — teams with high ISO (>.160) hit more extra base hits
  const awayISO = awayBat?.iso || 0.140;
  const homeISO = homeBat?.iso || 0.140;
  const avgISO = 0.140;
  const awayPowerMult = 1.0 + (awayISO - avgISO) * 2.0; // +/- up to 8% adjustment
  const homePowerMult = 1.0 + (homeISO - avgISO) * 2.0;

  // Runs each team scores = (what opposing pitching allows) * park * momentum * power * early
  const homeScores = ((awayStRuns + bpRuns) * parkFactor * homeMomentum * homePowerMult * earlyFactor);
  const awayScores = ((homeStRuns + bpRuns) * awayMomentum * awayPowerMult * earlyFactor);
  // Calibration #1: Apply league scoring adjustment
  const modelTotal = Math.round((homeScores + awayScores) * LEAGUE_SCORING_ADJUSTMENT * 10) / 10;

  // Split runs (NO TIES)
  const homeShare = 0.50 + (homeWP - 0.5) * 0.6;
  let projAway = Math.round(modelTotal * (1 - homeShare));
  let projHome = Math.round(modelTotal * homeShare);
  if (projAway === projHome) { if (homeWP >= awayWP) projHome++; else projAway++; }

  // --- VOTING ---
  let overW = 0, underW = 0;
  const reasons = [], dataSources = [];

  // Odds
  if (odds?.total && odds.books >= 2) dataSources.push(`Odds API: ${odds.books} books, line ${odds.total} (${odds.range.min}-${odds.range.max})`);

  // Pitcher model (3.0x / 1.5x)
  const pw = hasSP ? 3.0 : 1.5;
  const edge = modelTotal - line;
  if (Math.abs(edge) >= 0.3) {
    if (edge > 0) { overW += pw; reasons.push(`Pitcher model: ${modelTotal} > line ${line} (effERA: ${awayEffERA.toFixed(2)}/${homeEffERA.toFixed(2)})`); }
    else { underW += pw; reasons.push(`Pitcher model: ${modelTotal} < line ${line} (effERA: ${awayEffERA.toFixed(2)}/${homeEffERA.toFixed(2)})`); }
    dataSources.push(`Pitcher Model: Weighted ERA projection → ${modelTotal} runs (${pw}x weight)`);
  }

  // Recent form divergence (1.5x)
  if (awayP?.recentERA != null && Math.abs(awayP.recentERA - awayERA) > 1.0) {
    if (awayP.recentERA > awayERA) { overW += 0.75; reasons.push(`${g.awayAbbr} SP trending worse: L3 ${awayP.recentERA.toFixed(2)} vs szn ${awayERA}`); }
    else { underW += 0.75; reasons.push(`${g.awayAbbr} SP trending better: L3 ${awayP.recentERA.toFixed(2)} vs szn ${awayERA}`); }
  }
  if (homeP?.recentERA != null && Math.abs(homeP.recentERA - homeERA) > 1.0) {
    if (homeP.recentERA > homeERA) { overW += 0.75; reasons.push(`${g.homeAbbr} SP trending worse: L3 ${homeP.recentERA.toFixed(2)} vs szn ${homeERA}`); }
    else { underW += 0.75; reasons.push(`${g.homeAbbr} SP trending better: L3 ${homeP.recentERA.toFixed(2)} vs szn ${homeERA}`); }
  }
  if (awayP?.recentStarts?.length || homeP?.recentStarts?.length) dataSources.push(`Game Logs: ${Math.max(awayP?.recentStarts?.length||0, homeP?.recentStarts?.length||0)} recent starts (60% weight)`);

  // WHIP (1.0x)
  if (hasSP) {
    const cW = (awayWHIP + homeWHIP) / 2;
    if (cW > 1.40) { overW += 1.0; reasons.push(`WHIP ${cW.toFixed(2)} = high baserunners`); }
    else if (cW < 1.05) { underW += 1.0; reasons.push(`WHIP ${cW.toFixed(2)} = low baserunners`); }
    dataSources.push(`WHIP: Combined ${cW.toFixed(2)}`);
  }

  // Item #2: K/BB Ratio — pitchers with poor command (K/BB < 2.0) get blowout penalty
  if (hasSP) {
    const awayK = parseInt(awayP?.k) || 0, awayBB = parseInt(awayP?.bb) || 1;
    const homeK = parseInt(homeP?.k) || 0, homeBB = parseInt(homeP?.bb) || 1;
    const awayKBB = awayBB > 0 ? awayK / awayBB : 3.0;
    const homeKBB = homeBB > 0 ? homeK / homeBB : 3.0;
    if (awayKBB < 2.0) { overW += 0.75; reasons.push(`${g.awayAbbr} SP K/BB ${awayKBB.toFixed(1)} (poor command → blowup risk)`); }
    if (homeKBB < 2.0) { overW += 0.75; reasons.push(`${g.homeAbbr} SP K/BB ${homeKBB.toFixed(1)} (poor command → blowup risk)`); }
    dataSources.push(`K/BB Ratio: ${g.awayAbbr} ${awayKBB.toFixed(1)} / ${g.homeAbbr} ${homeKBB.toFixed(1)}`);
  }

  // Item #3: Walk rate consistency bonus — disciplined lineups are less likely to be shut out
  if (awayBat?.walkRate || homeBat?.walkRate) {
    const awayWR = awayBat?.walkRate || 0.08;
    const homeWR = homeBat?.walkRate || 0.08;
    if (awayWR > 0.10 || homeWR > 0.10) {
      overW += 0.5;
      const disciplined = awayWR > homeWR ? g.awayAbbr : g.homeAbbr;
      reasons.push(`${disciplined} high walk rate ${(Math.max(awayWR,homeWR)*100).toFixed(1)}% → consistent scoring`);
    }
    if (awayWR < 0.06 && homeWR < 0.06) {
      underW += 0.5;
      reasons.push(`Both teams low walk rates → shutout risk`);
    }
    dataSources.push(`Walk Rate: ${g.awayAbbr} ${(awayWR*100).toFixed(1)}% / ${g.homeAbbr} ${(homeWR*100).toFixed(1)}%`);
  }

  // Item #4: ISO power signal — high ISO teams drive OVER
  if (awayBat?.iso || homeBat?.iso) {
    const combinedISO = ((awayISO || 0.140) + (homeISO || 0.140)) / 2;
    if (combinedISO > 0.170) { overW += 1.0; reasons.push(`Power: combined ISO ${combinedISO.toFixed(3)} (above avg) → extra-base hits`); }
    else if (combinedISO < 0.110) { underW += 0.5; reasons.push(`Low power: combined ISO ${combinedISO.toFixed(3)} → singles-driven`); }
    dataSources.push(`ISO Power: ${g.awayAbbr} ${awayISO.toFixed(3)} / ${g.homeAbbr} ${homeISO.toFixed(3)} (avg .140)`);
  }

  // Item #1: Bullpen ERA signal
  if (awayTeam?.reliefERA || homeTeam?.reliefERA) {
    const aRelief = awayTeam?.reliefERA || 4.20;
    const hRelief = homeTeam?.reliefERA || 4.20;
    if (aRelief > 4.80 || hRelief > 4.80) { overW += 0.75; reasons.push(`Weak bullpen: ${aRelief > hRelief ? g.awayAbbr : g.homeAbbr} team ERA ${Math.max(aRelief,hRelief).toFixed(2)}`); }
    dataSources.push(`Bullpen ERA: ${g.awayAbbr} ${aRelief.toFixed(2)} / ${g.homeAbbr} ${hRelief.toFixed(2)} (40% of pitching score)`);
  }

  // Park (1.5x)
  if (parkFactor >= 1.05) { overW += 1.5; reasons.push(`Park: ${g.homeAbbr} +${((parkFactor-1)*100).toFixed(0)}% hitter-friendly`); }
  else if (parkFactor <= 0.96) { underW += 1.5; reasons.push(`Park: ${g.homeAbbr} -${((1-parkFactor)*100).toFixed(0)}% pitcher-friendly`); }
  dataSources.push(`Park Factor: ${g.homeAbbr} ${(parkFactor*100).toFixed(0)}%`);

  // Big favorite OVER (2.0x)
  if (maxWP >= 0.70) { overW += 2.0; reasons.push(`Blowout: ${favAbbr} ${(maxWP*100).toFixed(0)}% fav → OVER bias`); }
  else if (maxWP >= 0.62) { overW += 1.0; reasons.push(`Strong fav: ${favAbbr} ${(maxWP*100).toFixed(0)}%`); }

  // Pythagorean insight (1.0x)
  if (hasPyth) {
    const pythDiff = Math.abs(awayPyth - homePyth);
    if (pythDiff > 0.15) {
      const betterPyth = awayPyth > homePyth ? g.awayAbbr : g.homeAbbr;
      reasons.push(`Pythagorean: ${betterPyth} ${((Math.max(awayPyth,homePyth))*100).toFixed(0)}% talent edge`);
    }
    dataSources.push(`Pythagorean: ${g.awayAbbr} ${(awayPyth*100).toFixed(0)}% / ${g.homeAbbr} ${(homePyth*100).toFixed(0)}% (RS/RA based)`);
  }

  // Log-5 insight
  if (hasPyth) dataSources.push(`Log-5 WP: ${g.awayAbbr} ${(log5Away*100).toFixed(0)}% / ${g.homeAbbr} ${(log5Home*100).toFixed(0)}%`);

  // Runs Created momentum (1.0x)
  if (hasRC && (awayMomentum > 1.15 || homeMomentum > 1.15)) {
    overW += 1.0;
    const hotTeam = awayMomentum > homeMomentum ? g.awayAbbr : g.homeAbbr;
    reasons.push(`RC Momentum: ${hotTeam} creating ${Math.max(awayRC,homeRC).toFixed(1)} runs/gm (${((Math.max(awayMomentum,homeMomentum)-1)*100).toFixed(0)}% above avg)`);
    dataSources.push(`Runs Created: ${g.awayAbbr} ${awayRC.toFixed(1)}/gm, ${g.homeAbbr} ${homeRC.toFixed(1)}/gm (API-SPORTS)`);
  } else if (hasRC && (awayMomentum < 0.85 || homeMomentum < 0.85)) {
    underW += 1.0;
    const coldTeam = awayMomentum < homeMomentum ? g.awayAbbr : g.homeAbbr;
    reasons.push(`RC Momentum: ${coldTeam} creating only ${Math.min(awayRC,homeRC).toFixed(1)} runs/gm (cold)`);
  }

  if (earlyFactor < 1.0) { underW += 0.5; reasons.push(`Early season: -5% scoring adjustment`); dataSources.push(`Season: Week ${Math.ceil(earlySzn/7)}`); }

  // Pitcher display
  if (awayP?.name) { let s = `${g.awayAbbr} SP: ${awayP.name} (${awayP.era} ERA, ${awayP.whip} WHIP, ${awayP.wins}-${awayP.losses}, ${awayP.k9} K/9${awayP.fromPrior?" *2025":""})`; if (awayP.recentStarts?.length) s += ` | L${awayP.recentStarts.length}: ${awayP.recentERA?.toFixed(2)} ERA`; reasons.push(s); }
  else reasons.push(`${g.awayAbbr} SP: TBD (4.50 ERA default)`);
  if (homeP?.name) { let s = `${g.homeAbbr} SP: ${homeP.name} (${homeP.era} ERA, ${homeP.whip} WHIP, ${homeP.wins}-${homeP.losses}, ${homeP.k9} K/9${homeP.fromPrior?" *2025":""})`; if (homeP.recentStarts?.length) s += ` | L${homeP.recentStarts.length}: ${homeP.recentERA?.toFixed(2)} ERA`; reasons.push(s); }
  else reasons.push(`${g.homeAbbr} SP: TBD (4.50 ERA default)`);

  // Blended win prob display
  reasons.push(`Win prob: ${g.awayAbbr} ${(awayWP*100).toFixed(0)}% / ${g.homeAbbr} ${(homeWP*100).toFixed(0)}%${hasPyth ? " (Log-5 + ML blend)" : " (ML implied)"}`);
  if (awayTeam) reasons.push(`${g.awayAbbr}: ${awayTeam.rpg} RPG scored, ${awayTeam.rapg} RPG allowed (${awayTeam.w}-${awayTeam.l})`);
  if (homeTeam) reasons.push(`${g.homeAbbr}: ${homeTeam.rpg} RPG scored, ${homeTeam.rapg} RPG allowed (${homeTeam.w}-${homeTeam.l})`);

  // O/U call
  const totalW = overW + underW;
  const call = overW > underW ? "OVER" : underW > overW ? "UNDER" : "TOSS-UP";
  const agree = totalW > 0 ? Math.max(overW, underW) / totalW : 0.5;
  const absEdge = Math.abs(edge);

  // Confidence
  let conf = 30;
  if (hasSP) conf += 12;
  if (hasPyth) conf += 8;
  if (hasRC) conf += 5;
  if (absEdge >= 0.3 && absEdge <= 1.2) conf += 10;
  else if (absEdge > 1.2 && absEdge <= 2.5) conf += 16;
  else if (absEdge > 2.5 && absEdge <= 4.0) conf += 8;
  else if (absEdge > 4.0) conf += 2;
  conf += Math.min(10, reasons.filter(r=>!r.includes(" SP:")&&!r.startsWith("Win prob:")&&!r.includes("RPG")).length * 3);
  conf += Math.round(agree * 10);
  if (awayP?.recentStarts?.length >= 2 && homeP?.recentStarts?.length >= 2) conf += 5;
  if (maxWP >= 0.65) conf += 4;
  const strength = Math.min(88, Math.max(25, conf));

  // Calibration #4: Value bet confidence tiers
  // Calculate our model's edge vs market
  const modelFavProb = Math.max(awayWP, homeWP);
  const marketFavProb = Math.max(mlAwayWP, mlHomeWP); // Vegas implied
  const probEdge = Math.abs(modelFavProb - marketFavProb) * 100;
  let valueTier = "none";
  let valueFlag = "";
  if (probEdge >= 3 && probEdge <= 10) { valueTier = "value"; valueFlag = `Value bet: ${probEdge.toFixed(1)}% edge over market`; }
  else if (probEdge > 10 && probEdge <= 15) { valueTier = "strong_value"; valueFlag = `Strong value: ${probEdge.toFixed(1)}% edge`; }
  else if (probEdge > 15) { valueTier = "check_injuries"; valueFlag = `⚠️ ${probEdge.toFixed(1)}% edge - CHECK INJURIES/NEWS (model may be missing info)`; }
  if (valueFlag) reasons.push(valueFlag);

  // ML pick
  let mlPick = null, mlReason = "";
  const eraGap = awayEffERA - homeEffERA;
  if (hasSP && Math.abs(eraGap) > 0.8) { mlPick = eraGap > 0 ? g.homeAbbr : g.awayAbbr; mlReason = `${mlPick} SP ${Math.abs(eraGap).toFixed(2)} effERA edge`; }
  if (!mlPick && homeWP > 0.58) { mlPick = g.homeAbbr; mlReason = `${g.homeAbbr} ${(homeWP*100).toFixed(0)}% + home`; }
  else if (!mlPick && awayWP > 0.55) { mlPick = g.awayAbbr; mlReason = `${g.awayAbbr} ${(awayWP*100).toFixed(0)}% road fav`; }

  // RL pick
  let rlPick = null, rlReason = "";
  if (maxWP >= 0.68) { rlPick = favAbbr; rlReason = `${favAbbr} ${(maxWP*100).toFixed(0)}% fav`; }
  else if (hasSP && Math.abs(eraGap) > 1.5) { const b = eraGap > 0 ? g.homeAbbr : g.awayAbbr; rlPick = b; rlReason = `${b} dominant SP`; }

  return {
    consensus: {
      totalCall: call, strength, spreadCall: rlPick, spreadReason: rlReason,
      moneylinePick: mlPick, moneylineReason: mlReason,
      votes: { over: overW.toFixed(1), under: underW.toFixed(1) },
      reasons, dataSources, modelTotal,
      modelSpread: Math.round((projHome - projAway) * 10) / 10,
      awayPts: projAway, homePts: projHome, edgeSize: absEdge.toFixed(1),
      awayPitcher: awayP ? { ...awayP, rawERA: rawAwayERA, regressedERA: awayERA.toFixed(2) } : null,
      homePitcher: homeP ? { ...homeP, rawERA: rawHomeERA, regressedERA: homeERA.toFixed(2) } : null,
      parkFactor: parkFactor !== 1.0 ? parkFactor : null,
      awayWinProb: (awayWP*100).toFixed(0), homeWinProb: (homeWP*100).toFixed(0),
      awayPyth: hasPyth ? (awayPyth*100).toFixed(0) : null,
      homePyth: hasPyth ? (homePyth*100).toFixed(0) : null,
      valueTier, probEdge: probEdge.toFixed(1),
      projPace:null,tournamentRound:null,tournamentDiscount:null,liveProjectedTotal:null,awayKenPom:null,homeKenPom:null,recentFormTotal:0
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

  // All data in parallel (4 API calls)
  const [oddsData, pitcherData, standingsData, teamBatting] = await Promise.all([
    fetchOdds(), fetchMLBPitchers(), fetchTeamStandings(), fetchTeamBatting()
  ]);
  const pMap = pitcherData.map || {};
  const standings = standingsData.teams || {};

  const gameSummaries = games.map(g => ({
    ...g, odds: parseOdds(oddsData.games, g.away, g.home, g.awayAbbr, g.homeAbbr),
    awayPInfo: findPitcher(pMap, g.awayAbbr, g.away),
    homePInfo: findPitcher(pMap, g.homeAbbr, g.home)
  }));

  const toAnalyze = gameSummaries.filter(g => !locked[g.id] && g.status !== "final");

  const pPromises = [];
  for (const g of toAnalyze) {
    if (g.awayPInfo?.id) pPromises.push(fetchPitcherFull(g.awayPInfo.id).then(s=>({gid:g.id,side:"away",s,name:g.awayPInfo.name})));
    if (g.homePInfo?.id) pPromises.push(fetchPitcherFull(g.homePInfo.id).then(s=>({gid:g.id,side:"home",s,name:g.homePInfo.name})));
  }
  const pResults = await Promise.all(pPromises);
  const pitcherStats = {};
  for (const p of pResults) { if(!pitcherStats[p.gid])pitcherStats[p.gid]={};pitcherStats[p.gid][p.side]=p.s?{name:p.name,...p.s}:{name:p.name}; }

  const results = gameSummaries.map(g => {
    const odds = g.odds, status = g.status;
    if (locked[g.id]) return { id:g.id,status,sport:"mlb",awayScore:g.liveScore?.away??null,homeScore:g.liveScore?.home??null,clock:g.liveScore?.clock||"",currentTotal:locked[g.id].line||g.total,consensus:locked[g.id].consensus||null,lockedPrediction:locked[g.id],isNewPrediction:false,currentSpread:odds?.fav?`${odds.fav} -${odds.spread}`:null,oddsRange:odds?.range||null,numBooks:odds?.books||0,oddsSpread:odds?.fav?{fav:odds.fav,line:-odds.spread}:null,oddsTotal:odds?.total||null,oddsML:(odds?.awayML||odds?.homeML)?{away:odds.awayML,home:odds.homeML}:null,injuries:null };
    if (status === "final") return { id:g.id,status,sport:"mlb",awayScore:g.liveScore?.away??null,homeScore:g.liveScore?.home??null,clock:g.liveScore?.clock||"",currentTotal:odds?.total||g.total,currentSpread:odds?.fav?`${odds.fav} -${odds.spread}`:null,oddsRange:odds?.range||null,numBooks:odds?.books||0,oddsSpread:odds?.fav?{fav:odds.fav,line:-odds.spread}:null,oddsTotal:odds?.total||null,oddsML:(odds?.awayML||odds?.homeML)?{away:odds.awayML,home:odds.homeML}:null,consensus:null,lockedPrediction:null,noPregamePrediction:true,isNewPrediction:false,injuries:null };

    const pm = pitcherStats[g.id] || {};
    const pf = PARK_FACTORS[norm(g.homeAbbr)] || 1.0;
    const pred = buildPrediction(g, odds, pm.away, pm.home, pf, standings, teamBatting);

    return {
      id:g.id,status,sport:"mlb",awayScore:g.liveScore?.away??null,homeScore:g.liveScore?.home??null,
      clock:g.liveScore?.clock||null,currentTotal:pred.currentTotal,
      currentSpread:odds?.fav?`${odds.fav} -${odds.spread}`:null,
      oddsRange:odds?.range||null,numBooks:odds?.books||0,
      oddsSpread:odds?.fav?{fav:odds.fav,line:-odds.spread}:null,
      oddsTotal:odds?.total||null,
      oddsML:(odds?.awayML||odds?.homeML)?{away:odds.awayML||0,home:odds.homeML||0}:null,
      consensus:pred.consensus,
      isNewPrediction:status==="scheduled"||status===undefined,
      injuries:null
    };
  });

  return NextResponse.json({
    updates:results, analyzedCount:toAnalyze.length, sport:"mlb",
    sources:{
      oddsAPI:oddsData.error?`x ${oddsData.error}`:`OK ${oddsData.games?.length} (${oddsData.remaining} left)`,
      mlbStatsAPI:pitcherData.error?`x ${pitcherData.error}`:`OK ${pitcherData.count} pitchers`,
      standings:standingsData.error?`x ${standingsData.error}`:`OK ${Object.keys(standings).length} team entries`,
      apiSports:Object.keys(teamBatting).length>0?`OK ${Object.keys(teamBatting).length} teams`:"x no data",
      pitchers:`${Object.keys(pitcherStats).length}/${toAnalyze.length} with SP data`
    }
  });
}
