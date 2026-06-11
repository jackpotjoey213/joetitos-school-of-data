/**
 * betEvaluator.js
 * Compares model outputs against live API closing odds.
 * Strips the house vig, calculates edge %, and pushes qualifying plays
 * to a valueBets array using the strict edge threshold filter.
 */

import { mlToProb, probToAmerican } from "./predictionEngine.js";

// ============================================================
// EDGE THRESHOLDS (from spec)
// ============================================================
const ML_EDGE_THRESHOLD = 0.035;   // 3.5% minimum ML edge
const TOTAL_CLV_THRESHOLD = 0.75;  // 0.75 runs minimum closing line value
const FRACTIONAL_KELLY = 0.25;     // 25% Kelly fraction (conservative)

// ============================================================
// VIG REMOVAL
// ============================================================

/**
 * Strip the sportsbook vig from a two-sided market (moneyline).
 * Returns true no-vig probabilities that sum to 1.0.
 * 
 * Three-sided market (with draw) supported via optional draw param.
 */
export function removeVig(homeML, awayML, drawML = null) {
  const rawHome = mlToProb(homeML) || 0;
  const rawAway = mlToProb(awayML) || 0;
  const rawDraw = drawML ? mlToProb(drawML) : 0;
  const totalOverround = rawHome + rawAway + rawDraw;
  if (totalOverround <= 0) return { home: 0.5, away: 0.5, draw: null };
  return {
    home: rawHome / totalOverround,
    away: rawAway / totalOverround,
    draw: drawML ? rawDraw / totalOverround : null,
    overround: totalOverround,
  };
}

/**
 * Strip vig from a totals market (over/under).
 */
export function removeVigTotals(overML, underML) {
  const rawOver = mlToProb(overML) || 0;
  const rawUnder = mlToProb(underML) || 0;
  const total = rawOver + rawUnder;
  if (total <= 0) return { over: 0.5, under: 0.5 };
  return { over: rawOver / total, under: rawUnder / total, overround: total };
}

// ============================================================
// EDGE CALCULATION
// ============================================================

/**
 * Calculate the betting edge:
 * Edge = Model Implied Probability - Sportsbook True Implied Probability (no-vig)
 * 
 * Returns: edge as a decimal (0.05 = 5% edge)
 */
export function calcEdge(modelProb, noVigMarketProb) {
  return modelProb - noVigMarketProb;
}

/**
 * Determine edge tier and flag.
 */
export function edgeTier(edgeDecimal) {
  const e = edgeDecimal * 100;
  if (e > 15) return { tier: "check_injuries", label: "⚠️ Check injuries/news" };
  if (e > 7)  return { tier: "strong_value",  label: "🟢 Strong value" };
  if (e > 3.5)return { tier: "value",         label: "🟢 Value bet" };
  if (e > 2)  return { tier: "lean",          label: "🟡 Lean" };
  return { tier: "no_edge", label: "🔴 No edge" };
}

// ============================================================
// KELLY CRITERION
// ============================================================

/**
 * Fractional Kelly Criterion (0.25x) for unit sizing.
 * f* = (b*p - q) / b  where b = decimal odds - 1
 * Returns: fraction of bankroll to bet (0 if no edge)
 */
export function kellySize(modelProb, marketAmericanOdds) {
  const b = marketAmericanOdds > 0
    ? marketAmericanOdds / 100
    : 100 / Math.abs(marketAmericanOdds);
  const p = modelProb;
  const q = 1 - p;
  const fullKelly = (b * p - q) / b;
  return Math.max(0, fullKelly * FRACTIONAL_KELLY);
}

// ============================================================
// BET EVALUATOR — MAIN FUNCTION
// ============================================================

/**
 * Evaluate a matchup against live odds and return qualifying value bets.
 * 
 * @param {object} prediction - Output from predictionEngine.runPredictions()
 * @param {object} matchupProfile - Output from dataAggregator.buildMatchupProfile()
 * @param {object} liveOdds - Live odds object: { homeML, awayML, totalLine, overML, underML, books }
 * @returns {object} { valueBets, reasons, mlEdge, ouEdge }
 */
export function evaluateBets(prediction, matchupProfile, liveOdds) {
  const valueBets = [];
  const reasons = [];

  if (!liveOdds || !prediction) {
    return { valueBets, reasons, mlEdge: 0, ouEdge: 0 };
  }

  const { homeML, awayML, totalLine, overML, underML, books } = liveOdds;

  // --- MONEYLINE EVALUATION ---
  const noVig = removeVig(homeML, awayML);
  const mlHomeEdge = calcEdge(prediction.homeWP, noVig.home);
  const mlAwayEdge = calcEdge(prediction.awayWP, noVig.away);
  const bestMLEdge = Math.abs(mlHomeEdge) > Math.abs(mlAwayEdge) ? mlHomeEdge : mlAwayEdge;
  const bestMLSide = Math.abs(mlHomeEdge) > Math.abs(mlAwayEdge) ? "home" : "away";
  const bestMLAbbr = bestMLSide === "home" ? matchupProfile.homeAbbr : matchupProfile.awayAbbr;
  const bestMLOdds = bestMLSide === "home" ? homeML : awayML;
  const bestMLModelProb = bestMLSide === "home" ? prediction.homeWP : prediction.awayWP;
  const bestMLMarketProb = bestMLSide === "home" ? noVig.home : noVig.away;

  const mlTier = edgeTier(bestMLEdge);

  // Apply threshold filter: only flag if edge >= 3.5%
  if (bestMLEdge >= ML_EDGE_THRESHOLD) {
    const kelly = kellySize(bestMLModelProb, bestMLOdds);
    valueBets.push({
      type: "ML",
      pick: bestMLAbbr,
      odds: bestMLOdds,
      modelProb: +(bestMLModelProb * 100).toFixed(1),
      marketProb: +(bestMLMarketProb * 100).toFixed(1),
      edge: +(bestMLEdge * 100).toFixed(1),
      kelly: +(kelly * 100).toFixed(1),
      kellyUnits: +kelly.toFixed(3),
      tier: mlTier.tier,
      label: mlTier.label,
    });
    reasons.push(`ML Edge: ${bestMLAbbr} model ${(bestMLModelProb*100).toFixed(1)}% vs market ${(bestMLMarketProb*100).toFixed(1)}% = +${(bestMLEdge*100).toFixed(1)}% edge`);
  } else {
    reasons.push(`ML: No edge (${(bestMLEdge*100).toFixed(1)}% — need ≥3.5%)`);
  }

  // --- TOTALS EVALUATION (Closing Line Value) ---
  let ouEdge = 0;
  if (totalLine && prediction.modelTotal) {
    const clv = Math.abs(prediction.modelTotal - totalLine); // Closing Line Value
    const modelIsOver = prediction.modelTotal > totalLine;

    if (clv >= TOTAL_CLV_THRESHOLD) {
      let ouEdgePct = 0, ouModelProb = 0, ouMarketProb = 0;

      if (overML && underML) {
        const noVigOU = removeVigTotals(overML, underML);
        ouModelProb = modelIsOver ? 0.55 + (clv * 0.04) : 0.55 + (clv * 0.04);
        ouModelProb = Math.min(0.75, ouModelProb);
        ouMarketProb = modelIsOver ? noVigOU.over : noVigOU.under;
        ouEdgePct = calcEdge(ouModelProb, ouMarketProb);
        ouEdge = ouEdgePct;
      }

      const ouTier = edgeTier(ouEdge > 0 ? ouEdge : 0.04); // At minimum CLV = lean
      const kelly = ouEdge > 0 ? kellySize(ouModelProb, modelIsOver ? (overML || -110) : (underML || -110)) : 0;

      valueBets.push({
        type: "OU",
        pick: modelIsOver ? `OVER ${totalLine}` : `UNDER ${totalLine}`,
        odds: modelIsOver ? (overML || -110) : (underML || -110),
        modelTotal: prediction.modelTotal,
        vegasLine: totalLine,
        clv: +clv.toFixed(1),
        edge: +(ouEdge * 100).toFixed(1),
        kelly: +(kelly * 100).toFixed(1),
        kellyUnits: +kelly.toFixed(3),
        tier: ouTier.tier,
        label: ouTier.label,
      });
      reasons.push(`CLV Edge: Model ${prediction.modelTotal} vs line ${totalLine} = ${clv.toFixed(1)} run CLV (${modelIsOver?"OVER":"UNDER"})`);
    } else {
      reasons.push(`O/U: CLV too small (${clv.toFixed(2)} runs — need ≥0.75)`);
    }
  }

  // --- PITCHING FLAGS ---
  if (matchupProfile.bothElite && prediction.hardCapped) {
    reasons.push(`⚡ Pitching hard-cap applied: both SPs with ERA < 3.50 → total capped at 8.5`);
  }
  if (matchupProfile.awayBlowupRisk) reasons.push(`⚠️ ${matchupProfile.awayAbbr} SP low K/BB (${matchupProfile.awayKBB}) — blowup risk`);
  if (matchupProfile.homeBlowupRisk) reasons.push(`⚠️ ${matchupProfile.homeAbbr} SP low K/BB (${matchupProfile.homeKBB}) — blowup risk`);

  return {
    valueBets: valueBets.sort((a, b) => b.edge - a.edge),
    reasons,
    mlEdge: +(bestMLEdge * 100).toFixed(1),
    ouEdge: +(ouEdge * 100).toFixed(1),
    overround: noVig.overround ? +(noVig.overround * 100).toFixed(1) : null,
  };
}
