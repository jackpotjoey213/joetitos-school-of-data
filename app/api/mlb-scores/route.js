import { NextResponse } from "next/server";

async function fetchESPNMLB(daysBack = 0) {
  const events = [];
  // Fetch default scoreboard (today's games)
  try {
    const resp = await fetch(
      "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?limit=50",
      { cache: "no-store" }
    );
    if (resp.ok) {
      const data = await resp.json();
      if (data.events) events.push(...data.events);
    }
  } catch (e) { console.log("ESPN MLB error:", e.message); }

  if (daysBack > 0) {
    const seenIds = new Set(events.map(e => e.id));
    for (let i = daysBack; i >= 1; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split("T")[0].replace(/-/g, "");
      try {
        const resp = await fetch(
          `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${dateStr}&limit=50`,
          { cache: "no-store" }
        );
        if (resp.ok) {
          const data = await resp.json();
          for (const ev of (data.events || [])) {
            if (!seenIds.has(ev.id)) { events.push(ev); seenIds.add(ev.id); }
          }
        }
      } catch (e) { /* ignore */ }
    }
  }
  return events;
}

function parseMLBEvent(ev, idx) {
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
  const awayRecord = away.records?.[0]?.summary || "";
  const homeRecord = home.records?.[0]?.summary || "";

  const startTime = new Date(ev.date);
  const timeStr = startTime.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }) + " PT";

  // Try to get probable pitchers from ESPN
  let awayPitcher = null, homePitcher = null;
  try {
    const broadcasts = comp.broadcasts || [];
    const headlines = comp.headlines || [];
    // ESPN sometimes puts pitcher info in notes
    const notes = comp.notes || [];
  } catch (e) { /* ignore */ }

  return {
    id: idx + 1,
    espnId: ev.id,
    sport: "mlb",
    away: away.team?.displayName || "Away",
    home: home.team?.displayName || "Home",
    awayAbbr: away.team?.abbreviation?.toUpperCase() || "AWY",
    homeAbbr: home.team?.abbreviation?.toUpperCase() || "HME",
    awayRecord, homeRecord,
    awayLogo: away.team?.logo || null,
    homeLogo: home.team?.logo || null,
    conference: "MLB",
    time: timeStr,
    startTime: ev.date,
    status,
    liveScore: (status === "live" || status === "final") ? {
      away: awayScore, home: homeScore,
      clock: ev.status?.type?.shortDetail || ""
    } : null,
    spread: { fav: home.team?.abbreviation?.toUpperCase() || "HME", line: 0 },
    total: 0,
    moneyline: { away: 0, home: 0 },
    awayPitcher, homePitcher,
    stats: {}
  };
}

export async function GET(req) {
  const url = new URL(req.url);
  const daysBack = parseInt(url.searchParams.get("days") || "1");
  try {
    const events = await fetchESPNMLB(daysBack);
    const games = events
      .map((ev, i) => parseMLBEvent(ev, i))
      .filter(g => g && g.away && g.home);
    games.sort((a, b) => {
      const order = { live: 0, scheduled: 1, final: 2 };
      if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
      if (a.status === "scheduled") return new Date(a.startTime) - new Date(b.startTime);
      return 0;
    });
    games.forEach((g, i) => g.id = i + 1);
    return NextResponse.json({ games, count: games.length, sport: "mlb", date: new Date().toISOString() });
  } catch (e) {
    return NextResponse.json({ error: e.message, games: [] }, { status: 500 });
  }
}
