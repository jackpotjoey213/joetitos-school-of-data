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

function Tracker({ history, sport, trackerAvailable }) {
  const [window, setWindow] = useState("7d");
  const [showLog, setShowLog] = useState(false);
  const filteredAll = history.filter((h) => h.sport === sport);
  let filtered = filteredAll;
  if (window === "yesterday") filtered = filteredAll.filter((h) => h.date === todayStr(-1));
  else if (window === "7d") filtered = filteredAll.filter((h) => h.date >= todayStr(-7) && h.date <= todayStr(0));
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
            <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "4px 0", borderBottom: "1px solid #1e293b" }}>
              <span>{h.date} {h.away} @ {h.home}</span>
              <span>Model {h.predictedTotal} vs line {h.line} • Actual {h.actualTotal} • O/U {h.totalCorrect ? "✓" : h.totalCorrect === false ? "✗" : "push/—"}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
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
          lockPrediction(sport, lockKey, {
            totalCall: u.consensus.totalCall, strength: u.consensus.strength,
            spreadCall: u.consensus.spreadCall, moneylinePick: u.consensus.moneylinePick || null,
            predAway: u.consensus.awayPts || 0, predHome: u.consensus.homePts || 0,
            line: u.currentTotal || ng.total, modelTotal: u.consensus.modelTotal || 0, consensus: u.consensus,
            gameInfo: { away: g.awayAbbr, home: g.homeAbbr },
          });
        }
        if (u.status === "final" && u.awayScore != null && u.homeScore != null) {
          const lockedPred = getLocked(sport)[lockKey];
          if (lockedPred && lockedPred.line > 0 && !history.find((h) => h.gameId === String(lockKey) && h.sport === sport)) {
            const at = u.awayScore + u.homeScore;
            const tOk = lockedPred.totalCall === "OVER" ? at > lockedPred.line : lockedPred.totalCall === "UNDER" ? at < lockedPred.line : null;
            const predTotal = lockedPred.modelTotal || ((lockedPred.predAway || 0) + (lockedPred.predHome || 0));
            const actualWinner = u.awayScore > u.homeScore ? g.awayAbbr : u.homeScore > u.awayScore ? g.homeAbbr : "draw";
            const mlOk = lockedPred.moneylinePick ? lockedPred.moneylinePick === actualWinner : null;
            const spreadOk = lockedPred.spreadCall ? lockedPred.spreadCall === actualWinner : null;
            const rec = {
              gameId: String(lockKey), sport, away: g.awayAbbr, home: g.homeAbbr,
              predictedTotal: predTotal || 0, actualTotal: at, totalCall: lockedPred.totalCall, line: lockedPred.line,
              totalCorrect: tOk, spreadCorrect: spreadOk, moneylineCorrect: mlOk,
              totalError: at - (predTotal || at), date: new Date().toISOString().split("T")[0],
            };
            setHistory((prev) => [...prev, rec]);
            fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "prediction", ...rec, gameId: lockKey }) }).catch(() => {});
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
      <Tracker history={history} sport={sport} trackerAvailable={trackerAvailable} />
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
        return (
          <div key={game.id} style={{ margin: "0 12px 12px", padding: 14, borderRadius: 12, background: "#15151f", border: "1px solid #2a2a3a" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <div style={{ fontWeight: 800 }}>{game.away} <span style={{ color: "#94a3b8", fontWeight: 400 }}>{game.awayRecord}</span> @ {game.home} <span style={{ color: "#94a3b8", fontWeight: 400 }}>{game.homeRecord}</span></div>
                <div style={{ fontSize: 11, color: "#94a3b8" }}>{game.gameDate} • {game.time} • {game.conference || game.venue || ""}</div>
                <div style={{ fontSize: 11, color: "#94a3b8" }}>Spread: {adj.oddsSpread ? `${adj.oddsSpread.fav} ${adj.oddsSpread.line}` : "—"} • O/U: {adj.oddsTotal && adj.oddsTotal > 0 ? adj.oddsTotal : "—"} • ML: {adj.oddsML ? `${game.awayAbbr} ${adj.oddsML.away || "—"} / ${game.homeAbbr} ${adj.oddsML.home || "—"}` : "—"}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                {isFinal ? <span style={{ color: "#22c55e", fontWeight: 700 }}>FINAL</span> : isLive ? <span style={{ color: "#ef4444", fontWeight: 700 }}>🔴 LIVE {game.liveScore?.clock || ""}</span> : <span style={{ color: "#94a3b8" }}>Scheduled</span>}
                {(isLive || isFinal) && game.liveScore && <div style={{ fontSize: 20, fontWeight: 800 }}>{game.liveScore.away} - {game.liveScore.home}</div>}
              </div>
            </div>
            {noPick && <div style={{ marginTop: 8, padding: "8px 10px", borderRadius: 8, background: "#f59e0b22", border: "1px solid #f59e0b55", color: "#fbbf24", fontSize: 11, fontWeight: 700 }}>⚠️ {cons.noPickReason || "Data unavailable"} — no pick locked for this game. The game is shown, not hidden, and no fake line is used.</div>}
            {cons && !noPick && (
              <div style={{ marginTop: 10, textAlign: "center" }}>
                <div style={{ fontSize: 12, color: "#94a3b8" }}>Model: {cons.awayPts ?? "?"} - {cons.homePts ?? "?"} • Total {cons.modelTotal} • {cons.strength}% confidence</div>
                <div style={{ fontWeight: 800, marginTop: 4 }}>O/U: {cons.totalCall || "—"} {cons.totalCall ? `vs ${game.total || adj.oddsTotal || "?"}` : ""} • Spread: {cons.spreadCall || "—"} • ML: {cons.moneylinePick || "—"}</div>
                {locked && <div style={{ fontSize: 10, color: "#22c55e" }}>🔒 Pregame pick locked (line {locked.line}) — this is the pick that will be graded.</div>}
                {cons.reasons?.length > 0 && <div style={{ fontSize: 11, color: "#cbd5e1", marginTop: 6 }}>{cons.reasons.slice(0, 4).map((r, i) => <div key={i}>{r}</div>)}</div>}
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
