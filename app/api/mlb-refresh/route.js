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

// --- MLB STATS API: Probable pitchers + team stats ---
async function fetchMLBSchedule() {
  try {
    const today = new Date().toISOString().split("T")[0];
    const resp = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${today}&hydrate=probablePitcher(note),team,linescore`, { cache: "no-store" });
    if (!resp.ok) return { error: `MLB API ${resp.status}`, games: [] };
    const data = await resp.json();
    const games = [];
    for (const date of (data.dates || [])) {
      for (const g of (date.games || [])) {
        const away = g.teams?.away;
        const home = g.teams?.home;
        const awayPitcher = away?.probablePitcher;
        const homePitcher = home?.probablePitcher;
        games.push({
          gamePk: g.gamePk,
          awayTeam: away?.team?.abbreviation || away?.team?.name || "",
          homeTeam: home?.team?.abbreviation || home?.team?.name || "",
          awayPitcher: awayPitcher ? { name: awayPitcher.fullName, id: awayPitcher.id, note: awayPitcher.note || "" } : null,
          homePitcher: homePitcher ? { name: homePitcher.fullName, id: homePitcher.id, note: homePitcher.note || "" } : null,
          awayRecord: `${away?.leagueRecord?.wins || 0}-${away?.leagueRecord?.losses || 0}`,
          homeRecord: `${home?.leagueRecord?.wins || 0}-${home?.leagueRecord?.losses || 0}`,
        });
      }
    }
    return { games };
  } catch (e) { return { error: e.message, games: [] }; }
}

// Fetch pitcher season stats
async function fetchPitcherStats(pitcherId) {
  if (!pitcherId) return null;
  try {
    const resp = await fetch(`https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=season&season=2026&group=pitching`, { cache: "no-store" });
    if (!resp.ok) return null;
    const data = await resp.json();
    const stats = data.stats?.[0]?.splits?.[0]?.stat;
    if (!stats) return null;
    return { era: stats.era || "0.00", whip: stats.whip || "0.00", wins: stats.wins || 0, losses: stats.losses || 0, strikeOuts: stats.strikeOuts || 0, inningsPitched: stats.inningsPitched || "0.0", homeRuns: stats.homeRuns || 0, baseOnBalls: stats.baseOnBalls || 0, gamesStarted: stats.gamesStarted || 0 };
  } catch { return null; }
}

async function fetchMLBOdds() {
  const key = process.env.ODDS_API_KEY;
  if (!key) return { error: "No key", games: [] };
  try {
    const resp = await fetch(`https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${key}&regions=us&markets=totals,spreads,h2h&oddsFormat=american`);
    const remaining = resp.headers.get("x-requests-remaining");
    if (!resp.ok) return { error: `${resp.status}`, games: [], remaining };
    const data = await resp.json();
    return { games: data || [], remaining };
  } catch (e) { return { error: e.message, games: [] }; }
}

async function askGemini(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { error: "No key" };
  try {
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 1500 } })
    });
    const data = await resp.json();
    if (data.error) return { error: data.error.message };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return text ? { text } : { error: "No text" };
  } catch (e) { return { error: e.message }; }
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

export async function POST(req) {
  const { games, lockedPredictions } = await req.json();
  const locked = lockedPredictions || {};

  // Fetch all data in parallel: Odds + MLB Stats API (probable pitchers)
  const [oddsData, mlbData] = await Promise.all([
    fetchMLBOdds(),
    fetchMLBSchedule()
  ]);

  const gameSummaries = games.map(g => {
    const odds = parseOddsForGame(oddsData.games, g.away, g.home, g.awayAbbr, g.homeAbbr);
    // Match MLB API data to this game
    const mlbGame = mlbData.games?.find(mg => 
      fuzzyMatch(mg.awayTeam, g.awayAbbr) || fuzzyMatch(mg.homeTeam, g.homeAbbr) ||
      fuzzyMatch(mg.awayTeam, g.away) || fuzzyMatch(mg.homeTeam, g.home)
    );
    return { ...g, liveOdds: odds, mlbInfo: mlbGame || null };
  });

  const gamesToAnalyze = gameSummaries.filter(g => {
    const status = g.status;
    return status !== "final" && status !== "live" && !locked[g.id];
  });

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
    pitcherMap[pr.gameId][pr.side] = { name: pr.name, ...pr.stats };
  }

  // Build Gemini prompt with REAL pitcher data
  let geminiPicks = [];
  let aiStatus = { gemini: "skipped" };

  if (gamesToAnalyze.length > 0) {
    const gameList = gamesToAnalyze.slice(0, 8).map(g => {
      const pm = pitcherMap[g.id] || {};
      let line = `Game ${g.id}: ${g.awayAbbr} (${g.awayRecord}) @ ${g.homeAbbr} (${g.homeRecord})`;
      if (g.liveOdds) line += ` | O/U ${g.liveOdds.consensusTotal}, ML: ${g.awayAbbr} ${g.liveOdds.awayML}/${g.homeAbbr} ${g.liveOdds.homeML}, RL: ${g.liveOdds.favTeam} -${g.liveOdds.spreadLine}`;
      if (pm.away) line += ` | Away SP: ${pm.away.name} (ERA ${pm.away.era}, WHIP ${pm.away.whip}, ${pm.away.wins}-${pm.away.losses}, ${pm.away.strikeOuts}K in ${pm.away.inningsPitched}IP)`;
      else line += ` | Away SP: TBD`;
      if (pm.home) line += ` | Home SP: ${pm.home.name} (ERA ${pm.home.era}, WHIP ${pm.home.whip}, ${pm.home.wins}-${pm.home.losses}, ${pm.home.strikeOuts}K in ${pm.home.inningsPitched}IP)`;
      else line += ` | Home SP: TBD`;
      const pf = PARK_FACTORS[g.homeAbbr];
      if (pf && pf !== 1.0) line += ` | Park: ${pf > 1.02 ? "hitter-friendly" : pf < 0.98 ? "pitcher-friendly" : "neutral"} (${(pf*100).toFixed(0)}%)`;
      return line;
    }).join("\n");

    const prompt = `Expert MLB analyst. Today's games with REAL starting pitcher stats:

${gameList}

ANALYZE each game considering:
1. Starting pitcher quality (ERA under 3.0 = ace, over 4.5 = vulnerable)
2. Pitcher handedness matchup vs opposing lineup
3. Park factor impact on total
4. Bullpen considerations (early season bullpens may be unreliable)
5. Weather if relevant
6. Recent team form

For O/U: Low combined ERA + pitcher-friendly park = UNDER. High ERA + hitter-friendly park = OVER.
For ML: Better pitcher + home field = strong lean.
For RL: Only pick run line favorite if pitcher matchup is dominant (ERA gap > 1.5).

JSON ONLY:
[{"id":<n>,"predAway":<n>,"predHome":<n>,"totalCall":"OVER"|"UNDER","totalReason":"<specific pitcher + park reasoning>","moneylinePick":"<abbr>","moneylineReason":"<specific>","runlinePick":"<abbr>","runlineReason":"<specific>","confidence":<1-10>,"keyMatchup":"<critical factor>"}]`;

    try {
      const resp = await Promise.race([
        askGemini(prompt).catch(e => ({ error: e.message })),
        new Promise(r => setTimeout(() => r({ error: "timeout" }), 8000))
      ]);
      const parse = (text) => { if (!text) return []; const m = text.match(/\[[\s\S]*?\]/); if (!m) return []; try { return JSON.parse(m[0]); } catch { return []; } };
      geminiPicks = parse(resp?.text);
      aiStatus.gemini = resp?.error ? `error: ${resp.error}` : (geminiPicks.length > 0 ? `ok (${geminiPicks.length})` : "no picks");
    } catch (e) { aiStatus.gemini = `error: ${e.message}`; }
  }

  const results = gameSummaries.map(g => {
    const odds = g.liveOdds;
    const status = g.status;
    const pm = pitcherMap[g.id] || {};

    // Final/live with lock
    if ((status === "final" || status === "live") && locked[g.id]) {
      return { id: g.id, status, awayScore: g.liveScore?.away ?? null, homeScore: g.liveScore?.home ?? null, clock: g.liveScore?.clock || "", currentTotal: locked[g.id].line || g.total, currentSpread: null, oddsRange: null, numBooks: 0, oddsSpread: null, oddsTotal: null, oddsML: null, consensus: locked[g.id].consensus || null, lockedPrediction: locked[g.id], isNewPrediction: false, injuries: null };
    }
    // Final/live without lock
    if (status === "final" || status === "live") {
      return { id: g.id, status, awayScore: g.liveScore?.away ?? null, homeScore: g.liveScore?.home ?? null, clock: g.liveScore?.clock || "", currentTotal: odds?.consensusTotal || g.total, currentSpread: odds?.favTeam ? `${odds.favTeam} -${odds.spreadLine}` : null, oddsRange: odds?.totalRange || null, numBooks: odds?.numBooks || 0, oddsSpread: odds?.favTeam ? { fav: odds.favTeam, line: -odds.spreadLine } : null, oddsTotal: odds?.consensusTotal || null, oddsML: (odds?.awayML || odds?.homeML) ? { away: odds.awayML, home: odds.homeML } : null, consensus: null, lockedPrediction: null, noPregamePrediction: true, isNewPrediction: false, injuries: null };
    }

    // --- SCHEDULED: Build prediction ---
    const gemini = geminiPicks.find(p => p.id === g.id) || {};
    const currentTotal = odds?.consensusTotal || g.total || 8.5;
    const parkFactor = PARK_FACTORS[g.homeAbbr] || 1.0;

    let overW = 0, underW = 0;
    const reasons = [];

    // Odds API info
    if (odds?.consensusTotal && odds.numBooks >= 2) {
      reasons.push(`Odds API: ${odds.numBooks} books avg ${odds.consensusTotal} (${odds.totalRange?.min}-${odds.totalRange?.max})`);
    }

    // Starting pitcher model (3.0x weight - primary signal for MLB)
    const awayERA = parseFloat(pm.away?.era) || 4.5;
    const homeERA = parseFloat(pm.home?.era) || 4.5;
    const combinedERA = (awayERA + homeERA) / 2;
    const eraBasedTotal = 7.0 + (combinedERA - 3.5) * 1.2; // Base 7 runs, adjusted by ERA
    const parkAdjTotal = eraBasedTotal * parkFactor;

    if (pm.away?.name || pm.home?.name) {
      if (parkAdjTotal > currentTotal + 0.3) { overW += 3.0; reasons.push(`Pitcher model: ${parkAdjTotal.toFixed(1)} > line ${currentTotal} (combined ERA ${combinedERA.toFixed(2)})`); }
      else if (parkAdjTotal < currentTotal - 0.3) { underW += 3.0; reasons.push(`Pitcher model: ${parkAdjTotal.toFixed(1)} < line ${currentTotal} (combined ERA ${combinedERA.toFixed(2)})`); }
      else { reasons.push(`Pitcher model: ${parkAdjTotal.toFixed(1)} near line ${currentTotal} (no edge)`); }
    }

    // Pitcher info display
    if (pm.away) reasons.push(`Away SP: ${pm.away.name} (${pm.away.era} ERA, ${pm.away.whip} WHIP, ${pm.away.wins}-${pm.away.losses})`);
    if (pm.home) reasons.push(`Home SP: ${pm.home.name} (${pm.home.era} ERA, ${pm.home.whip} WHIP, ${pm.home.wins}-${pm.home.losses})`);

    // Park factor signal (1.5x)
    if (parkFactor >= 1.05) { overW += 1.5; reasons.push(`Park: ${g.homeAbbr} +${((parkFactor-1)*100).toFixed(0)}% hitter-friendly`); }
    else if (parkFactor <= 0.96) { underW += 1.5; reasons.push(`Park: ${g.homeAbbr} ${((1-parkFactor)*100).toFixed(0)}% pitcher-friendly`); }

    // Gemini analysis (2.0x)
    if (gemini.totalCall === "OVER") { overW += 2.0; reasons.push(`Gemini: OVER (${gemini.totalReason || ""})`); }
    else if (gemini.totalCall === "UNDER") { underW += 2.0; reasons.push(`Gemini: UNDER (${gemini.totalReason || ""})`); }

    const totalW = overW + underW;
    const call = overW > underW ? "OVER" : underW > overW ? "UNDER" : "TOSS-UP";
    const agree = totalW > 0 ? (Math.max(overW, underW) / totalW) : 0.5;
    const sigCount = reasons.filter(r => !r.startsWith("Odds API:") && !r.startsWith("Away SP:") && !r.startsWith("Home SP:") && !r.startsWith("Park:")).length;
    const coverage = Math.min(1, sigCount / 2);
    const strength = Math.min(90, Math.max(30, Math.round((agree * 35) + (coverage * 35) + (gemini.confidence ? gemini.confidence * 2 : 10))));

    // Moneyline pick from Gemini or pitcher model
    let mlPick = gemini.moneylinePick || null;
    let mlReason = gemini.moneylineReason || "";
    if (!mlPick && pm.away && pm.home) {
      const betterPitcher = awayERA < homeERA - 0.5 ? g.awayAbbr : homeERA < awayERA - 0.5 ? g.homeAbbr : null;
      if (betterPitcher) { mlPick = betterPitcher; mlReason = `${betterPitcher} has better SP (ERA gap: ${Math.abs(awayERA - homeERA).toFixed(2)})`; }
    }

    // Run line pick
    let rlPick = gemini.runlinePick || null;
    let rlReason = gemini.runlineReason || "";

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
        modelTotal: Math.round(parkAdjTotal * 10) / 10,
        modelSpread: 0,
        awayPts: gemini.predAway || Math.round(parkAdjTotal / 2),
        homePts: gemini.predHome || Math.round(parkAdjTotal / 2),
        projPace: null, tournamentRound: null, tournamentDiscount: null,
        liveProjectedTotal: null, awayKenPom: null, homeKenPom: null,
        recentFormTotal: 0, edgeSize: Math.abs(parkAdjTotal - currentTotal).toFixed(1),
        awayPitcher: pm.away || null, homePitcher: pm.home || null
      },
      geminiPred: { away: gemini.predAway, home: gemini.predHome, call: gemini.totalCall, reason: gemini.totalReason, keyFactor: gemini.keyMatchup },
      isNewPrediction: true, injuries: null
    };
  });

  return NextResponse.json({
    updates: results, analyzedCount: gamesToAnalyze.length, sport: "mlb",
    sources: {
      oddsAPI: oddsData.error ? `x ${oddsData.error}` : `OK ${oddsData.games.length} games (${oddsData.remaining} req left)`,
      mlbStatsAPI: mlbData.error ? `x ${mlbData.error}` : `OK ${mlbData.games.length} games with pitchers`,
      gemini: aiStatus.gemini
    }
  });
}
