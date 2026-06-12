import { NextResponse } from "next/server";

// Fetch today + tomorrow + yesterday for WC coverage
async function fetchESPNWorldCup() {
  const events = [];
  const dates = [];

  // Build date list: yesterday, today, tomorrow
  for (let i = -1; i <= 1; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    dates.push(d.toISOString().split("T")[0].replace(/-/g, ""));
  }

  const seenIds = new Set();

  for (const dateStr of dates) {
    try {
      const resp = await fetch(
        `https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=${dateStr}&limit=50`,
        { cache: "no-store" }
      );
      if (!resp.ok) continue;
      const data = await resp.json();
      for (const ev of (data.events || [])) {
        if (!seenIds.has(ev.id)) {
          events.push(ev);
          seenIds.add(ev.id);
        }
      }
    } catch (e) {
      console.log("ESPN WC fetch error:", e.message);
    }
  }
  return events;
}

function parseWCEvent(ev, idx) {
  const comp = ev.competitions?.[0];
  if (!comp) return null;

  const teams = comp.competitors || [];
  const away = teams.find(t => t.homeAway === "away");
  const home = teams.find(t => t.homeAway === "home");
  if (!away || !home) return null;

  const statusType = ev.status?.type?.name;
  let status = "scheduled";
  if (statusType === "STATUS_FINAL") status = "final";
  else if (["STATUS_IN_PROGRESS", "STATUS_HALFTIME", "STATUS_END_PERIOD"].includes(statusType)) status = "live";

  const startTime = new Date(ev.date);
  const timeStr = startTime.toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", timeZoneName: "short"
  });
  const gameDate = startTime.toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric"
  });

  // Group / round info from notes or headline
  const roundNote = comp.notes?.[0]?.headline || comp.notes?.[0]?.text || "FIFA World Cup 2026";

  return {
    id: idx + 1,
    espnId: ev.id,
    sport: "worldcup",
    away: away.team?.displayName || "Away",
    home: home.team?.displayName || "Home",
    awayAbbr: away.team?.abbreviation?.toUpperCase() || "AWY",
    homeAbbr: home.team?.abbreviation?.toUpperCase() || "HME",
    awayRecord: away.records?.[0]?.summary || "",
    homeRecord: home.records?.[0]?.summary || "",
    awayLogo: away.team?.logo || null,
    homeLogo: home.team?.logo || null,
    conference: roundNote,
    gameDate,
    time: timeStr,
    startTime: ev.date,
    status,
    liveScore: (status === "live" || status === "final") ? {
      away: parseInt(away.score) || 0,
      home: parseInt(home.score) || 0,
      clock: ev.status?.type?.shortDetail || "",
      period: ev.status?.period || 1
    } : null,
    // Soccer-specific
    spread: { fav: "", line: 0 },
    total: 0,
    moneyline: { away: 0, draw: 0, home: 0 },
    stats: {}
  };
}

export async function GET() {
  try {
    const events = await fetchESPNWorldCup();
    const games = events
      .map((ev, i) => parseWCEvent(ev, i))
      .filter(g => g && g.away && g.home);

    // Sort: live first, then scheduled by time, then final
    games.sort((a, b) => {
      const order = { live: 0, scheduled: 1, final: 2 };
      if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
      if (a.status === "scheduled") return new Date(a.startTime) - new Date(b.startTime);
      return 0;
    });

    games.forEach((g, i) => g.id = i + 1);

    return NextResponse.json({
      games,
      count: games.length,
      sport: "worldcup",
      date: new Date().toISOString()
    });
  } catch (e) {
    return NextResponse.json({ error: e.message, games: [] }, { status: 500 });
  }
}
