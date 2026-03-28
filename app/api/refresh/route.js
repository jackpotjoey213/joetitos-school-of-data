import { NextResponse } from "next/server";
import { getTeamStats, kenpomPredict } from "@/lib/teamStats";

export const maxDuration = 30;

// --- DATA SOURCES ---
async function fetchOddsAPI() {
  const key = process.env.ODDS_API_KEY;
  if (!key) return { error: "No Odds API key", games: [] };
  try {
    const resp = await fetch(`https://api.the-odds-api.com/v4/sports/basketball_ncaab/odds/?apiKey=${key}&regions=us&markets=totals,spreads,h2h&oddsFormat=american`);
    const remaining = resp.headers.get("x-requests-remaining");
    if (!resp.ok) return { error: `Odds API ${resp.status}`, games: [], remaining };
    const data = await resp.json();
    if (!data || data.length === 0) return { error: "No active NCAAB odds", games: [], remaining };
    return { games: data, remaining };
  } catch (e) { return { error: e.message, games: [] }; }
}

async function fetchESPNScores() {
  try {
    const resp = await fetch("https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard", { next: { revalidate: 60 } });
    if (!resp.ok) return { error: `ESPN ${resp.status}`, events: [] };
    const data = await resp.json();
    return { events: data.events || [] };
  } catch (e) { return { error: e.message, events: [] }; }
}

async function askGemini(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { error: "No Gemini key" };
  const model = "gemini-2.5-flash-lite";
  try {
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 1500 } })
    });
    const data = await resp.json();
    if (data.error) return { error: `${model}: ${data.error.message}` };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    if (text) return { text, model };
    return { error: "No text" };
  } catch (e) { return { error: `${model}: ${e.message}` }; }
}

// --- PARSE ODDS ---
function fuzzyMatch(a, b) {
  if (!a || !b) return false;
  const x = a.toLowerCase().replace(/[^a-z0-9]/g, " ").trim();
  const y = b.toLowerCase().replace(/[^a-z0-9]/g, " ").trim();
  if (x.includes(y) || y.includes(x)) return true;
  return x.split(/\s+/).filter(w => w.length > 3).some(w => y.split(/\s+/).filter(v => v.length > 3).includes(w));
}

function parseOddsForGame(oddsGames, awayName, homeName, awayAbbr, homeAbbr, startTime) {
  if (!oddsGames?.length) return null;
  let match = null;
  if (startTime) {
    const gt = new Date(startTime).getTime();
    match = oddsGames.find(og => {
      const ot = new Date(og.commence_time).getTime();
      return Math.abs(ot - gt) < 3600000 && (fuzzyMatch(og.away_team, awayName) || fuzzyMatch(og.home_team, homeName) || fuzzyMatch(og.away_team, awayAbbr) || fuzzyMatch(og.home_team, homeAbbr));
    });
  }
  if (!match) match = oddsGames.find(og => (fuzzyMatch(og.away_team, awayName) || fuzzyMatch(og.away_team, awayAbbr)) && (fuzzyMatch(og.home_team, homeName) || fuzzyMatch(og.home_team, homeAbbr)));
  if (!match) match = oddsGames.find(og => fuzzyMatch(og.away_team, awayName) || fuzzyMatch(og.home_team, homeName) || fuzzyMatch(og.away_team, awayAbbr) || fuzzyMatch(og.home_team, homeAbbr));
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

function parseESPNForGame(events, awayAbbr, homeAbbr) {
  if (!events?.length) return null;
  for (const ev of events) {
    const c = ev.competitions?.[0]; if (!c) continue;
    const teams = c.competitors || [];
    const away = teams.find(t => t.homeAway === "away"), home = teams.find(t => t.homeAway === "home");
    if (!away || !home) continue;
    const aA = away.team?.abbreviation?.toUpperCase(), hA = home.team?.abbreviation?.toUpperCase();
    if ((aA === awayAbbr || aA === homeAbbr) || (hA === awayAbbr || hA === homeAbbr)) {
      const st = c.status?.type?.name;
      let status = "scheduled";
      if (st === "STATUS_IN_PROGRESS" || st === "STATUS_HALFTIME") status = "live";
      else if (st === "STATUS_FINAL") status = "final";
      return { awayScore: parseInt(away.score) || 0, homeScore: parseInt(home.score) || 0, status, detail: c.status?.type?.shortDetail || "", clock: c.status?.displayClock || "", period: c.status?.period || 0 };
    }
  }
  return null;
}

// --- TOURNAMENT ADJUSTMENTS ---
function getTournamentRound(conf) {
  if (!conf) return "tournament";
  const c = conf.toLowerCase();
  if (c.includes("sweet 16") || c.includes("sweet sixteen")) return "sweet16";
  if (c.includes("elite 8") || c.includes("elite eight")) return "elite8";
  if (c.includes("final four")) return "final4";
  if (c.includes("championship")) return "championship";
  if (c.includes("2nd round") || c.includes("second round")) return "round2";
  return "tournament";
}

function getTournamentDiscount(round, awayDE, homeDE) {
  const base = { round2: 0.96, sweet16: 0.94, elite8: 0.93, final4: 0.92, championship: 0.91, tournament: 0.97 }[round] || 0.97;
  const bothElite = (awayDE < 93 && homeDE < 93);
  const oneElite = (awayDE < 93 || homeDE < 93);
  if (bothElite) return base - 0.02;
  if (oneElite) return base - 0.01;
  return base;
}

// --- MAIN HANDLER ---
export async function POST(req) {
  const { games, lockedPredictions } = await req.json();
  const locked = lockedPredictions || {};

  const [oddsData, espnData] = await Promise.all([fetchOddsAPI(), fetchESPNScores()]);

  const gameSummaries = games.map(g => {
    const odds = parseOddsForGame(oddsData.games, g.away, g.home, g.awayAbbr, g.homeAbbr, g.startTime);
    const espn = parseESPNForGame(espnData.events, g.awayAbbr, g.homeAbbr);
    return { ...g, liveOdds: odds, espnScore: espn };
  });

  const gamesToAnalyze = gameSummaries.filter(g => {
    const status = g.espnScore?.status || g.status;
    return status !== "final" && status !== "live" && !locked[g.id];
  });

  let geminiPicks = [];
  let aiStatus = { gemini: "skipped" };

  if (gamesToAnalyze.length > 0 && gamesToAnalyze.length <= 12) {
    const aiGameList = gamesToAnalyze.slice(0, 8).map(g => {
      const aS = getTeamStats(g.awayAbbr), hS = getTeamStats(g.homeAbbr);
      let line = `Game ${g.id}: ${g.awayAbbr} (${aS ? '#'+aS.rank+' OE:'+aS.adjOE+' DE:'+aS.adjDE : '?'}) vs ${g.homeAbbr} (${hS ? '#'+hS.rank+' OE:'+hS.adjOE+' DE:'+hS.adjDE : '?'})`;
      if (g.liveOdds) line += ` | O/U ${g.liveOdds.consensusTotal}, ${g.liveOdds.favTeam} -${g.liveOdds.spreadLine}`;
      return line;
    }).join("\n");

    const round = getTournamentRound(gamesToAnalyze[0]?.conference);
    const prompt = `Expert NCAA basketball analyst. ${round.toUpperCase()} of March Madness 2026.

CRITICAL: Late-round tournament games (Sweet 16, Elite 8) score SIGNIFICANTLY lower than early rounds. Two elite defensive teams create grinding, low-scoring games. Factor this heavily.

GAMES:
${aiGameList}

For each game provide: predicted score, OVER/UNDER the total with reasoning, who covers spread with reasoning, confidence 1-10, injuries/fatigue notes, key matchup factor.

JSON ONLY:
[{"id":<n>,"predAway":<n>,"predHome":<n>,"totalCall":"OVER"|"UNDER","totalReason":"<specific>","spreadCall":"<abbr>","spreadReason":"<specific>","confidence":<1-10>,"injuries":"<or null>","fatigueFlag":"<or null>","keyMatchup":"<factor>"}]`;

    try {
      const resp = await Promise.race([
        askGemini(prompt).catch(e => ({ error: e.message })),
        new Promise(r => setTimeout(() => r({ error: "timeout" }), 7000))
      ]);
      const parse = (text) => { if (!text) return []; const m = text.match(/\[[\s\S]*?\]/); if (!m) return []; try { return JSON.parse(m[0]); } catch { return []; } };
      geminiPicks = parse(resp?.text);
      aiStatus.gemini = resp?.error ? `error: ${resp.error}` : (geminiPicks.length > 0 ? `ok (${geminiPicks.length})` : "no picks");
    } catch (e) { aiStatus.gemini = `error: ${e.message}`; }
  }

  const WEIGHTS = { model: 3.0, gemini: 2.0, recentForm: 1.0 };

  const results = gameSummaries.map(g => {
    const espn = g.espnScore, odds = g.liveOdds, status = espn?.status || g.status;

    if (status === "final" && locked[g.id]) return { id: g.id, status: "final", awayScore: espn?.awayScore ?? null, homeScore: espn?.homeScore ?? null, clock: espn?.detail || "FINAL", currentTotal: locked[g.id].line || g.total, currentSpread: null, oddsRange: null, numBooks: 0, oddsSpread: null, oddsTotal: null, oddsML: null, geminiPred: locked[g.id].geminiPred || null, consensus: locked[g.id].consensus || null, lockedPrediction: locked[g.id], isNewPrediction: false, awayScoreAdj: 0, homeScoreAdj: 0, injuries: null, trend: null, lineMove: null };
    if (status === "final") return { id: g.id, status: "final", awayScore: espn?.awayScore ?? null, homeScore: espn?.homeScore ?? null, clock: espn?.detail || "FINAL", currentTotal: odds?.consensusTotal || g.total, currentSpread: null, oddsRange: null, numBooks: 0, oddsSpread: null, oddsTotal: null, oddsML: null, geminiPred: null, consensus: null, lockedPrediction: null, noPregamePrediction: true, isNewPrediction: false, awayScoreAdj: 0, homeScoreAdj: 0, injuries: null, trend: null, lineMove: null };
    if (status === "live") return { id: g.id, status: "live", awayScore: espn?.awayScore ?? null, homeScore: espn?.homeScore ?? null, clock: espn?.detail || "", currentTotal: odds?.consensusTotal || locked[g.id]?.line || g.total, currentSpread: odds?.favTeam ? `${odds.favTeam} -${odds.spreadLine}` : null, oddsRange: odds?.totalRange || null, numBooks: odds?.numBooks || 0, oddsSpread: odds?.favTeam ? { fav: odds.favTeam, line: -odds.spreadLine } : null, oddsTotal: odds?.consensusTotal || null, oddsML: (odds?.awayML || odds?.homeML) ? { away: odds.awayML || 0, home: odds.homeML || 0 } : null, geminiPred: locked[g.id]?.geminiPred || null, consensus: locked[g.id]?.consensus || null, lockedPrediction: locked[g.id] || null, noPregamePrediction: !locked[g.id], isNewPrediction: false, awayScoreAdj: 0, homeScoreAdj: 0, injuries: null, trend: null, lineMove: null };

    // --- SCHEDULED: Build prediction ---
    const gemini = geminiPicks.find(p => p.id === g.id) || {};
    const aS = getTeamStats(g.awayAbbr) || {}, hS = getTeamStats(g.homeAbbr) || {};
    const round = getTournamentRound(g.conference);
    const discount = getTournamentDiscount(round, aS.adjDE || 100, hS.adjDE || 100);
    const D1 = 100;
    const pace = aS.tempo && hS.tempo ? Math.min(aS.tempo, hS.tempo) * 0.6 + Math.max(aS.tempo, hS.tempo) * 0.4 : 67;
    const aPPP = ((aS.adjOE || 105) * ((hS.adjDE || 100) / D1)) / 100;
    const hPPP = ((hS.adjOE || 105) * ((aS.adjDE || 100) / D1)) / 100;
    const aPts = Math.round(aPPP * pace * discount * 10) / 10;
    const hPts = Math.round(hPPP * pace * discount * 10) / 10;
    const modelTotal = Math.round((aPts + hPts) * 10) / 10;
    const modelSpread = Math.round((hPts - aPts) * 10) / 10;
    const currentTotal = odds?.consensusTotal || g.total;

    let overW = 0, underW = 0;
    const reasons = [];

    if (odds?.consensusTotal && odds.numBooks >= 2) reasons.push(`Odds API: ${odds.numBooks} books avg ${odds.consensusTotal} (${odds.totalRange?.min}-${odds.totalRange?.max})`);

    if (modelTotal > 0 && currentTotal > 0 && Math.abs(modelTotal - currentTotal) >= 2) {
      if (modelTotal > currentTotal) { overW += WEIGHTS.model; reasons.push(`KenPom (${round}): ${modelTotal} > line ${currentTotal} [${(discount*100).toFixed(0)}% adj]`); }
      else { underW += WEIGHTS.model; reasons.push(`KenPom (${round}): ${modelTotal} < line ${currentTotal} [${(discount*100).toFixed(0)}% adj]`); }
    }

    if (gemini.totalCall === "OVER") { overW += WEIGHTS.gemini; reasons.push(`Gemini: OVER (${gemini.totalReason || ""})`); }
    else if (gemini.totalCall === "UNDER") { underW += WEIGHTS.gemini; reasons.push(`Gemini: UNDER (${gemini.totalReason || ""})`); }

    const rfTotal = (aS.ppg || 72) + (hS.ppg || 72);
    if (rfTotal > 0 && currentTotal > 0 && Math.abs(rfTotal - currentTotal) >= 5) {
      if (rfTotal > currentTotal) { overW += WEIGHTS.recentForm; reasons.push(`PPG: ${rfTotal} > line ${currentTotal}`); }
      else { underW += WEIGHTS.recentForm; reasons.push(`PPG: ${rfTotal} < line ${currentTotal}`); }
    }

    if (gemini.injuries) reasons.push(`Injuries: ${gemini.injuries}`);
    if (gemini.fatigueFlag) reasons.push(`Fatigue: ${gemini.fatigueFlag}`);

    const totalW = overW + underW;
    const call = overW > underW ? "OVER" : underW > overW ? "UNDER" : "TOSS-UP";
    const agree = totalW > 0 ? (Math.max(overW, underW) / totalW) : 0.5;
    const sigCount = reasons.filter(r => !r.startsWith("Odds API:") && !r.startsWith("Injuries:") && !r.startsWith("Fatigue:")).length;
    const coverage = Math.min(1, sigCount / 3);
    const edge = modelTotal > 0 && currentTotal > 0 ? Math.abs(modelTotal - currentTotal) : 0;
    let edgeS = 0.5;
    if (edge >= 2 && edge <= 5) edgeS = 1.0;
    else if (edge > 5 && edge <= 8) edgeS = 0.85;
    else if (edge > 8 && edge <= 12) edgeS = 0.55;
    else if (edge > 12) edgeS = 0.3;
    else if (edge < 2) edgeS = 0.35;
    let lineT = 0.5;
    if (odds?.totalRange) { const sp = (odds.totalRange.max||0) - (odds.totalRange.min||0); if (sp <= 1 && edge > 8) lineT = 0.2; else if (sp <= 1 && edge > 5) lineT = 0.4; else if (sp <= 1) lineT = 0.65; else if (sp >= 3) lineT = 0.75; }
    const strength = Math.min(92, Math.max(28, Math.round((agree * 30) + (coverage * 30) + (edgeS * 20) + (lineT * 20))));

    // Spread model
    let spreadCall = null, spreadReason = "";
    const vSpread = odds?.spreadLine || 0, vFav = odds?.favTeam || "";
    if (modelSpread !== 0 && vSpread > 0) {
      const mFav = modelSpread > 0 ? g.homeAbbr : g.awayAbbr;
      const mMarg = Math.abs(modelSpread);
      if (mFav === vFav && mMarg < vSpread - 1.5) { spreadCall = mFav === g.homeAbbr ? g.awayAbbr : g.homeAbbr; spreadReason = `Model: ${mFav} by ${mMarg.toFixed(1)} but line -${vSpread} (underdog covers)`; }
      else if (mFav === vFav && mMarg > vSpread + 1.5) { spreadCall = mFav; spreadReason = `Model: ${mFav} by ${mMarg.toFixed(1)} vs -${vSpread} (fav covers)`; }
      else if (mFav !== vFav) { spreadCall = mFav; spreadReason = `Model disagrees on favorite: ${mFav}`; }
    }
    if (gemini.spreadCall && !spreadCall) { spreadCall = gemini.spreadCall; spreadReason = gemini.spreadReason || "Gemini"; }

    return {
      id: g.id, status: espn?.status || g.status,
      awayScore: espn?.awayScore ?? null, homeScore: espn?.homeScore ?? null,
      clock: espn?.detail || espn?.clock || null, currentTotal,
      currentSpread: odds?.favTeam ? `${odds.favTeam} -${odds.spreadLine}` : null,
      oddsRange: odds?.totalRange || null, numBooks: odds?.numBooks || 0,
      oddsSpread: odds?.favTeam ? { fav: odds.favTeam, line: -odds.spreadLine } : null,
      oddsTotal: odds?.consensusTotal || null,
      oddsML: (odds?.awayML || odds?.homeML) ? { away: odds.awayML || 0, home: odds.homeML || 0 } : null,
      geminiPred: { away: gemini.predAway, home: gemini.predHome, call: gemini.totalCall, reason: gemini.totalReason, spread: gemini.spreadCall, spreadReason: gemini.spreadReason, confidence: gemini.confidence, keyFactor: gemini.keyMatchup, injuries: gemini.injuries, fatigue: gemini.fatigueFlag },
      consensus: {
        totalCall: call, strength, spreadCall, spreadReason,
        confidence: Math.min(9, Math.max(3, Math.round(strength / 10))),
        votes: { over: overW.toFixed(1), under: underW.toFixed(1) }, reasons,
        modelTotal, modelSpread, projPace: pace.toFixed(1),
        tournamentRound: round, tournamentDiscount: discount,
        liveProjectedTotal: null,
        awayKenPom: { adjOE: aS.adjOE || 105, adjDE: aS.adjDE || 100, tempo: aS.tempo || 67, rank: aS.rank || null },
        homeKenPom: { adjOE: hS.adjOE || 105, adjDE: hS.adjDE || 100, tempo: hS.tempo || 67, rank: hS.rank || null },
        awayPts: Math.round(aPts), homePts: Math.round(hPts),
        recentFormTotal: rfTotal, edgeSize: edge.toFixed(1)
      },
      isNewPrediction: true, awayScoreAdj: 0, homeScoreAdj: 0,
      injuries: gemini.injuries || null, trend: null, lineMove: null
    };
  });

  return NextResponse.json({
    updates: results, analyzedCount: gamesToAnalyze.length,
    skippedFinal: gameSummaries.filter(g => (g.espnScore?.status || g.status) === "final").length,
    skippedLocked: Object.keys(locked).length,
    sources: {
      oddsAPI: oddsData.error ? `x ${oddsData.error}` : `OK ${oddsData.games.length} games (${oddsData.remaining} req left)`,
      espn: espnData.error ? `x ${espnData.error}` : `OK ${espnData.events?.length} events`,
      kenpomModel: `OK (${gamesToAnalyze.length} games, tournament-adjusted)`,
      gemini: aiStatus.gemini
    }
  });
}
