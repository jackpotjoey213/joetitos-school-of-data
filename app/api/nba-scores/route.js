import { NextResponse } from "next/server";

function ptDateParts(offsetDays = 0) {
  // America/Los_Angeles date, not server UTC — the site displays PT dates,
  // and the no-dates ESPN endpoint was dropping today's slate (Nov 1, 2026).
  const pt = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const [y, m, d] = pt.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + offsetDays));
  return dt.toISOString().split("T")[0].replace(/-/g, "");
}

async function fetchESPNNBA(daysBack = 1) {
  const events = [];
  const seenIds = new Set();
  // Explicit dates for yesterday, today, and tomorrow — never the
  // no-dates endpoint, which returned yesterday's slate for Nov 1.
  // Parallel date fetches (Nov 4, 2026): the tracker now asks for 7
  // days back, and 9 sequential ESPN fetches could time out on Vercel.
  // Promise.all keeps result order (chronological), dedupe still applies.
  const offsets = []; for (let off = -daysBack; off <= 1; off++) offsets.push(off);
  const results = await Promise.all(offsets.map(async (off) => {
    try {
      const resp = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${ptDateParts(off)}&limit=50`, { cache: "no-store" });
      return resp.ok ? (await resp.json()).events || [] : [];
    } catch { return []; }
  }));
  for (const evList of results) for (const ev of evList) { if (!seenIds.has(ev.id)) { events.push(ev); seenIds.add(ev.id); } }
  return events;
}

function parseNBAEvent(ev, idx) {
  const comp = ev.competitions?.[0];
  if (!comp) return null;
  const teams = comp.competitors || [];
  const away = teams.find(t => t.homeAway === "away");
  const home = teams.find(t => t.homeAway === "home");
  if (!away || !home) return null;

  const statusType = ev.status?.type?.name;
  let status = "scheduled";
  if (statusType === "STATUS_FINAL") status = "final";
  else if (statusType === "STATUS_IN_PROGRESS" || statusType === "STATUS_HALFTIME" || statusType === "STATUS_END_PERIOD") status = "live";

  const startTime = new Date(ev.date);
  const timeStr = startTime.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }) + " PT";
  const gameDate = startTime.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/Los_Angeles" });

  return {
    id: ev.id, // STABLE ID (Nov 7, 2026): was idx+1, reassigned after sorting by status, so a game changed id whenever another game tipped off / finished — refresh updates, live data and props then attached to the wrong card, and the CBB upcoming list appeared to change between fetches. ESPN event id never changes.
    espnId: ev.id,
    sport: "nba",
    away: away.team?.displayName || "Away",
    home: home.team?.displayName || "Home",
    awayAbbr: away.team?.abbreviation?.toUpperCase() || "AWY",
    homeAbbr: home.team?.abbreviation?.toUpperCase() || "HME",
    awayRecord: away.records?.[0]?.summary || "",
    homeRecord: home.records?.[0]?.summary || "",
    awayLogo: away.team?.logo || null,
    homeLogo: home.team?.logo || null,
    conference: ev.competitions?.[0]?.notes?.[0]?.headline || "NBA",
    gameDate,
    time: timeStr,
    startTime: ev.date,
    status,
    liveScore: (status === "live" || status === "final") ? {
      away: parseInt(away.score) || 0,
      home: parseInt(home.score) || 0,
      clock: ev.status?.displayClock || ev.status?.type?.shortDetail || "",
      period: ev.status?.period ?? ev.competitions?.[0]?.status?.period ?? null
    } : null,
    spread: { fav: home.team?.abbreviation?.toUpperCase() || "HME", line: 0 },
    total: 0,
    moneyline: { away: 0, home: 0 },
    stats: {}
  };
}

export async function GET(req) {
  const url = new URL(req.url);
  const daysBack = parseInt(url.searchParams.get("days") || "1");
  try {
    const events = await fetchESPNNBA(daysBack);
    const games = events.map((ev, i) => parseNBAEvent(ev, i)).filter(g => g && g.away && g.home);
    games.sort((a, b) => {
      const order = { live: 0, scheduled: 1, final: 2 };
      if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
      if (a.status === "scheduled") return new Date(a.startTime) - new Date(b.startTime);
      return 0;
    });
    // ids are stable ESPN event ids now — do NOT reassign by sort position.
    return NextResponse.json({ games, count: games.length, sport: "nba", date: new Date().toISOString() });
  } catch (e) {
    return NextResponse.json({ error: e.message, games: [] }, { status: 500 });
  }
}
