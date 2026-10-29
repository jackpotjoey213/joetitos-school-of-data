// lib/nflModel.js — Transparent NFL game-line model (new for v2).
// NOT a copy of the NBA pace model: NFL scoring is points-per-game /
// yards-based, with a much smaller home-field edge and rest/weather
// effects that do not exist in basketball.
//
// Inputs are season PPG / OPPG from ESPN standings, opponent-adjusted
// below, plus rest, travel, and weather adjustments. This is a baseline
// model, not an EPA model: a deeper nflverse/EPA rating set is a
// documented future improvement (see README), not invented here.
//
// Limits, stated plainly:
//  - No player-level data, no injury data, no depth-chart data.
//    If a QB/OL injury is known, the UI must flag it manually — the
//    model does NOT silently adjust for it.
//  - No line-movement / sharp-money signal beyond the market ML blend.
//  - Early-season PPG is noisy (small sample); confidence is capped
//    until a team has played at least 4 games.

export function mlToProb(ml) {
  if (!ml) return 0.5;
  return ml < 0 ? Math.abs(ml) / (Math.abs(ml) + 100) : 100 / (ml + 100);
}

export function buildNFLPrediction({
  awayPPG, homePPG, awayOPPG, homeOPPG,
  gamesPlayed = 0,
  lineTotal = 0, lineSpread = 0, // lineSpread: signed, home perspective? caller passes absolute + fav
  spreadFav = "", homeAbbr = "", awayAbbr = "",
  awayML = 0, homeML = 0,
  rest = {}, // { away: {daysSinceLast, isShortWeek, isBye}, home: {...} }
  travelMiles = 0,
  weatherAdj = 0,
}) {
  const LEAGUE_PPG = 22; // ~ league average points per team per game; used only as a prior when data is missing
  const hasData = !!(awayPPG && homePPG && awayOPPG && homeOPPG);
  const aPPG = awayPPG || LEAGUE_PPG;
  const hPPG = homePPG || LEAGUE_PPG;
  const aOPPG = awayOPPG || LEAGUE_PPG;
  const hOPPG = homeOPPG || LEAGUE_PPG;

  // Opponent adjustment: a team's expected points = average of its
  // own offense and the opponent's points allowed. This is the NFL
  // analogue of the NBA offense-vs-defense adjustment, in PPG terms.
  let awayProj = (aPPG + hOPPG) / 2;
  let homeProj = (hPPG + aOPPG) / 2;

  const reasons = [];
  // Home field: NFL is ~1.5-2.5 pts, not basketball's +3.
  homeProj += 2.0;
  reasons.push("Home field +2.0");

  // Rest: short week (Thursday after Sunday, or <5 days since last
  // game) hurts; a bye week helps slightly. Values are documented
  // priors, not fitted secrets.
  const applyRest = (side, proj, label) => {
    if (!rest[side]) return proj;
    if (rest[side].isShortWeek) { reasons.push(`${label} short week (-1.5)`); return proj - 1.5; }
    if (rest[side].isBye) { reasons.push(`${label} bye week (+1.0)`); return proj + 1.0; }
    return proj;
  };
  awayProj = applyRest("away", awayProj, awayAbbr);
  homeProj = applyRest("home", homeProj, homeAbbr);

  // Travel: very long road trips only, capped and small.
  if (travelMiles >= 2000) { awayProj -= 0.5; reasons.push(`Long travel ${Math.round(travelMiles)} mi (-0.5 away)`); }

  // Weather total adjustment is applied symmetrically to the total,
  // split across both teams for the score projection.
  if (weatherAdj) {
    awayProj += weatherAdj / 2;
    homeProj += weatherAdj / 2;
  }

  const modelTotal = Math.round((awayProj + homeProj) * 10) / 10;
  const projAway = Math.round(awayProj * 10) / 10;
  const projHome = Math.round(homeProj * 10) / 10;
  const modelSpread = Math.round((projHome - projAway) * 10) / 10; // >0 = home winning margin

  // Win probability: 60% market ML + 40% model spread, same blend as NBA.
  const mlHomeWP = mlToProb(homeML);
  const mlAwayWP = mlToProb(awayML);
  const spreadWP = 0.5 + Math.max(-0.45, Math.min(0.45, modelSpread * 0.04));
  const homeWP = hasData ? mlHomeWP * 0.6 + spreadWP * 0.4 : mlHomeWP;
  const awayWP = 1 - homeWP;

  const edge = lineTotal ? modelTotal - lineTotal : 0;
  const totalCall = lineTotal ? (modelTotal > lineTotal ? "OVER" : modelTotal < lineTotal ? "UNDER" : "TOSS-UP") : null;

  // Spread pick: compare model margin to the market spread line.
  // lineSpread is the absolute market spread; spreadFav is the fav abbr.
  let spreadCall = null;
  if (lineSpread && spreadFav) {
    const marketMarginHome = spreadFav === homeAbbr ? lineSpread : -lineSpread;
    spreadCall = modelSpread > marketMarginHome ? homeAbbr : awayAbbr;
  }

  let mlPick = null;
  if (homeWP > 0.58) mlPick = homeAbbr;
  else if (awayWP > 0.58) mlPick = awayAbbr;

  // Confidence: capped, and lower with small samples or missing data.
  let conf = 30;
  if (hasData) conf += 15;
  if (gamesPlayed >= 4) conf += 10;
  const absEdge = Math.abs(edge);
  if (absEdge >= 2 && absEdge <= 6) conf += 14;
  else if (absEdge > 6 && absEdge <= 10) conf += 18;
  else if (absEdge > 10) conf += 5;
  const strength = Math.min(85, Math.max(25, conf));

  return {
    totalCall, spreadCall, moneylinePick: mlPick,
    modelTotal, modelSpread, awayPts: projAway, homePts: projHome,
    edgeSize: absEdge.toFixed(1), strength,
    awayWinProb: (awayWP * 100).toFixed(0), homeWinProb: (homeWP * 100).toFixed(0),
    reasons, hasData,
  };
}

// Live projection (separate from pregame): project ONLY remaining points.
// pregame: { awayPts, homePts, modelTotal }
// live: { awayScore, homeScore, period, clockSecondsRemainingInPeriod, totalMinutes }
// Returns null when a live pick must be withheld (OT, missing clock/model).
export function buildLiveProjection({ pregame, awayScore, homeScore, period, minutesRemainingInPeriod, totalMinutes, sport }) {
  if (!pregame || pregame.awayPts == null || pregame.homePts == null) return null;
  if (!period || period > 4) return null; // overtime: no live pick
  if (minutesRemainingInPeriod == null) return null;
  const periods = 4;
  const minutesPerPeriod = sport === "nba" ? 12 : 15;
  const total = totalMinutes || periods * minutesPerPeriod;
  const remaining = (periods - period) * minutesPerPeriod + minutesRemainingInPeriod;
  if (remaining <= 0 || remaining >= total) return null;
  const elapsed = total - remaining;
  const scored = awayScore + homeScore;
  const expectedPerMin = pregame.modelTotal / total;
  const actualPerMin = elapsed > 0 ? scored / elapsed : expectedPerMin;
  // Pace factor, clamped so one hot quarter cannot explode the projection.
  const paceFactor = Math.max(0.7, Math.min(1.3, expectedPerMin > 0 ? actualPerMin / expectedPerMin : 1));
  const remainingExpected = (pregame.modelTotal * (remaining / total)) * paceFactor;
  const projectedTotal = Math.round((scored + remainingExpected) * 10) / 10;
  // Split remaining points in the same ratio as the pregame projection.
  const awayShare = pregame.modelTotal > 0 ? pregame.awayPts / pregame.modelTotal : 0.5;
  const homeShare = 1 - awayShare;
  const projAwayFinal = Math.round((awayScore + remainingExpected * awayShare) * 10) / 10;
  const projHomeFinal = Math.round((homeScore + remainingExpected * homeShare) * 10) / 10;
  return {
    projectedTotal, projectedAway: projAwayFinal, projectedHome: projHomeFinal,
    projectedMargin: Math.round((projHomeFinal - projAwayFinal) * 10) / 10,
    minutesRemaining: Math.round(remaining * 10) / 10, paceFactor: Math.round(paceFactor * 100) / 100,
    scored,
  };
}
