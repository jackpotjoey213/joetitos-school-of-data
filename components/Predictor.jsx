"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import { buildLiveProjection } from "@/lib/nflModel";

function mlToProb(ml) { if (!ml) return 0.5; return ml < 0 ? Math.abs(ml) / (Math.abs(ml) + 100) : 100 / (ml + 100); }
function americanToDecimal(odds) { return odds > 0 ? 1 + odds / 100 : 1 + 100 / Math.abs(odds); }
function decimalToAmerican(dec) { if (dec >= 2) return Math.round((dec - 1) * 100); return Math.round(-100 / (dec - 1)); }
function lockKeyFor(sport) { return sport === "nfl" ? "joetito_locked_nfl_v2" : "joetito_locked_nba_v2"; }
function getLocked(sport) { try { return JSON.parse(localStorage.getItem(lockKeyFor(sport)) || "{}"); } catch { return {}; } }
function lockPrediction(sport, gameId, pred) {
  try {
    const key = lockKeyFor(sport);
    const locked = JSON.parse(localStorage.getItem(key) || "{}");
    if (!locked[gameId]) { locked[gameId] = { ...pred, lockedAt: new Date().toISOString(), sport }; localStorage.setItem(key, JSON.stringify(locked)); }
    return locked;
  } catch { return {}; }
}
function parseClockMinutes(clock) {
  if (!clock) return null;
  const m = String(clock).match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return parseInt(m[1], 10) + parseInt(m[2], 10) / 60;
}
function todayStr(offsetDays = 0) {
  const d = new Date(); d.setDate(d.getDate() + offsetDays);
  return d.toISOString().split("T")[0];
}

// Per-market percentages, added to the ORIGINAL card layout (Oct 29, 2026)
// without changing that layout. Moneyline uses the model's own win
// probabilities. Over/Under and Spread use a normal-distribution estimate
// from model vs market line (NFL total ~13 pts, margin ~13.5 pts; NBA
// total ~20 pts, margin ~12 pts), clamped 5–95%. Estimates, not guarantees.
function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  p = 1 - p;
  return z > 0 ? p : 1 - p;
}
function pctFromEdge(diff, sigma) {
  return Math.round(Math.max(5, Math.min(95, normCdf(diff / sigma) * 100)));
}

// Completed-card fix (Oct 31, 2026): percentages are model % only, no
// market-implied % alongside. Grading is per market, from a frozen lock
// record: O/U by actual total vs locked total line, ATS by actual margin
// vs locked spread line (not just "did that team win"), ML by winner vs
// pick. A result exactly on the line is a push, not a win or loss.
// Dates use America/Los_Angeles so the tracker log date matches the
// card date (the old UTC grading date shifted some games by a day).
function ptDateStr(offsetDays = 0) {
  const d = new Date(); d.setDate(d.getDate() + offsetDays);
  return d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}
function ptDateFromIso(iso) {
  try { return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }); } catch { return ptDateStr(0); }
}
function marketMarginHome(spreadOdds, homeAbbr) {
  if (!spreadOdds || spreadOdds.fav == null || spreadOdds.line == null) return null;
  return spreadOdds.fav === homeAbbr ? -spreadOdds.line : spreadOdds.line;
}
function gradeTotal(actualTotal, line, call) {
  if (actualTotal == null || !line || !call) return null;
  if (actualTotal === line) return "push";
  return call === "OVER" ? actualTotal > line : actualTotal < line;
}
function gradeSpread(actualMarginHome, spreadOdds, spreadCall, homeAbbr, awayAbbr) {
  if (actualMarginHome == null || !spreadCall) return null;
  const mkt = marketMarginHome(spreadOdds, homeAbbr);
  if (mkt == null) return null;
  if (spreadCall === homeAbbr) return actualMarginHome === mkt ? "push" : actualMarginHome > mkt;
  if (spreadCall === awayAbbr) return (-actualMarginHome) === (-mkt) ? "push" : (-actualMarginHome) > (-mkt);
  return null;
}
function gradeML(actualWinner, pick) {
  if (!actualWinner || !pick) return null;
  return actualWinner === pick;
}
function gradeMark(v) { return v === true ? "✓ Right" : v === false ? "✗ Wrong" : v === "push" ? "Push" : "—"; }
function perBetPcts(cons, sport, totalLine, spreadOdds, homeAbbr, awayAbbr) {
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

function Tracker({ history, sport, trackerAvailable }) {
  const [window, setWindow] = useState("7d");
  const [showLog, setShowLog] = useState(false);
  const filteredAll = history.filter((h) => h.sport === sport);
  let filtered = filteredAll;
  if (window === "yesterday") filtered = filteredAll.filter((h) => h.date === ptDateStr(-1));
  else if (window === "7d") filtered = filteredAll.filter((h) => h.date >= ptDateStr(-7) && h.date <= ptDateStr(0));
  const n = filtered.length;
  const calc = (key) => {
    const graded = filtered.filter((h) => h[key] === true || h[key] === false);
    const wins = graded.filter((h) => h[key] === true).length;
    return { wins, losses: graded.length - wins, pct: graded.length ? ((wins / graded.length) * 100).toFixed(1) : "—", n: graded.length };
  };
  const ou = calc("totalCorrect"), ats = calc("spreadCorrect"), ml = calc("moneylineCorrect");
  const avgErr = n ? (filtered.reduce((a, h) => a + Math.abs(h.totalError || 0), 0) / n).toFixed(1) : "—";
  const streak = (key) => {
    let s = 0, dir = "";
    for (let i = filtered.length - 1; i >= 0; i--) {
      const v = filtered[i][key];
      if (v !== true && v !== false) continue;
      if (s === 0) { dir = v ? "W" : "L"; s = 1; }
      else if ((v && dir === "W") || (!v && dir === "L")) s++;
      else break;
    }
    return s ? `${s}${dir}` : "—";
  };
  return (
    <div style={{ margin: "0 12px 12px", padding: 14, borderRadius: 12, background: "#15151f", border: "1px solid #2a2a3a" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, color: sport === "nfl" ? "#22c55e" : "#f59e0b" }}>{sport.toUpperCase()} TRACK RECORD — PREGAME ONLY</span>
        <span style={{ fontSize: 10, color: "#94a3b8" }}>{n} games in window</span>
      </div>
      {!trackerAvailable && <div style={{ marginTop: 8, fontSize: 11, color: "#f59e0b" }}>⚠️ Tracker unavailable (Supabase not configured) — showing this session only. Configure NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY to persist the ledger.</div>}
      <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
        {[["yesterday", "Yesterday"], ["7d", "Last 7 Days"], ["season", "Season"]].map(([k, l]) => (
          <button key={k} onClick={() => setWindow(k)} style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #334155", background: window === k ? "#6366f1" : "#1e293b", color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>{l}</button>
        ))}
        <button onClick={() => setShowLog(!showLog)} style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #334155", background: "#1e293b", color: "#fff", fontSize: 11, cursor: "pointer" }}>{showLog ? "Hide log" : "Show per-game log"}</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, marginTop: 10 }}>
        {[
          ["O/U", `${ou.wins}-${ou.losses}`, `${ou.pct}%`, streak("totalCorrect")],
          ["ATS", `${ats.wins}-${ats.losses}`, `${ats.pct}%`, streak("spreadCorrect")],
          ["ML", `${ml.wins}-${ml.losses}`, `${ml.pct}%`, streak("moneylineCorrect")],
          ["Avg total error", avgErr, "pts", "—"],
        ].map(([l, v, s, st]) => (
          <div key={l} style={{ textAlign: "center", padding: "8px 4px", borderRadius: 8, background: "#0f0f1a" }}>
            <div style={{ fontSize: 15, fontWeight: 800 }}>{v}</div>
            <div style={{ fontSize: 10, color: "#94a3b8" }}>{s} {st !== "—" ? `• streak ${st}` : ""}</div>
            <div style={{ fontSize: 8, color: "#64748b", textTransform: "uppercase", fontWeight: 600 }}>{l}</div>
          </div>
        ))}
      </div>
      {n === 0 && <div style={{ textAlign: "center", fontSize: 11, color: "#94a3b8", marginTop: 8 }}>No graded pregame picks in this window yet. Hit Refresh before games start to lock picks.</div>}
      {n > 0 && n < 20 && <div style={{ textAlign: "center", fontSize: 11, color: "#f59e0b", marginTop: 8 }}>Small sample ({n} games) — win % is noisy. Do not over-interpret it.</div>}
      {showLog && (
        <div style={{ marginTop: 10, fontSize: 11 }}>
          {[...filtered].reverse().map((h, i) => (
            <div key={i} style={{ padding: "4px 0", borderBottom: "1px solid #1e293b" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <span>{h.date} {h.away} @ {h.home}</span>
                <span>Actual {h.actualTotal}{h.actualMarginHome != null ? ` • Margin ${h.actualMarginHome > 0 ? `${h.home} +${h.actualMarginHome}` : h.actualMarginHome < 0 ? `${h.away} +${Math.abs(h.actualMarginHome)}` : "Tie"}` : ""}</span>
              </div>
              <div style={{ color: "#94a3b8" }}>
                O/U {h.totalCall || "—"} {h.line} ({h.totalPct != null ? `${h.totalPct}%` : "—"}) → {gradeMark(h.totalCorrect)} •
                ATS {h.spreadCall || "—"}{h.spreadOdds ? ` ${h.spreadOdds.fav} ${h.spreadOdds.line}` : ""}{h.spreadPct != null ? ` (${h.spreadPct}%)` : ""} → {h.spreadCorrect == null && h.spreadCall ? "Can't grade (no spread line saved)" : gradeMark(h.spreadCorrect)} •
                ML {h.moneylinePick || "—"}{h.mlPct != null ? ` (${h.mlPct}%)` : ""} → {gradeMark(h.moneylineCorrect)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Mockup row layout (Oct 31, 2026): one small row per bet, % (or grade)
// on the right — the layout Joey approved in the mockups, replacing the
// single large wrapped pick line. Model % only, no market-implied %.

// ATS tracker fix (Nov 1, 2026): ONE source of truth for final grading.
// Cards and the tracker both use this helper, with the same inputs
// (stored lock + current refresh adj). Previously the card graded live
// from the lock + current spread, while the tracker log was built from a
// separate history record created at final time — so PHI and HOU showed
// ATS ✓ on their cards but "Can't grade" in the log, and the panel
// counted ATS 1-0 instead of the cards' 3-0. This helper is the card
// grade; the tracker merge below reuses it verbatim.
function finalGradeForGame(game, adj, sport) {
  const storedLocked = (() => { try { return getLocked(sport)[game.espnId || game.id] || null; } catch { return null; } })();
  const lockedRecord = adj.lockedPrediction || storedLocked;
  if (!lockedRecord) return { lockedRecord: null, effCons: null, effSpreadOdds: null, effTotalLine: null, effMlOdds: null, spreadCorrected: false, spreadCorrectionLabel: null, totalPct: null, spreadPct: null, mlPickPct: null, homeWinPct: null, awayWinPct: null, finalGrades: null };
  const rawEffCons = lockedRecord.consensus || adj.consensus;
  const effTotalLine = lockedRecord.line > 0 ? lockedRecord.line : (adj.oddsTotal && adj.oddsTotal > 0 ? adj.oddsTotal : (game.total && game.total > 0 ? game.total : null));
  const effSpreadOdds = lockedRecord.spreadOdds || adj.oddsSpread || null;
  const effMlOdds = lockedRecord.mlOdds || adj.oddsML || null;
  let effCons = rawEffCons, spreadCorrected = false, spreadCorrectionLabel = null;
  if (rawEffCons?.modelSpread != null && rawEffCons?.spreadCall && effSpreadOdds) {
    const mkt = marketMarginHome(effSpreadOdds, game.homeAbbr);
    if (mkt != null) {
      const diff = rawEffCons.modelSpread - mkt;
      const corrected = Math.abs(diff) >= 2 ? (rawEffCons.modelSpread > mkt ? game.homeAbbr : game.awayAbbr) : null;
      if (corrected && corrected !== rawEffCons.spreadCall) {
        effCons = { ...rawEffCons, spreadCall: corrected }; spreadCorrected = true;
        spreadCorrectionLabel = lockedRecord.spreadOdds
          ? "Spread pick corrected for the home-favorite bug (locked model score and lines unchanged)."
          : "Spread pick corrected using current market line (original lock did not save a spread line).";
      }
    }
  }
  const noPick = adj.consensus?.noPick;
  const pcts = effCons && !noPick ? perBetPcts(effCons, sport, effTotalLine, effSpreadOdds, game.homeAbbr, game.awayAbbr) : { totalPct: null, spreadPct: null, mlPct: null, homeWinPct: null, awayWinPct: null };
  const totalPct = lockedRecord.totalPct ?? pcts.totalPct;
  const spreadPctRaw = spreadCorrected ? pcts.spreadPct : (lockedRecord.spreadPct ?? pcts.spreadPct);
  // A spread pick below 50% is a desync between the locked pick and the
  // current model/market — never present it as a pick. Keep the original
  // pick for final grading (finalGrades uses effCons.spreadCall), but
  // mark it invalid for upcoming display.
  const spreadPickValid = spreadPctRaw == null || spreadPctRaw >= 50;
  const spreadPct = spreadPickValid ? spreadPctRaw : null;
  const mlPickPct = lockedRecord.mlPct ?? pcts.mlPct;
  let finalGrades = null;
  if (game.status === "final" && effCons && game.liveScore) {
    const at = game.liveScore.away + game.liveScore.home;
    const mHome = game.liveScore.home - game.liveScore.away;
    const winner = game.liveScore.away > game.liveScore.home ? game.awayAbbr : game.liveScore.home > game.liveScore.away ? game.homeAbbr : null;
    finalGrades = {
      actualTotal: at, actualMarginHome: mHome, actualWinner: winner,
      total: gradeTotal(at, lockedRecord.line, effCons.totalCall),
      spread: gradeSpread(mHome, effSpreadOdds, effCons.spreadCall, game.homeAbbr, game.awayAbbr),
      ml: gradeML(winner, effCons.moneylinePick),
    };
  }
  return { lockedRecord, effCons, effSpreadOdds, effTotalLine, effMlOdds, spreadCorrected, spreadCorrectionLabel, totalPct, spreadPct, spreadPickValid, mlPickPct, homeWinPct: pcts.homeWinPct, awayWinPct: pcts.awayWinPct, finalGrades };
}

function PickRow({ label, pick, detail, pct, grade, gradeColor }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 9, background: "#0f0f1a", border: "1px solid #2a2a3a", borderRadius: 9, padding: "8px 10px", marginBottom: 6 }}>
      <div style={{ width: 78, fontSize: 10, fontWeight: 700, color: "#94a3b8" }}>{label}</div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 800 }}>{pick}</div>
        {detail && <div style={{ fontSize: 11, color: "#94a3b8" }}>{detail}</div>}
      </div>
      {pct != null && <div style={{ fontSize: 18, fontWeight: 900, color: "#22c55e" }}>{pct}%</div>}
      {grade && <div style={{ fontSize: 14, fontWeight: 800, color: gradeColor || "#22c55e", textAlign: "right" }}>{grade}</div>}
    </div>
  );
}
function spreadDisplay(pick, spreadOdds) {
  if (!pick) return "—";
  if (!spreadOdds || spreadOdds.fav == null || spreadOdds.line == null) return pick;
  return pick === spreadOdds.fav ? `${spreadOdds.fav} ${spreadOdds.line}` : `${pick} +${Math.abs(spreadOdds.line)}`;
}

function ParlayBuilder({ legs, setLegs }) {
  const [stake, setStake] = useState(20);
  const [goal, setGoal] = useState(350);
  const [steps, setSteps] = useState(3);
  const [reinvest, setReinvest] = useState(100);
  const [manualLabel, setManualLabel] = useState("");
  const [manualOdds, setManualOdds] = useState(-110);
  const multiplier = stake > 0 ? goal / stake : 0;
  const r = reinvest / 100;
  let perStepMult = null;
  if (multiplier > 0 && steps > 0 && r > 0) {
    const base = Math.pow(multiplier, 1 / steps);
    perStepMult = (base - (1 - r)) / r;
  }
  const perStepAmerican = perStepMult && perStepMult > 1 ? decimalToAmerican(perStepMult) : null;
  // Ladder simulation with the solved per-step multiplier.
  const ladder = [];
  let running = stake;
  if (perStepMult && perStepMult > 1) {
    for (let i = 1; i <= steps; i++) {
      const bet = running * r;
      const after = (running - bet) + bet * perStepMult;
      ladder.push({ step: i, bet: Math.round(bet * 100) / 100, after: Math.round(after * 100) / 100 });
      running = after;
    }
  }
  const sameGame = new Set(legs.map((l) => l.gameId)).size !== legs.length;
  const impliedProb = multiplier > 0 ? (100 / multiplier).toFixed(1) : "—";
  const modelProb = legs.length && legs.every((l) => l.prob != null) ? (legs.reduce((a, l) => a * l.prob, 1) * 100).toFixed(1) : "—";
  return (
    <div style={{ margin: "0 12px 12px", padding: 14, borderRadius: 12, background: "#15151f", border: "1px solid #2a2a3a" }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, color: "#a855f7" }}>PARLAY BUILDER — LADDER, TOTAL BACK</div>
      <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 4 }}>Goal is total back including stake. A ladder resets on a losing step. This is math, not a guarantee — parlays/ladders compound the book edge and are high-variance.</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
        <label style={{ fontSize: 11 }}>Starting stake $ <input type="number" value={stake} onChange={(e) => setStake(parseFloat(e.target.value) || 0)} style={{ width: 80, padding: 6, borderRadius: 6, background: "#0f0f1a", color: "#fff", border: "1px solid #334155" }} /></label>
        <label style={{ fontSize: 11 }}>Goal total back $ <input type="number" value={goal} onChange={(e) => setGoal(parseFloat(e.target.value) || 0)} style={{ width: 80, padding: 6, borderRadius: 6, background: "#0f0f1a", color: "#fff", border: "1px solid #334155" }} /></label>
        <label style={{ fontSize: 11 }}>Steps <input type="number" min={1} max={10} value={steps} onChange={(e) => setSteps(parseInt(e.target.value) || 1)} style={{ width: 60, padding: 6, borderRadius: 6, background: "#0f0f1a", color: "#fff", border: "1px solid #334155" }} /></label>
        <label style={{ fontSize: 11 }}>Reinvest % <input type="number" min={1} max={100} value={reinvest} onChange={(e) => setReinvest(parseFloat(e.target.value) || 100)} style={{ width: 60, padding: 6, borderRadius: 6, background: "#0f0f1a", color: "#fff", border: "1px solid #334155" }} /></label>
      </div>
      <div style={{ fontSize: 12, marginTop: 10 }}>
        Required total multiplier: <b>{multiplier.toFixed(2)}x</b> • Per-step multiplier: <b>{perStepMult ? perStepMult.toFixed(2) + "x" : "—"}</b> • Per-step odds: <b>{perStepAmerican != null ? (perStepAmerican > 0 ? "+" + perStepAmerican : perStepAmerican) : "—"}</b> • Implied chance of the full ladder (fair odds): <b>{impliedProb}%</b> • Model chance from selected legs: <b>{modelProb}%</b>
      </div>
      {sameGame && <div style={{ color: "#f59e0b", fontSize: 11, marginTop: 6 }}>⚠️ Correlated same-game legs selected — their true combined probability is not simply the product of individual probabilities. Treat the model chance above as rough.</div>}
      <div style={{ marginTop: 10 }}>
        <b style={{ fontSize: 11 }}>Selected legs ({legs.length}) — add from game cards, or add a manual leg:</b>
        {legs.map((l, i) => (
          <div key={i} style={{ fontSize: 11, display: "flex", justifyContent: "space-between", gap: 8, padding: "3px 0" }}>
            <span>{l.label} ({l.odds > 0 ? "+" + l.odds : l.odds})</span>
            <button onClick={() => setLegs(legs.filter((_, j) => j !== i))} style={{ background: "transparent", border: "none", color: "#ef4444", cursor: "pointer" }}>Remove</button>
          </div>
        ))}
        {legs.length === 0 && <div style={{ fontSize: 11, color: "#94a3b8" }}>No legs selected yet. Use “Add ML to parlay” on a game card, or add a manual leg below.</div>}
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          <input placeholder="Manual leg label, e.g. GB -3.5" value={manualLabel} onChange={(e) => setManualLabel(e.target.value)} style={{ flex: 1, padding: 6, borderRadius: 6, background: "#0f0f1a", color: "#fff", border: "1px solid #334155" }} />
          <input type="number" value={manualOdds} onChange={(e) => setManualOdds(parseInt(e.target.value) || 0)} style={{ width: 90, padding: 6, borderRadius: 6, background: "#0f0f1a", color: "#fff", border: "1px solid #334155" }} />
          <button onClick={() => { if (manualLabel) { setLegs([...legs, { label: manualLabel, odds: manualOdds, gameId: "manual-" + manualLabel, prob: null }]); setManualLabel(""); } }} style={{ padding: "6px 10px", borderRadius: 6, background: "#6366f1", color: "#fff", border: "none", cursor: "pointer" }}>Add leg</button>
        </div>
      </div>
      {ladder.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 11 }}>
          <b>Ladder path (reinvest {reinvest}% each step, same per-step odds):</b>
          {ladder.map((s) => (<div key={s.step}>Step {s.step}: bet ${s.bet} → total back ${s.after}</div>))}
          <div style={{ color: "#94a3b8" }}>If any step loses, the ladder resets to the starting stake. No auto-betting — this is a calculator only.</div>
        </div>
      )}
    </div>
  );
}

export default function Predictor() {
  const [sport, setSport] = useState("nba");
  const [games, setGames] = useState([]);
  const [liveAdj, setLiveAdj] = useState({});
  const [history, setHistory] = useState([]);
  const [trackerAvailable, setTrackerAvailable] = useState(null);
  const [filter, setFilter] = useState("upcoming");
  const [expandedId, setExpandedId] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [sources, setSources] = useState(null);
  const [log, setLog] = useState("Loading games...");
  const [propsByGame, setPropsByGame] = useState({});
  const [propsLoading, setPropsLoading] = useState({});
  const [legs, setLegs] = useState([]);
  const refreshedSports = useRef(new Set());
  // Latest handleRefresh, so the auto-refresh timeout is not cancelled
  // when handleRefresh's identity changes (e.g. history loads) before
  // the timeout fires. See the auto-refresh effect below.

  const loadHistory = useCallback(async () => {
    try {
      const resp = await fetch("/api/settings");
      if (!resp.ok) { setTrackerAvailable(false); return; }
      const data = await resp.json();
      setTrackerAvailable(data.trackerAvailable !== false);
      const mapped = (data.predictions || []).map((p) => ({
        gameId: p.game_id, away: p.away_team, home: p.home_team,
        predictedTotal: +p.predicted_total, actualTotal: +p.actual_total,
        totalCall: p.total_call, line: +p.line, totalCorrect: p.total_correct,
        spreadCorrect: p.spread_correct, moneylineCorrect: p.moneyline_correct ?? null,
        spreadCall: p.spread_call || null, moneylinePick: p.moneyline_pick || null,
        totalError: +p.total_error, date: p.game_date, sport: p.sport || null,
      })).filter((h) => h.sport); // v2 tracker: only records with an explicit sport
      setHistory(mapped);
    } catch { setTrackerAvailable(false); }
  }, []);

  const loadGames = useCallback(async (sp) => {
    setGames([]); setLiveAdj({}); setSources(null); setLog("Loading games...");
    try {
      const endpoint = sp === "nfl" ? "/api/nfl-scores?days=1" : "/api/nba-scores?days=1";
      const resp = await fetch(endpoint);
      const data = await resp.json();
      setGames(data.games || []);
      setLog(data.games?.length ? `${data.games.length} games loaded` : "No games found");
    } catch (e) { setLog("Error loading games: " + e.message); }
  }, []);

  const handleRefresh = useCallback(async () => {
    if (!games.length) return;
    setRefreshing(true); setLog("Fetching scores, odds, and model predictions...");
    try {
      const locked = getLocked(sport);
      const endpoint = sport === "nfl" ? "/api/nfl-refresh" : "/api/nba-refresh";
      const resp = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ games, lockedPredictions: locked }) });
      const result = await resp.json();
      const updates = result.updates || [];
      setSources(result.sources || null);
      const adj = {};
      const ug = games.map((g) => {
        const u = updates.find((x) => x.id === g.id); if (!u) return g;
        const ng = { ...g };
        if (u.status) ng.status = u.status;
        if (u.awayScore != null && u.homeScore != null) ng.liveScore = { away: u.awayScore, home: u.homeScore, clock: u.clock || "", period: u.period ?? ng.liveScore?.period ?? null };
        if (u.oddsSpread) ng.spread = u.oddsSpread;
        if (u.oddsTotal && u.oddsTotal > 0) ng.total = u.oddsTotal;
        if (u.oddsML) ng.moneyline = u.oddsML;
        adj[g.id] = { consensus: u.consensus || u.lockedPrediction?.consensus || null, lockedPrediction: u.lockedPrediction || null, numBooks: u.numBooks || 0, oddsRange: u.oddsRange || null, oddsML: u.oddsML || null, oddsTotal: u.oddsTotal || null, oddsSpread: u.oddsSpread || null, noPregamePrediction: u.noPregamePrediction || false };
        const lockKey = g.espnId || g.id;
        if (u.isNewPrediction && u.consensus && !u.consensus.noPick && (u.currentTotal || ng.total) > 0) {
          // Complete, immutable lock record (Oct 31, 2026): total line,
          // spread line (fav + line, as returned by the refresh route),
          // ML odds, model spread/total, and the model % for each bet,
          // computed from the locked lines — not from later live odds.
          // lockPrediction only writes if no lock exists for this game,
          // so a locked record is never overwritten by a later refresh.
          const lockTotalLine = u.currentTotal || ng.total;
          const lockPcts = perBetPcts(u.consensus, sport, lockTotalLine, u.oddsSpread || null, g.homeAbbr, g.awayAbbr);
          lockPrediction(sport, lockKey, {
            totalCall: u.consensus.totalCall, strength: u.consensus.strength,
            spreadCall: u.consensus.spreadCall, moneylinePick: u.consensus.moneylinePick || null,
            predAway: u.consensus.awayPts || 0, predHome: u.consensus.homePts || 0,
            line: lockTotalLine, modelTotal: u.consensus.modelTotal || 0, modelSpread: u.consensus.modelSpread ?? null, consensus: u.consensus,
            spreadOdds: u.oddsSpread || null, mlOdds: u.oddsML || null,
            totalPct: lockPcts.totalPct, spreadPct: lockPcts.spreadPct, mlPct: lockPcts.mlPct,
            gameInfo: { away: g.awayAbbr, home: g.homeAbbr },
            gameStartTime: g.startTime || null,
          });
        }
        // Repair an already-locked spread pick that was derived with the
        // buggy NBA logic (Oct 31, 2026, SA case): if the stored pick's
        // own model % would be below 50% when recomputed from the locked
        // model spread and the spread line available now (stored, else
        // current), replace ONLY the spread pick / spread line / spread %
        // in the stored lock. Locked model score, total line, and other
        // picks are untouched, so later grading uses the corrected pick.
        try {
          const existing = getLocked(sport)[lockKey];
          if (existing?.consensus?.modelSpread != null && existing.spreadCall) {
            const repairSpread = existing.spreadOdds || u.oddsSpread || null;
            const repairMkt = repairSpread ? marketMarginHome(repairSpread, g.homeAbbr) : null;
            if (repairMkt != null) {
              const repairDiff = existing.consensus.modelSpread - repairMkt;
              const repairCorrected = Math.abs(repairDiff) >= 2 ? (existing.consensus.modelSpread > repairMkt ? g.homeAbbr : g.awayAbbr) : null;
              if (repairCorrected && repairCorrected !== existing.spreadCall) {
                const allLocked = getLocked(sport);
                const repairPcts = perBetPcts({ ...existing.consensus, spreadCall: repairCorrected }, sport, existing.line, repairSpread, g.homeAbbr, g.awayAbbr);
                allLocked[lockKey] = { ...existing, spreadCall: repairCorrected, spreadOdds: repairSpread, spreadPct: repairPcts.spreadPct, consensus: { ...existing.consensus, spreadCall: repairCorrected } };
                localStorage.setItem(lockKeyFor(sport), JSON.stringify(allLocked));
              }
            }
          }
        } catch { /* lock repair is best-effort; display correction still applies */ }
        if (u.status === "final" && u.awayScore != null && u.homeScore != null) {
          const lockedPred = getLocked(sport)[lockKey];
          if (lockedPred && lockedPred.line > 0) {
            const at = u.awayScore + u.homeScore;
            const actualMarginHome = u.homeScore - u.awayScore;
            const predTotal = lockedPred.modelTotal || ((lockedPred.predAway || 0) + (lockedPred.predHome || 0));
            const actualWinner = u.awayScore > u.homeScore ? g.awayAbbr : u.homeScore > u.awayScore ? g.homeAbbr : "draw";
            // Accurate per-market grading (Oct 31, 2026): ATS by actual
            // margin vs the LOCKED spread line, with pushes as pushes —
            // not by winner alone. Old locks without a spread line grade
            // ATS as null (can't grade), never as a guessed win/loss.
            const tGrade = gradeTotal(at, lockedPred.line, lockedPred.totalCall);
            const sGrade = gradeSpread(actualMarginHome, lockedPred.spreadOdds || u.oddsSpread || null, lockedPred.spreadCall, g.homeAbbr, g.awayAbbr);
            const mlGrade = gradeML(actualWinner === "draw" ? null : actualWinner, lockedPred.moneylinePick);
            const rec = {
              gameId: String(lockKey), sport, away: g.awayAbbr, home: g.homeAbbr,
              predictedTotal: predTotal || 0, actualTotal: at, totalCall: lockedPred.totalCall, line: lockedPred.line,
              totalCorrect: tGrade, spreadCorrect: sGrade, moneylineCorrect: mlGrade,
              spreadCall: lockedPred.spreadCall || null, moneylinePick: lockedPred.moneylinePick || null,
              spreadOdds: lockedPred.spreadOdds || u.oddsSpread || null, mlOdds: lockedPred.mlOdds || null,
              totalPct: lockedPred.totalPct ?? null, spreadPct: lockedPred.spreadPct ?? null, mlPct: lockedPred.mlPct ?? null,
              actualMarginHome, actualWinner,
              totalError: at - (predTotal || at), date: g.startTime ? ptDateFromIso(g.startTime) : ptDateStr(0),
            };
            setHistory((prev) => {
              const idx = prev.findIndex((h) => h.gameId === String(lockKey) && h.sport === sport);
              if (idx >= 0) { const copy = [...prev]; copy[idx] = { ...copy[idx], ...rec }; return copy; }
              return [...prev, rec];
            });
            // Server ledger (existing columns only): pushes are sent as
            // null so a boolean column is never given a non-boolean.
            // Note: the Supabase predictions table still needs
            // spread_line / ML-odds / % columns before the server copy
            // can hold the full record — the local record above is
            // complete either way.
            fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "prediction", ...rec, totalCorrect: tGrade === true ? true : tGrade === false ? false : null, spreadCorrect: sGrade === true ? true : sGrade === false ? false : null, moneylineCorrect: mlGrade === true ? true : mlGrade === false ? false : null, gameId: lockKey }) }).catch(() => {});
          }
        }
        return ng;
      });
      setGames(ug); setLiveAdj(adj); setLastRefresh(new Date());
      setLog(`${updates.filter((u) => u.status === "live").length} live, ${updates.filter((u) => u.status === "final").length} final, ${updates.filter((u) => u.isNewPrediction).length} new predictions`);
    } catch (e) { setLog("Error: " + e.message); }
    setRefreshing(false);
  }, [games, sport, history]);

  const handleRefreshRef = useRef();
  handleRefreshRef.current = handleRefresh;
  useEffect(() => { loadHistory(); }, [loadHistory]);
  useEffect(() => { refreshedSports.current = new Set(); loadGames(sport); }, [sport, loadGames]);
  useEffect(() => {
    // ROOT CAUSE of the preview dashes (found Oct 29, 2026):
    // On a sport switch, this effect used to run once with the OLD
    // sport's games still in state, mark the new sport as "refreshed",
    // and schedule a timeout — then loadGames replaced the games, the
    // effect cleanup cancelled that timeout, and the "refreshed" mark
    // blocked any new auto-refresh. So switching to NFL (or back to
    // NBA) left cards at dashes forever, no matter how fast the server
    // was, until the user manually pressed Refresh. Fixed three ways:
    // (1) only auto-refresh games that actually belong to this sport
    // (games[0].sport comes from the scores payload), so stale games
    // never mark the new sport refreshed; (2) mark the sport refreshed
    // only inside the timeout, when the refresh actually fires, not
    // when it is scheduled; (3) call the refresh through a ref, so a
    // handleRefresh identity change (e.g. history loading) does not
    // cancel a pending timeout.
    if (!games.length) return;
    if (games[0].sport && games[0].sport !== sport) return;
    if (refreshedSports.current.has(sport)) return;
    const t = setTimeout(() => {
      refreshedSports.current.add(sport);
      handleRefreshRef.current?.();
    }, 800);
    return () => clearTimeout(t);
  }, [games, sport]);

  const loadProps = async (game) => {
    const key = game.id;
    setPropsLoading((p) => ({ ...p, [key]: true }));
    try {
      const adj = liveAdj[game.id];
      const resp = await fetch("/api/nfl-props", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ away: game.away, home: game.home, awayAbbr: game.awayAbbr, homeAbbr: game.homeAbbr, awayPts: adj?.consensus?.awayPts, homePts: adj?.consensus?.homePts }) });
      const data = await resp.json();
      setPropsByGame((p) => ({ ...p, [key]: data }));
    } catch (e) { setPropsByGame((p) => ({ ...p, [key]: { available: false, reason: e.message } })); }
    setPropsLoading((p) => ({ ...p, [key]: false }));
  };

  // Tracker = card grades, not a separate history record. For every final
  // game with a lock, the tracker record is built from finalGradeForGame
  // (the same grade the card shows), overwriting any stale history record
  // (e.g. PHI/HOU "Can't grade" records created before the spread line
  // was repaired). Games without a final card grade keep their history
  // record, so nothing already graded is lost.
  const trackerHistory = (() => {
    const byKey = new Map();
    for (const h of history) byKey.set(String(h.gameId) + ":" + h.sport, { ...h });
    for (const game of games) {
      if (game.status !== "final" || !game.liveScore) continue;
      const fg = finalGradeForGame(game, liveAdj[game.id] || {}, sport);
      if (!fg.lockedRecord || !fg.finalGrades || !fg.effCons) continue;
      const key = String(game.espnId || game.id) + ":" + sport;
      const predTotal = fg.effCons.modelTotal || ((fg.lockedRecord.predAway || 0) + (fg.lockedRecord.predHome || 0));
      byKey.set(key, {
        ...(byKey.get(key) || {}),
        gameId: String(game.espnId || game.id), sport, away: game.awayAbbr, home: game.homeAbbr,
        predictedTotal: predTotal, actualTotal: fg.finalGrades.actualTotal, totalCall: fg.effCons.totalCall, line: fg.lockedRecord.line,
        totalCorrect: fg.finalGrades.total, spreadCorrect: fg.finalGrades.spread, moneylineCorrect: fg.finalGrades.ml,
        spreadCall: fg.effCons.spreadCall || null, moneylinePick: fg.effCons.moneylinePick || null,
        spreadOdds: fg.effSpreadOdds, mlOdds: fg.effMlOdds,
        totalPct: fg.totalPct, spreadPct: fg.spreadPct, mlPct: fg.mlPickPct,
        actualMarginHome: fg.finalGrades.actualMarginHome, actualWinner: fg.finalGrades.actualWinner,
        totalError: fg.finalGrades.actualTotal - predTotal,
        date: game.startTime ? ptDateFromIso(game.startTime) : ptDateStr(0),
      });
    }
    return [...byKey.values()];
  })();
  const visibleGames = filter === "all" ? games : filter === "live" ? games.filter((g) => g.status === "live") : filter === "completed" ? games.filter((g) => g.status === "final") : games.filter((g) => g.status === "scheduled" || g.status === "live");
  const liveCount = games.filter((g) => g.status === "live").length;
  const finalCount = games.filter((g) => g.status === "final").length;

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "12px 8px 40px", background: "#0a0a0f", color: "#e2e8f0", fontFamily: "Inter, system-ui, sans-serif", minHeight: "100vh" }}>
      <div style={{ textAlign: "center", marginBottom: 12 }}>
        <div style={{ fontSize: 26, fontWeight: 900 }}>🎓 JOETITO'S SCHOOL OF DATA</div>
        <div style={{ fontSize: 11, color: "#94a3b8" }}>NBA + NFL only • ESPN + Odds API • Pregame picks are locked and graded • Live is not tracked</div>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "center", marginBottom: 12 }}>
        <select value={sport} onChange={(e) => setSport(e.target.value)} style={{ padding: "8px 12px", borderRadius: 10, background: "#1e293b", color: "#fff", border: "1px solid #334155", fontWeight: 700 }}>
          <option value="nba">🏀 NBA</option>
          <option value="nfl">🏈 NFL</option>
        </select>
        <button onClick={handleRefresh} disabled={refreshing} style={{ padding: "8px 14px", borderRadius: 10, background: refreshing ? "#334155" : "#6366f1", color: "#fff", border: "none", fontWeight: 700, cursor: "pointer" }}>{refreshing ? "Updating..." : "↻ Refresh"}</button>
        {lastRefresh && <span style={{ fontSize: 10, color: "#6366f1" }}>Updated {lastRefresh.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>}
      </div>
      {sources && (
        <div style={{ margin: "0 12px 10px", padding: "8px 12px", borderRadius: 10, background: "#15151f", border: "1px solid #2a2a3a", fontSize: 11 }}>
          <b>Source health ({sport.toUpperCase()}):</b> {Object.entries(sources).map(([k, v]) => `${k}: ${String(v).startsWith("OK") || String(v).startsWith("Open") ? "✅" : "❌"} ${v}`).join(" | ")}
        </div>
      )}
      <div style={{ display: "flex", gap: 6, justifyContent: "center", marginBottom: 12, flexWrap: "wrap" }}>
        {[["upcoming", `Upcoming (${games.filter((g) => g.status === "scheduled" || g.status === "live").length})`], ["live", `Live (${liveCount})`], ["completed", `Completed (${finalCount})`], ["all", `All (${games.length})`]].map(([k, l]) => (
          <button key={k} onClick={() => setFilter(k)} style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #334155", background: filter === k ? "#6366f1" : "#1e293b", color: "#fff", fontSize: 11, cursor: "pointer" }}>{l}</button>
        ))}
      </div>
      <Tracker history={trackerHistory} sport={sport} trackerAvailable={trackerAvailable} />
      <ParlayBuilder legs={legs} setLegs={setLegs} />
      <div style={{ margin: "0 12px 10px", fontSize: 11, color: "#94a3b8", textAlign: "center" }}>{log}</div>
      {visibleGames.map((game) => {
        const adj = liveAdj[game.id] || {};
        const cons = adj.consensus;
        const locked = adj.lockedPrediction;
        const isLive = game.status === "live";
        const isFinal = game.status === "final";
        const noPick = cons?.noPick;
        // Live projection: anchored ONLY on a locked pregame model.
        let liveProj = null, liveStale = false, liveReason = null;
        if (isLive) {
          const lockedCons = locked?.consensus;
          if (!lockedCons || lockedCons.modelTotal == null) liveReason = "No locked pregame model — live projection unavailable";
          else {
            const mins = parseClockMinutes(game.liveScore?.clock);
            const period = game.liveScore?.period;
            if (period == null || mins == null) liveReason = "Clock/period unavailable — live projection unavailable";
            else if (period > 4) liveReason = "Overtime — no live pick";
            else {
              liveProj = buildLiveProjection({ pregame: { awayPts: lockedCons.awayPts, homePts: lockedCons.homePts, modelTotal: lockedCons.modelTotal }, awayScore: game.liveScore.away, homeScore: game.liveScore.home, period, minutesRemainingInPeriod: mins, totalMinutes: sport === "nba" ? 48 : 60, sport });
              if (!liveProj) liveReason = "Live projection unavailable";
            }
          }
          if (lastRefresh && Date.now() - lastRefresh.getTime() > 120000) liveStale = true;
        }
        const props = propsByGame[game.id];
        // Completed-card fix (Oct 31, 2026): for a final game, the card
        // must show the LOCKED record, not the current (now empty) market
        // fields — that is what produced "Spread: — • O/U: — • ML: —"
        // and "O/U: UNDER vs ?". A lock stored in this browser is used
        // even before a refresh, so a final card is not blank on load.
        // If no lock exists, the card says so plainly — no "?", no 0s.
        const fg = finalGradeForGame(game, adj, sport);
        const lockedRecord = fg.lockedRecord;
        const effCons = fg.effCons;
        const effSpreadOdds = fg.effSpreadOdds;
        const effTotalLine = fg.effTotalLine;
        const effMlOdds = fg.effMlOdds;
        const spreadCorrected = fg.spreadCorrected;
        const spreadCorrectionLabel = fg.spreadCorrectionLabel;
        const totalPct = fg.totalPct;
        const spreadPct = fg.spreadPct;
        const spreadPickValid = fg.spreadPickValid;
        const mlPickPct = fg.mlPickPct;
        const homeWinPct = fg.homeWinPct, awayWinPct = fg.awayWinPct;
        const finalGrades = fg.finalGrades;
        return (
          <div key={game.id} style={{ margin: "0 12px 12px", padding: 12, borderRadius: 12, background: "#15151f", border: "1px solid #2a2a3a" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 800 }}>{game.away} <span style={{ color: "#94a3b8", fontWeight: 400 }}>{game.awayRecord}</span> @ {game.home} <span style={{ color: "#94a3b8", fontWeight: 400 }}>{game.homeRecord}</span></div>
                <div style={{ fontSize: 11, color: "#94a3b8" }}>{game.gameDate} • {game.time} • {game.conference || game.venue || ""}</div>
                <div style={{ fontSize: 11, color: "#94a3b8" }}>Spread: {effSpreadOdds ? `${effSpreadOdds.fav} ${effSpreadOdds.line}` : "—"} • O/U: {effTotalLine || "—"} • ML: {effMlOdds ? `${game.awayAbbr} ${effMlOdds.away || "—"} / ${game.homeAbbr} ${effMlOdds.home || "—"}` : "—"}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                {isFinal ? <span style={{ color: "#22c55e", fontWeight: 700 }}>FINAL</span> : isLive ? <span style={{ color: "#ef4444", fontWeight: 700 }}>🔴 LIVE {game.liveScore?.clock || ""}</span> : <span style={{ color: "#94a3b8" }}>Scheduled</span>}
                {(isLive || isFinal) && game.liveScore && <div style={{ fontSize: 18, fontWeight: 800 }}>{game.liveScore.away} - {game.liveScore.home}</div>}
              </div>
            </div>
            {isFinal && !lockedRecord && <div style={{ marginTop: 8, padding: "8px 10px", borderRadius: 8, background: "#1e293b", border: "1px solid #334155", color: "#cbd5e1", fontSize: 12, fontWeight: 700 }}>No prediction was locked for this game — can't grade it.</div>}
            {isFinal && lockedRecord && finalGrades && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 11, color: "#94a3b8", textAlign: "center" }}>Locked: {effCons.awayPts ?? "?"} - {effCons.homePts ?? "?"} • Model total {effCons.modelTotal} • Line {lockedRecord.line} • Actual total {finalGrades.actualTotal} • {finalGrades.actualWinner ? `${finalGrades.actualWinner} won` : "Tie"}</div>
                <div style={{ marginTop: 8 }}>
                  <PickRow label="OVER / UNDER" pick={effCons.totalCall ? `${effCons.totalCall} ${effTotalLine || ""}${totalPct != null ? ` — ${totalPct}%` : ""}` : "—"} detail={`Model total ${effCons.modelTotal} • Actual total ${finalGrades.actualTotal}`} grade={gradeMark(finalGrades.total)} gradeColor={finalGrades.total === true ? "#22c55e" : finalGrades.total === false ? "#ef4444" : "#f59e0b"} />
                  <PickRow label="SPREAD (ATS)" pick={effCons.spreadCall ? `${spreadDisplay(effCons.spreadCall, effSpreadOdds)}${spreadPct != null ? ` — ${spreadPct}%` : ""}` : "—"} detail={`Actual margin ${finalGrades.actualMarginHome > 0 ? `${game.homeAbbr} +${finalGrades.actualMarginHome}` : finalGrades.actualMarginHome < 0 ? `${game.awayAbbr} +${Math.abs(finalGrades.actualMarginHome)}` : "Tie"}`} grade={finalGrades.spread == null ? "Can't grade from old data" : gradeMark(finalGrades.spread)} gradeColor={finalGrades.spread == null ? "#f59e0b" : finalGrades.spread === true ? "#22c55e" : finalGrades.spread === false ? "#ef4444" : "#f59e0b"} />
                  <PickRow label="MONEYLINE" pick={effCons.moneylinePick ? `${effCons.moneylinePick} to win${mlPickPct != null ? ` — ${mlPickPct}%` : ""}` : "—"} detail={`Actual winner ${finalGrades.actualWinner || "Tie"} • Win chance ${game.awayAbbr} ${awayWinPct ?? "—"}% • ${game.homeAbbr} ${homeWinPct ?? "—"}%`} grade={gradeMark(finalGrades.ml)} gradeColor={finalGrades.ml === true ? "#22c55e" : finalGrades.ml === false ? "#ef4444" : "#f59e0b"} />
                </div>
                <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 4 }}>Percentages are model chance only.</div>
                {spreadCorrected && <div style={{ fontSize: 10, color: "#f59e0b", marginTop: 2 }}>{spreadCorrectionLabel}</div>}
              </div>
            )}
            {noPick && !isFinal && <div style={{ marginTop: 8, padding: "8px 10px", borderRadius: 8, background: "#f59e0b22", border: "1px solid #f59e0b55", color: "#fbbf24", fontSize: 11, fontWeight: 700 }}>⚠️ {cons.noPickReason || "Data unavailable"} — no pick locked for this game. The game is shown, not hidden, and no fake line is used.</div>}
            {!isFinal && cons && !noPick && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 11, color: "#94a3b8", textAlign: "center" }}>Model: {effCons.awayPts ?? "?"} - {effCons.homePts ?? "?"} • Total {effCons.modelTotal}</div>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, color: "#94a3b8", margin: "10px 0 6px" }}>MODEL PICKS — MODEL % ONLY</div>
                <PickRow label="OVER / UNDER" pick={effCons.totalCall ? `Take ${effCons.totalCall} ${effTotalLine || ""}` : "—"} detail={effCons.modelTotal != null && effTotalLine ? `Model total ${effCons.modelTotal} vs line ${effTotalLine}` : null} pct={totalPct} />
                <PickRow label="SPREAD (ATS)" pick={effCons.spreadCall && spreadPickValid ? `Take ${spreadDisplay(effCons.spreadCall, effSpreadOdds)}` : "—"} detail={effCons.modelSpread != null && effSpreadOdds ? (spreadPickValid ? `Model margin ${effCons.modelSpread > 0 ? `${game.homeAbbr} +${effCons.modelSpread}` : `${game.awayAbbr} +${Math.abs(effCons.modelSpread)}`} vs market ${effSpreadOdds.fav} ${effSpreadOdds.line}` : `No spread pick — locked pick no longer covers at 50%+ (model margin ${effCons.modelSpread > 0 ? `${game.homeAbbr} +${effCons.modelSpread}` : `${game.awayAbbr} +${Math.abs(effCons.modelSpread)}`} vs market ${effSpreadOdds.fav} ${effSpreadOdds.line})`) : null} pct={spreadPct} />
                <PickRow label="MONEYLINE" pick={effCons.moneylinePick ? `Take ${effCons.moneylinePick} to win` : "No moneyline pick"} detail={(homeWinPct != null && awayWinPct != null) ? `${game.awayAbbr} ${awayWinPct}% to win • ${game.homeAbbr} ${homeWinPct}% to win` : null} pct={mlPickPct} />
                {spreadCorrected && <div style={{ fontSize: 10, color: "#f59e0b", marginTop: 2 }}>{spreadCorrectionLabel}</div>}
                {locked && <div style={{ fontSize: 10, color: "#22c55e", textAlign: "center" }}>🔒 Pregame pick locked (line {locked.line}) — this is the pick that will be graded.</div>}
                {cons.reasons?.length > 0 && <div style={{ fontSize: 11, color: "#cbd5e1", marginTop: 6, textAlign: "center" }}>{cons.reasons.slice(0, 4).map((r, i) => <div key={i}>{r}</div>)}</div>}
                {adj.oddsML && cons.moneylinePick && (
                  <button onClick={() => { const odds = cons.moneylinePick === game.homeAbbr ? adj.oddsML.home : adj.oddsML.away; if (odds) setLegs([...legs, { label: `${cons.moneylinePick} ML (${game.awayAbbr} @ ${game.homeAbbr})`, odds, gameId: String(game.espnId || game.id), prob: cons.moneylinePick === game.homeAbbr ? parseFloat(cons.homeWinProb) / 100 : parseFloat(cons.awayWinProb) / 100 }]); }} style={{ marginTop: 8, padding: "6px 10px", borderRadius: 8, background: "#a855f7", color: "#fff", border: "none", cursor: "pointer", fontSize: 11 }}>Add ML to parlay</button>
                )}
              </div>
            )}
            {isLive && (
              <div style={{ marginTop: 10, padding: 10, borderRadius: 10, background: "#ef444422", border: "1px solid #ef444455" }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#fca5a5" }}>🔴 LIVE — NOT TRACKED • Spread + Total only • No moneyline lean</div>
                {liveProj ? (
                  <div style={{ fontSize: 12, marginTop: 4 }}>
                    Projected final: {liveProj.projectedAway} - {liveProj.projectedHome} • Projected total {liveProj.projectedTotal} • Projected margin {liveProj.projectedMargin > 0 ? `${game.homeAbbr} +${liveProj.projectedMargin}` : `${game.awayAbbr} +${Math.abs(liveProj.projectedMargin)}`} • {liveProj.minutesRemaining} min left • Pace factor {liveProj.paceFactor}
                    <div style={{ color: "#fbbf24", fontSize: 11 }}>Projection only — no live line available. Do not treat the pregame line as a live line.</div>
                  </div>
                ) : <div style={{ fontSize: 11, color: "#fbbf24" }}>{liveReason || "Live projection unavailable"}</div>}
                {liveStale && <div style={{ fontSize: 11, color: "#fbbf24" }}>⚠️ Live data is stale (last refresh over 2 minutes ago) — hit Refresh before using this projection.</div>}
                {lastRefresh && <div style={{ fontSize: 10, color: "#94a3b8" }}>Last updated {lastRefresh.toLocaleTimeString()}</div>}
              </div>
            )}
            <div style={{ textAlign: "center", marginTop: 10, fontSize: 10, color: "#94a3b8", cursor: "pointer" }} onClick={() => setExpandedId(expandedId === game.id ? null : game.id)}>{expandedId === game.id ? "TAP TO COLLAPSE" : "TAP FOR DEEP ANALYSIS"}</div>
            {expandedId === game.id && (
              <div style={{ marginTop: 8, fontSize: 11, color: "#cbd5e1" }}>
                {cons?.dataSources?.map((s, i) => <div key={i}>• {s}</div>)}
                {cons?.reasons?.map((r, i) => <div key={`r${i}`}>• {r}</div>)}
                {sport === "nfl" && (
                  <div style={{ marginTop: 10 }}>
                    <b>Top 5 NFL props (on-demand)</b>
                    {!props && <button onClick={() => loadProps(game)} disabled={propsLoading[game.id]} style={{ marginLeft: 8, padding: "6px 10px", borderRadius: 8, background: "#22c55e", color: "#fff", border: "none", cursor: "pointer" }}>{propsLoading[game.id] ? "Loading..." : "Load props"}</button>}
                    {props && !props.available && <div style={{ color: "#f59e0b", marginTop: 6 }}>Props unavailable: {props.reason}. No prop projection or line is shown.</div>}
                    {props?.available && props.top5?.length > 0 && props.top5.map((p, i) => (
                      <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "4px 0", borderBottom: "1px solid #1e293b" }}>
                        <span>{i + 1}. {p.player} — {p.market} {p.line} {p.pick} @ {p.bestOdds > 0 ? "+" + p.bestOdds : p.bestOdds} ({p.book})</span>
                        <span>Model {p.modelProjection} • Edge {p.edgePct}% • Model {p.modelProb}%</span>
                      </div>
                    ))}
                    {props?.available && (!props.top5 || props.top5.length === 0) && (
                      <div style={{ color: "#f59e0b", marginTop: 6 }}>{props.note || "No edge-ranked top 5 available — no player baseline, so no fake edge is shown."}
                        {props.marketOnly?.length > 0 && <div style={{ color: "#cbd5e1", marginTop: 6 }}>Market props (not edge-ranked): {props.marketOnly.slice(0, 5).map((p) => `${p.player} ${p.market} ${p.line}`).join(" • ")}</div>}
                      </div>
                    )}
                    {props?.updatedAt && <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 4 }}>Props last updated {new Date(props.updatedAt).toLocaleTimeString()}</div>}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
      <div style={{ textAlign: "center", fontSize: 11, color: "#64748b", marginTop: 20 }}>For entertainment purposes only. Not financial advice. Please gamble responsibly. Pregame picks are locked and graded; live projections are not tracked.</div>
    </div>
  );
}
