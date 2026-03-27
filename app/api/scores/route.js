import { NextResponse } from "next/server";

// Fetch today's + recent games from ESPN
async function fetchESPN(daysBack = 0) {
  const events = [];
  
  // ALWAYS fetch the default scoreboard first (returns today's games in ESPN's timezone)
  try {
    const resp = await fetch(
      "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?limit=100",
      { cache: "no-store" }
    );
    if (resp.ok) {
      const data = await resp.json();
      if (data.events) events.push(...data.events);
    }
  } catch (e) { console.log("ESPN default scoreboard error:", e.message); }

  // Also fetch specific dates for past days (completed games)
  if (daysBack > 0) {
    const seenIds = new Set(events.map(e => e.id));
    for (let i = daysBack; i >= 1; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split("T")[0].replace(/-/g, "");
      try {
        const resp = await fetch(
          `https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?dates=${dateStr}&limit=100`,
          { cache: "no-store" }
        );
        if (resp.ok) {
          const data = await resp.json();
          for (const ev of (data.events || [])) {
            if (!seenIds.has(ev.id)) {
              events.push(ev);
              seenIds.add(ev.id);
            }
          }
        }
      } catch (e) { console.log(`ESPN fetch error for ${dateStr}:`, e.message); }
    }
    
    // Also try tomorrow (for games listed the next day in UTC)
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split("T")[0].replace(/-/g, "");
    try {
      const resp = await fetch(
        `https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?dates=${tomorrowStr}&limit=100`,
        { cache: "no-store" }
      );
      if (resp.ok) {
        const data = await resp.json();
        for (const ev of (data.events || [])) {
          if (!seenIds.has(ev.id)) {
            events.push(ev);
            seenIds.add(ev.id);
          }
        }
      }
    } catch (e) { /* ignore */ }
  }
  
  return events;
}

// Parse ESPN event into our game format
function parseESPNEvent(ev, idx) {
  const comp = ev.competitions?.[0];
  if (!comp) return null;
  
  const teams = comp.competitors || [];
  const away = teams.find(t => t.homeAway === "away");
  const home = teams.find(t => t.homeAway === "home");
  if (!away || !home) return null;

  const statusType = ev.status?.type?.name;
  let status = "scheduled";
  if (statusType === "STATUS_FINAL") status = "final";
  else if (statusType === "STATUS_IN_PROGRESS" || statusType === "STATUS_HALFTIME") status = "live";

  const awayScore = parseInt(away.score) || 0;
  const homeScore = parseInt(home.score) || 0;
  
  // Extract records
  const awayRecord = away.records?.[0]?.summary || "";
  const homeRecord = home.records?.[0]?.summary || "";
  
  // Extract team stats if available
  const awayStats = away.statistics || [];
  const homeStats = home.statistics || [];
  const getStat = (stats, name) => {
    const s = stats.find(s => s.name === name || s.abbreviation === name);
    return s ? parseFloat(s.displayValue || s.value) : null;
  };
  
  const startTime = new Date(ev.date);
  const timeStr = startTime.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }) + " PT";

  // Conference/tournament info
  const notes = ev.competitions?.[0]?.notes?.[0]?.headline || "";
  const conference = notes || ev.season?.type?.abbreviation || "NCAAB";
  
  return {
    id: idx + 1,
    espnId: ev.id,
    away: away.team?.displayName || away.team?.shortDisplayName || "Away",
    home: home.team?.displayName || home.team?.shortDisplayName || "Home",
    awayAbbr: away.team?.abbreviation?.toUpperCase() || "AWY",
    homeAbbr: home.team?.abbreviation?.toUpperCase() || "HME",
    awayRecord,
    homeRecord,
    awayLogo: away.team?.logo || null,
    homeLogo: home.team?.logo || null,
    conference,
    time: timeStr,
    startTime: ev.date,
    status,
    liveScore: (status === "live" || status === "final") ? {
      away: awayScore,
      home: homeScore,
      clock: ev.status?.type?.shortDetail || ev.status?.displayClock || ""
    } : null,
    // Default lines (will be overridden by Odds API)
    spread: { fav: home.team?.abbreviation?.toUpperCase() || "HME", line: 0 },
    total: 0,
    moneyline: { away: 0, home: 0 },
    // Basic stats from ESPN (season averages aren't always in scoreboard, but we try)
    stats: {
      awayPPG: getStat(awayStats, "avgPoints") || 72,
      homePPG: getStat(homeStats, "avgPoints") || 72,
      awayPace: 68, homePace: 68, // ESPN doesn't give pace in scoreboard
      awayAdjOE: 110, homeAdjOE: 110,
      awayAdjDE: 100, homeAdjDE: 100,
      awayFGPct: 0.45, homeFGPct: 0.45,
      away3Pct: 0.34, home3Pct: 0.34,
      awayRebPG: 35, homeRebPG: 35,
      awayTOPG: 12, homeTOPG: 12,
      awayHomeRec: awayRecord, homeHomeRec: homeRecord,
      awayATS: "", homeATS: "",
      h2hTrend: "", overTrend: ""
    }
  };
}

export async function GET(req) {
  const url = new URL(req.url);
  const daysBack = parseInt(url.searchParams.get("days") || "1");
  
  try {
    const events = await fetchESPN(daysBack);
    
    // Filter to actual games (not TBD placeholder games)
    const games = events
      .map((ev, i) => parseESPNEvent(ev, i))
      .filter(g => g && g.away && g.home && !g.away.includes("TBD") && !g.away.includes("Semifinal"));
    
    // Sort: live first, then scheduled (by time), then final (most recent first)
    games.sort((a, b) => {
      const order = { live: 0, scheduled: 1, final: 2 };
      if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
      if (a.status === "scheduled") return new Date(a.startTime) - new Date(b.startTime);
      if (a.status === "final") return new Date(b.startTime) - new Date(a.startTime);
      return 0;
    });
    
    // Re-index
    games.forEach((g, i) => g.id = i + 1);
    
    return NextResponse.json({ games, count: games.length, date: new Date().toISOString() });
  } catch (e) {
    return NextResponse.json({ error: e.message, games: [] }, { status: 500 });
  }
}
