import { NextResponse } from "next/server";

async function fetchESPNNBA(daysBack = 1) {
  const events = [];
  // Today
  try {
    const resp = await fetch("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?limit=50", { cache: "no-store" });
    if (resp.ok) { const d = await resp.json(); if (d.events) events.push(...d.events); }
  } catch (e) { console.log("ESPN NBA error:", e.message); }

  const seenIds = new Set(events.map(e => e.id));
  // Past days
  for (let i = daysBack; i >= 1; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const ds = d.toISOString().split("T")[0].replace(/-/g, "");
    try {
      const resp = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${ds}&limit=50`, { cache: "no-store" });
      if (resp.ok) { const d = await resp.json(); for (const ev of (d.events||[])) { if (!seenIds.has(ev.id)) { events.push(ev); seenIds.add(ev.id); } } }
    } catch {}
  }
  // Tomorrow
  const tm = new Date(); tm.setDate(tm.getDate() + 1);
  const ts = tm.toISOString().split("T")[0].replace(/-/g, "");
  try {
    const resp = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${ts}&limit=50`, { cache: "no-store" });
    if (resp.ok) { const d = await resp.json(); for (const ev of (d.events||[])) { if (!seenIds.has(ev.id)) { events.push(ev); seenIds.add(ev.id); } } }
  } catch {}
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
    id: idx + 1,
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
      clock: ev.status?.type?.shortDetail || ""
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
    games.forEach((g, i) => g.id = i + 1);
    return NextResponse.json({ games, count: games.length, sport: "nba", date: new Date().toISOString() });
  } catch (e) {
    return NextResponse.json({ error: e.message, games: [] }, { status: 500 });
  }
}
