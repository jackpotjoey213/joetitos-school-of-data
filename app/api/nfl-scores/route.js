import { NextResponse } from "next/server";

// NFL scores from ESPN's public scoreboard. No key required.
// Shape mirrors nba-scores: id, espnId, sport, teams, records, status,
// liveScore {away, home, clock, period}, venue, weather (ESPN field,
// may be null — never invented), and placeholder spread/total of 0
// which the frontend must NOT display as a line until Odds data arrives.
const TM = {
  ARI: "ARI", ATL: "ATL", BAL: "BAL", BUF: "BUF", CAR: "CAR", CHI: "CHI",
  CIN: "CIN", CLE: "CLE", DAL: "DAL", DEN: "DEN", DET: "DET", GB: "GB",
  HOU: "HOU", IND: "IND", JAX: "JAX", KC: "KC", LAC: "LAC", LAR: "LAR",
  LV: "LV", MIA: "MIA", MIN: "MIN", NE: "NE", NO: "NO", NYG: "NYG",
  NYJ: "NYJ", PHI: "PHI", PIT: "PIT", SEA: "SEA", SF: "SF", TB: "TB",
  TEN: "TEN", WAS: "WAS", WSH: "WAS",
};
function norm(a) { return a ? TM[a.toUpperCase()] || a.toUpperCase() : ""; }

async function fetchESPNNFL(daysBack = 1) {
  const events = [];
  const urls = ["https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?limit=100"];
  for (let i = daysBack; i >= 1; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    urls.push(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${d.toISOString().split("T")[0].replace(/-/g, "")}&limit=100`);
  }
  const tm = new Date(); tm.setDate(tm.getDate() + 1);
  urls.push(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${tm.toISOString().split("T")[0].replace(/-/g, "")}&limit=100`);
  const seen = new Set();
  for (const u of urls) {
    try {
      const resp = await fetch(u, { cache: "no-store" });
      if (!resp.ok) continue;
      const d = await resp.json();
      for (const ev of (d.events || [])) {
        if (!seen.has(ev.id)) { seen.add(ev.id); events.push(ev); }
      }
    } catch {}
  }
  return events;
}

function parseNFLEvent(ev, idx) {
  const comp = ev.competitions?.[0];
  if (!comp) return null;
  const teams = comp.competitors || [];
  const away = teams.find((t) => t.homeAway === "away");
  const home = teams.find((t) => t.homeAway === "home");
  if (!away || !home) return null;
  const statusType = ev.status?.type?.name;
  let status = "scheduled";
  if (statusType === "STATUS_FINAL") status = "final";
  else if (statusType === "STATUS_IN_PROGRESS" || statusType === "STATUS_HALFTIME" || statusType === "STATUS_END_PERIOD") status = "live";
  const startTime = new Date(ev.date);
  const timeStr = startTime.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }) + " PT";
  const gameDate = startTime.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/Los_Angeles" });
  const period = ev.status?.period ?? comp.status?.period ?? null;
  const clock = ev.status?.displayClock || comp.status?.displayClock || ev.status?.type?.shortDetail || "";
  return {
    id: idx + 1,
    espnId: ev.id,
    sport: "nfl",
    away: away.team?.displayName || "Away",
    home: home.team?.displayName || "Home",
    awayAbbr: norm(away.team?.abbreviation),
    homeAbbr: norm(home.team?.abbreviation),
    awayRecord: away.records?.[0]?.summary || "",
    homeRecord: home.records?.[0]?.summary || "",
    awayLogo: away.team?.logo || null,
    homeLogo: home.team?.logo || null,
    conference: `NFL Week ${ev.week?.number ?? ""}`.trim(),
    gameDate, time: timeStr, startTime: ev.date, status,
    liveScore: (status === "live" || status === "final") ? {
      away: parseInt(away.score) || 0,
      home: parseInt(home.score) || 0,
      clock, period,
    } : null,
    venue: comp.venue?.fullName || null,
    weather: comp.weather || null,
    week: ev.week?.number ?? null,
    spread: { fav: norm(home.team?.abbreviation), line: 0 },
    total: 0,
    moneyline: { away: 0, home: 0 },
    stats: {},
  };
}

export async function GET(req) {
  const url = new URL(req.url);
  const daysBack = parseInt(url.searchParams.get("days") || "1");
  try {
    const events = await fetchESPNNFL(daysBack);
    const games = events.map((ev, i) => parseNFLEvent(ev, i)).filter(Boolean);
    games.sort((a, b) => {
      const order = { live: 0, scheduled: 1, final: 2 };
      if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
      if (a.status === "scheduled") return new Date(a.startTime) - new Date(b.startTime);
      return 0;
    });
    games.forEach((g, i) => (g.id = i + 1));
    return NextResponse.json({ games, count: games.length, sport: "nfl", date: new Date().toISOString() });
  } catch (e) {
    return NextResponse.json({ error: e.message, games: [] }, { status: 500 });
  }
}
