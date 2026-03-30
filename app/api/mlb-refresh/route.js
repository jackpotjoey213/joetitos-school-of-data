import { NextResponse } from "next/server";

export const maxDuration = 30;

// Park factors: multiplier for total runs (1.0 = neutral, >1 = hitter-friendly)
const PARK_FACTORS = {
  COL: 1.18, // Coors Field
  CIN: 1.08, TEX: 1.06, BOS: 1.05, CHC: 1.04, PHI: 1.03,
  BAL: 1.03, MIL: 1.02, ATL: 1.02, MIN: 1.01, ARI: 1.01,
  LAA: 1.00, DET: 1.00, CLE: 1.00, TOR: 0.99, WSH: 0.99,
  PIT: 0.99, KC: 0.98, SEA: 0.98, STL: 0.98, SF: 0.97,
  SD: 0.97, HOU: 0.97, NYY: 0.97, CHW: 0.96, TB: 0.96,
  NYM: 0.96, OAK: 0.95, MIA: 0.95, LAD: 0.96
};

async function fetchMLBOdds() {
  const key = process.env.ODDS_API_KEY;
  if (!key) return { error: "No Odds API key", games: [] };
  try {
    const resp = await fetch(`https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${key}&regions=us&markets=totals,spreads,h2h&oddsFormat=american`);
    const remaining = resp.headers.get("x-requests-remaining");
    if (!resp.ok) return { error: `Odds API ${resp.status}`, games: [], remaining };
    const data = await resp.json();
    return { games: data || [], remaining };
  } catch (e) { return { error: e.message, games: [] }; }
}

async function askGemini(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { error: "No Gemini key" };
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
  let match = oddsGames.find(og =>
    (fuzzyMatch(og.away_team, awayName) || fuzzyMatch(og.away_team, awayAbbr)) &&
    (fuzzyMatch(og.home_team, homeName) || fuzzyMatch(og.home_team, homeAbbr))
  );
  if (!match) match = oddsGames.find(og =>
    fuzzyMatch(og.away_team, awayName) || fuzzyMatch(og.home_team, homeName)
  );
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

  const oddsData = await fetchMLBOdds();

  const gameSummaries = games.map(g => {
    const odds = parseOddsForGame(oddsData.games, g.away, g.home, g.awayAbbr, g.homeAbbr);
    return { ...g, liveOdds: odds };
  });

  const gamesToAnalyze = gameSummaries.filter(g => {
    const status = g.liveScore ? (g.status || "scheduled") : "scheduled";
    return status !== "final" && status !== "live" && !locked[g.id];
  });

  let geminiPicks = [];
  let aiStatus = { gemini: "skipped" };

  if (gamesToAnalyze.length > 0) {
    const gameList = gamesToAnalyze.slice(0, 10).map(g => {
      let line = `Game ${g.id}: ${g.awayAbbr} (${g.awayRecord}) vs ${g.homeAbbr} (${g.homeRecord})`;
      if (g.liveOdds) line += ` | O/U ${g.liveOdds.consensusTotal}, ML: ${g.awayAbbr} ${g.liveOdds.awayML}/${g.homeAbbr} ${g.liveOdds.homeML}, RL: ${g.liveOdds.favTeam} -${g.liveOdds.spreadLine}`;
      return line;
    }).join("\n");

    const prompt = `Expert MLB analyst. Today's games:

${gameList}

For EACH game research: probable starting pitchers (ERA, WHIP, record), bullpen strength, park factors, weather, recent team form, key injuries.

CRITICAL for O/U: Baseball totals are heavily driven by starting pitching. An ace (ERA under 3.0) vs a struggling pitcher (ERA over 4.5) changes the total by 1-2 runs. Park factors matter (Coors +15%, Oakland -5%).

For moneyline: Home field advantage is ~54% in MLB. Pitching matchup is the top factor.

JSON ONLY:
[{"id":<n>,"predAway":<n>,"predHome":<n>,"totalCall":"OVER"|"UNDER","totalReason":"<pitching matchup + park factor reasoning>","moneylinePick":"<team abbr>","moneylineReason":"<reasoning>","runlinePick":"<team abbr>","runlineReason":"<reasoning>","confidence":<1-10>,"awayPitcher":"<name + ERA or null>","homePitcher":"<name + ERA or null>","injuries":"<key injuries or null>","weather":"<if relevant or null>","parkFactor":"<park name + factor or null>"}]`;

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

    if ((status === "final" || status === "live") && locked[g.id]) {
      return { id: g.id, status, awayScore: g.liveScore?.away ?? null, homeScore: g.liveScore?.home ?? null, clock: g.liveScore?.clock || "", currentTotal: locked[g.id].line || g.total, currentSpread: null, oddsRange: null, numBooks: 0, oddsSpread: null, oddsTotal: null, oddsML: null, consensus: locked[g.id].consensus || null, lockedPrediction: locked[g.id], isNewPrediction: false, injuries: null };
    }
    if (status === "final" || status === "live") {
      return { id: g.id, status, awayScore: g.liveScore?.away ?? null, homeScore: g.liveScore?.home ?? null, clock: g.liveScore?.clock || "", currentTotal: odds?.consensusTotal || g.total, currentSpread: odds?.favTeam ? `${odds.favTeam} -${odds.spreadLine}` : null, oddsRange: odds?.totalRange || null, numBooks: odds?.numBooks || 0, oddsSpread: odds?.favTeam ? { fav: odds.favTeam, line: -odds.spreadLine } : null, oddsTotal: odds?.consensusTotal || null, oddsML: (odds?.awayML || odds?.homeML) ? { away: odds.awayML, home: odds.homeML } : null, consensus: null, lockedPrediction: null, noPregamePrediction: !locked[g.id], isNewPrediction: false, injuries: null };
    }

    // Scheduled game - build prediction
    const gemini = geminiPicks.find(p => p.id === g.id) || {};
    const currentTotal = odds?.consensusTotal || g.total || 8.5;
    const parkFactor = PARK_FACTORS[g.homeAbbr] || 1.0;

    // MLB prediction signals
    let overW = 0, underW = 0;
    const reasons = [];

    if (odds?.consensusTotal && odds.numBooks >= 2) {
      reasons.push(`Odds API: ${odds.numBooks} books avg ${odds.consensusTotal} (${odds.totalRange?.min}-${odds.totalRange?.max})`);
    }

    // Park factor signal
    if (parkFactor >= 1.05) { overW += 1.5; reasons.push(`Park factor: ${g.homeAbbr} ${(parkFactor*100-100).toFixed(0)}% hitter-friendly`); }
    else if (parkFactor <= 0.96) { underW += 1.5; reasons.push(`Park factor: ${g.homeAbbr} ${(100-parkFactor*100).toFixed(0)}% pitcher-friendly`); }

    // Gemini analysis (primary signal for MLB since we don't have a pitching model)
    if (gemini.totalCall === "OVER") { overW += 3.0; reasons.push(`Gemini: OVER (${gemini.totalReason || ""})`); }
    else if (gemini.totalCall === "UNDER") { underW += 3.0; reasons.push(`Gemini: UNDER (${gemini.totalReason || ""})`); }

    if (gemini.awayPitcher) reasons.push(`Away SP: ${gemini.awayPitcher}`);
    if (gemini.homePitcher) reasons.push(`Home SP: ${gemini.homePitcher}`);
    if (gemini.injuries) reasons.push(`Injuries: ${gemini.injuries}`);
    if (gemini.weather) reasons.push(`Weather: ${gemini.weather}`);
    if (gemini.parkFactor) reasons.push(`Park: ${gemini.parkFactor}`);

    const totalW = overW + underW;
    const call = overW > underW ? "OVER" : underW > overW ? "UNDER" : "TOSS-UP";
    const agree = totalW > 0 ? (Math.max(overW, underW) / totalW) : 0.5;
    const sigCount = reasons.filter(r => !r.startsWith("Odds API:") && !r.startsWith("Away SP:") && !r.startsWith("Home SP:") && !r.startsWith("Injuries:") && !r.startsWith("Weather:") && !r.startsWith("Park:")).length;
    const coverage = Math.min(1, sigCount / 2);
    const strength = Math.min(88, Math.max(30, Math.round((agree * 35) + (coverage * 35) + (gemini.confidence ? gemini.confidence * 3 : 15))));

    // Moneyline pick
    let mlPick = gemini.moneylinePick || null;
    let mlReason = gemini.moneylineReason || "";

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
        votes: { over: overW.toFixed(1), under: underW.toFixed(1) },
        reasons,
        modelTotal: gemini.predAway && gemini.predHome ? gemini.predAway + gemini.predHome : 0,
        modelSpread: 0,
        awayPts: gemini.predAway || 0, homePts: gemini.predHome || 0,
        projPace: null, tournamentRound: null, tournamentDiscount: null,
        liveProjectedTotal: null,
        awayKenPom: null, homeKenPom: null,
        recentFormTotal: 0, edgeSize: odds?.consensusTotal ? Math.abs((gemini.predAway||0)+(gemini.predHome||0) - odds.consensusTotal).toFixed(1) : "0"
      },
      geminiPred: { away: gemini.predAway, home: gemini.predHome, call: gemini.totalCall, reason: gemini.totalReason, awayPitcher: gemini.awayPitcher, homePitcher: gemini.homePitcher, injuries: gemini.injuries, weather: gemini.weather, parkFactor: gemini.parkFactor },
      isNewPrediction: true,
      injuries: gemini.injuries || null
    };
  });

  return NextResponse.json({
    updates: results, analyzedCount: gamesToAnalyze.length, sport: "mlb",
    sources: {
      oddsAPI: oddsData.error ? `x ${oddsData.error}` : `OK ${oddsData.games.length} games (${oddsData.remaining} req left)`,
      gemini: aiStatus.gemini
    }
  });
}
