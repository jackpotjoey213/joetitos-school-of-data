// Model-percentage math (moved from components/Predictor.jsx, Nov 12, 2026).
// Pure functions, no React, no browser APIs — so the server-side cron
// route can compute the same lock percentages the UI shows.
// Do not change these without changing both callers together.
import { marketMarginHome } from "./grading.js";

export function normCdf(z) {
  // Abramowitz & Stegun 7.1.26 approximation, as in the original code.
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

export function pctFromEdge(diff, sigma) {
  return Math.round(Math.max(5, Math.min(95, normCdf(diff / sigma) * 100)));
}

export function perBetPcts(cons, sport, totalLine, spreadOdds, homeAbbr, awayAbbr) {
  if (!cons || cons.noPick) return { totalPct: null, spreadPct: null, mlPct: null, homeWinPct: null, awayWinPct: null };
  let totalPct = null, spreadPct = null;
  if (cons.totalCall && totalLine && cons.modelTotal != null) {
    const pOver = pctFromEdge(cons.modelTotal - totalLine, sport === "nfl" ? 13 : 20);
    totalPct = cons.totalCall === "OVER" ? pOver : cons.totalCall === "UNDER" ? 100 - pOver : 50;
  }
  const mkt = marketMarginHome(spreadOdds, homeAbbr);
  if (cons.spreadCall && mkt != null && cons.modelSpread != null) {
    const pHomeCover = pctFromEdge(cons.modelSpread - mkt, sport === "nfl" ? 13.5 : 12);
    spreadPct = cons.spreadCall === homeAbbr ? pHomeCover : 100 - pHomeCover;
  }
  const homeWinPct = cons.homeWinProb != null ? Math.round(parseFloat(cons.homeWinProb)) : null;
  const awayWinPct = cons.awayWinProb != null ? Math.round(parseFloat(cons.awayWinProb)) : null;
  const mlPct = cons.moneylinePick === homeAbbr ? homeWinPct : cons.moneylinePick === awayAbbr ? awayWinPct : null;
  return { totalPct, spreadPct, mlPct, homeWinPct, awayWinPct };
}
