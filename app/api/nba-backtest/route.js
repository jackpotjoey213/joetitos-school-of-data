import { NextResponse } from "next/server";

function mlToProb(ml) { if (!ml) return 0.5; return ml < 0 ? Math.abs(ml)/(Math.abs(ml)+100) : 100/(ml+100); }
const NBA_AVG = { pace: 100, ppg: 114 };

async function fetchRecentNBAGames(days = 7) {
  const games = [];
  for (let i = 1; i <= days; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const ds = d.toISOString().split("T")[0].replace(/-/g, "");
    try {
      const resp = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${ds}&limit=50`, { cache: "no-store" });
      if (!resp.ok) continue;
      const data = await resp.json();
      for (const ev of (data.events || [])) {
        if (ev.status?.type?.name !== "STATUS_FINAL") continue;
        const comp = ev.competitions?.[0];
        if (!comp) continue;
        const away = comp.competitors?.find(t => t.homeAway === "away");
        const home = comp.competitors?.find(t => t.homeAway === "home");
        if (!away || !home) continue;
        games.push({
          date: d.toISOString().split("T")[0],
          awayAbbr: away.team?.abbreviation?.toUpperCase() || "",
          homeAbbr: home.team?.abbreviation?.toUpperCase() || "",
          awayName: away.team?.displayName || "",
          homeName: home.team?.displayName || "",
          awayScore: parseInt(away.score) || 0,
          homeScore: parseInt(home.score) || 0,
          awayRecord: away.records?.[0]?.summary || "",
          homeRecord: home.records?.[0]?.summary || "",
        });
      }
    } catch {}
  }
  return games;
}

async function fetchTeamStats() {
  try {
    const resp = await fetch("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/standings", { cache: "no-store" });
    if (!resp.ok) return {};
    const data = await resp.json();
    const teams = {};
    for (const group of (data.children || [])) {
      for (const div of (group.children || [])) {
        for (const entry of (div.standings?.entries || [])) {
          const abbr = (entry.team?.abbreviation || "").toUpperCase();
          const stats = {};
          for (const s of (entry.stats || [])) stats[s.name] = parseFloat(s.value) || 0;
          const w = stats.wins || 0, l = stats.losses || 0, gp = w + l || 1;
          const ppg = stats.pointsFor ? stats.pointsFor / gp : NBA_AVG.ppg;
          const oppg = stats.pointsAgainst ? stats.pointsAgainst / gp : NBA_AVG.ppg;
          if (abbr) teams[abbr] = { ppg: +ppg.toFixed(1), oppg: +oppg.toFixed(1), w, l, gp };
        }
      }
    }
    return teams;
  } catch { return {}; }
}

export async function GET() {
  const start = Date.now();
  try {
    const [games, teams] = await Promise.all([fetchRecentNBAGames(7), fetchTeamStats()]);
    if (!games.length) return NextResponse.json({ error: "No completed NBA games found" });

    const processed = games.slice(0, 40);
    let ouCorrect = 0, ouTotal = 0, mlCorrect = 0, mlTotal = 0;
    let totalDiv = 0;
    const analyzed = [];

    for (const g of processed) {
      const at = teams[g.awayAbbr], ht = teams[g.homeAbbr];
      const awayPPG = at?.ppg || NBA_AVG.ppg, homePPG = ht?.ppg || NBA_AVG.ppg;
      const awayOPPG = at?.oppg || NBA_AVG.ppg, homeOPPG = ht?.oppg || NBA_AVG.ppg;
      
      // Model projection
      const awayProj = (awayPPG + homeOPPG) / 2;
      const homeProj = (homePPG + awayOPPG) / 2 + 3; // home court
      const modelTotal = Math.round((awayProj + homeProj) * 10) / 10;
      const actualTotal = g.awayScore + g.homeScore;
      
      const estimatedLine = Math.round((modelTotal + actualTotal) / 2 * 10) / 10;
      const ouCall = modelTotal > estimatedLine ? "OVER" : "UNDER";
      const ouActual = actualTotal > estimatedLine ? "OVER" : "UNDER";
      const ouHit = ouCall === ouActual;
      ouTotal++; if (ouHit) ouCorrect++;
      
      const mlPick = homeProj > awayProj ? g.homeAbbr : g.awayAbbr;
      const mlActual = g.homeScore > g.awayScore ? g.homeAbbr : g.awayAbbr;
      mlTotal++; if (mlPick === mlActual) mlCorrect++;
      
      totalDiv += Math.abs(modelTotal - actualTotal);
      
      analyzed.push({
        date: g.date, game: `${g.awayAbbr} @ ${g.homeAbbr}`,
        score: `${g.awayScore}-${g.homeScore}`, actualTotal, modelTotal,
        divergence: (modelTotal - actualTotal).toFixed(1),
        ouCall, ouHit, mlPick, mlActual, mlHit: mlPick === mlActual,
        awayPPG, homePPG, awayOPPG, homeOPPG
      });
    }

    return NextResponse.json({
      backtest: {
        sport: "NBA", period: "Last 7 days", sampleSize: processed.length,
        executionTime: `${Date.now() - start}ms`,
        ouRecord: `${ouCorrect}-${ouTotal - ouCorrect}`, ouWinRate: `${(ouCorrect/ouTotal*100).toFixed(1)}%`,
        mlRecord: `${mlCorrect}-${mlTotal - mlCorrect}`, mlWinRate: `${(mlCorrect/mlTotal*100).toFixed(1)}%`,
        avgDivergence: `${(totalDiv / processed.length).toFixed(1)} pts`,
        modelBias: `${(analyzed.reduce((a,g)=>a+parseFloat(g.divergence),0)/processed.length).toFixed(1)} pts`
      },
      games: analyzed
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
