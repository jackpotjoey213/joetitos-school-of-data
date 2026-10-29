// lib/weather.js — Open-Meteo weather for NFL stadiums.
// Free, no API key. Used only for NFL totals / kicking context.
// Dome stadiums skip weather entirely. Retractable-roof stadiums are
// treated as outdoor (conservative) and flagged as such in the UI.
//
// Coordinates are approximate stadium locations, good enough for a
// game-time wind/temperature check — they are NOT a precision forecast.
export const NFL_STADIUMS = {
  ARI: { name: "State Farm Stadium", lat: 33.5277, lon: -112.2626, dome: false, roof: "retractable" },
  ATL: { name: "Mercedes-Benz Stadium", lat: 33.7554, lon: -84.4008, dome: false, roof: "retractable" },
  BAL: { name: "M&T Bank Stadium", lat: 39.278, lon: -76.6227, dome: false, roof: "open" },
  BUF: { name: "Highmark Stadium", lat: 42.7738, lon: -78.7869, dome: false, roof: "open" },
  CAR: { name: "Bank of America Stadium", lat: 35.2258, lon: -80.8528, dome: false, roof: "open" },
  CHI: { name: "Soldier Field", lat: 41.8623, lon: -87.6167, dome: false, roof: "open" },
  CIN: { name: "Paycor Stadium", lat: 39.0954, lon: -84.516, dome: false, roof: "open" },
  CLE: { name: "Huntington Bank Field", lat: 41.5061, lon: -81.6995, dome: false, roof: "open" },
  DAL: { name: "AT&T Stadium", lat: 32.7473, lon: -97.0945, dome: false, roof: "retractable" },
  DEN: { name: "Empower Field", lat: 39.7439, lon: -105.0201, dome: false, roof: "open" },
  DET: { name: "Ford Field", lat: 42.34, lon: -83.0456, dome: true, roof: "dome" },
  GB: { name: "Lambeau Field", lat: 44.5013, lon: -88.0622, dome: false, roof: "open" },
  HOU: { name: "NRG Stadium", lat: 29.6847, lon: -95.4107, dome: false, roof: "retractable" },
  IND: { name: "Lucas Oil Stadium", lat: 39.7601, lon: -86.1638, dome: false, roof: "retractable" },
  JAX: { name: "EverBank Stadium", lat: 30.3239, lon: -81.6373, dome: false, roof: "open" },
  KC: { name: "GEHA Field at Arrowhead", lat: 39.0489, lon: -94.4839, dome: false, roof: "open" },
  LAC: { name: "SoFi Stadium", lat: 33.9535, lon: -118.3392, dome: false, roof: "covered" },
  LAR: { name: "SoFi Stadium", lat: 33.9535, lon: -118.3392, dome: false, roof: "covered" },
  LV: { name: "Allegiant Stadium", lat: 36.0909, lon: -115.1836, dome: true, roof: "dome" },
  MIA: { name: "Hard Rock Stadium", lat: 25.958, lon: -80.2389, dome: false, roof: "open" },
  MIN: { name: "U.S. Bank Stadium", lat: 44.9738, lon: -93.2577, dome: true, roof: "dome" },
  NE: { name: "Gillette Stadium", lat: 42.0909, lon: -71.2643, dome: false, roof: "open" },
  NO: { name: "Caesars Superdome", lat: 29.9511, lon: -90.0812, dome: true, roof: "dome" },
  NYG: { name: "MetLife Stadium", lat: 40.8135, lon: -74.0745, dome: false, roof: "open" },
  NYJ: { name: "MetLife Stadium", lat: 40.8135, lon: -74.0745, dome: false, roof: "open" },
  PHI: { name: "Lincoln Financial Field", lat: 39.9008, lon: -75.1675, dome: false, roof: "open" },
  PIT: { name: "Acrisure Stadium", lat: 40.4468, lon: -80.0158, dome: false, roof: "open" },
  SEA: { name: "Lumen Field", lat: 47.5952, lon: -122.3316, dome: false, roof: "open" },
  SF: { name: "Levi's Stadium", lat: 37.403, lon: -121.9703, dome: false, roof: "open" },
  TB: { name: "Raymond James Stadium", lat: 27.9759, lon: -82.5033, dome: false, roof: "open" },
  TEN: { name: "Nissan Stadium", lat: 36.1665, lon: -86.7713, dome: false, roof: "open" },
  WAS: { name: "Northwest Stadium", lat: 38.9077, lon: -76.8644, dome: false, roof: "open" },
};

export function normAbbr(a) {
  return (a || "").toUpperCase();
}

// Fetch the hourly forecast closest to kickoff for a home team.
// Returns { ok, stadium, windMph, gustMph, tempF, precipProb, time, reason }
// or { ok: false, reason } — callers must never invent weather on failure.
export async function fetchGameWeather(homeAbbr, kickoffISO) {
  const st = NFL_STADIUMS[normAbbr(homeAbbr)];
  if (!st) return { ok: false, reason: "unknown stadium" };
  if (st.dome) return { ok: true, dome: true, stadium: st.name, reason: "dome — weather skipped" };
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${st.lat}&longitude=${st.lon}&hourly=temperature_2m,wind_speed_10m,wind_gusts_10m,precipitation_probability&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto`;
    const resp = await fetch(url, { cache: "no-store" });
    if (!resp.ok) return { ok: false, reason: `open-meteo ${resp.status}` };
    const data = await resp.json();
    const times = data?.hourly?.time || [];
    if (!times.length) return { ok: false, reason: "no hourly forecast" };
    const target = kickoffISO ? new Date(kickoffISO).getTime() : Date.now();
    let best = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < times.length; i++) {
      const d = Math.abs(new Date(times[i]).getTime() - target);
      if (d < bestDiff) { bestDiff = d; best = i; }
    }
    const h = data.hourly;
    return {
      ok: true,
      dome: false,
      stadium: st.name,
      roof: st.roof,
      time: times[best],
      tempF: h.temperature_2m?.[best] ?? null,
      windMph: h.wind_speed_10m?.[best] ?? null,
      gustMph: h.wind_gusts_10m?.[best] ?? null,
      precipProb: h.precipitation_probability?.[best] ?? null,
    };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// Conservative total adjustment from wind/cold. Documented, capped,
// and only applied when weather data is actually present.
export function weatherTotalAdjustment(weather) {
  if (!weather?.ok || weather.dome) return { points: 0, reasons: [] };
  const reasons = [];
  let pts = 0;
  const wind = weather.windMph ?? 0;
  const gust = weather.gustMph ?? wind;
  const effWind = Math.max(wind, gust * 0.8);
  // Name the metric that actually drove the adjustment: gusts, when
  // gusts (discounted to 80%) exceed the sustained wind.
  const windLabel = gust * 0.8 > wind ? `gusts ${Math.round(gust)} mph` : `wind ${Math.round(wind)} mph`;
  if (effWind >= 25) { pts -= 5; reasons.push(`Very high ${windLabel} (-5 total)`); }
  else if (effWind >= 15) { pts -= 3; reasons.push(`High ${windLabel} (-3 total)`); }
  else if (effWind >= 10) { pts -= 1; reasons.push(`${windLabel} (-1 total)`); }
  if (weather.tempF != null && weather.tempF < 20) { pts -= 1; reasons.push(`Cold ${Math.round(weather.tempF)}F (-1 total)`); }
  return { points: pts, reasons };
}
