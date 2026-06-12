// KenPom-caliber stats for 2026 NCAA Tournament teams
// Updated: March 20, 2026

const TEAM_STATS = {
  // 1 Seeds
  "DUKE":  { adjOE: 122.1, adjDE: 89.1, tempo: 68, rank: 1, ppg: 83.2, oppg: 64.1 },
  "MICH":  { adjOE: 119.4, adjDE: 88.4, tempo: 68, rank: 2, ppg: 80.1, oppg: 62.8 },
  "ARIZ":  { adjOE: 121.5, adjDE: 89.5, tempo: 72, rank: 3, ppg: 86.4, oppg: 66.2 },
  "FLA":   { adjOE: 119.1, adjDE: 91.2, tempo: 69, rank: 4, ppg: 82.1, oppg: 66.8 },
  // 2 Seeds
  "HOU":   { adjOE: 116.5, adjDE: 90.5, tempo: 66, rank: 5, ppg: 76.8, oppg: 62.1 },
  "IAST":  { adjOE: 113.8, adjDE: 89.8, tempo: 66, rank: 6, ppg: 75.2, oppg: 63.5 },
  "ILL":   { adjOE: 125.9, adjDE: 95.3, tempo: 70, rank: 7, ppg: 87.5, oppg: 69.2 },
  "PUR":   { adjOE: 125.1, adjDE: 96.6, tempo: 69, rank: 8, ppg: 85.1, oppg: 70.1 },
  // 3 Seeds
  "MSU":   { adjOE: 114.5, adjDE: 92.5, tempo: 67, rank: 9, ppg: 76.8, oppg: 65.3 },
  "GONZ":  { adjOE: 112.9, adjDE: 91.3, tempo: 69, rank: 10, ppg: 78.2, oppg: 66.1 },
  "VAN":   { adjOE: 120.3, adjDE: 95.8, tempo: 68, rank: 11, ppg: 81.2, oppg: 68.5 },
  "CONN":  { adjOE: 112.4, adjDE: 91.6, tempo: 67, rank: 12, ppg: 75.6, oppg: 64.8 },
  // 4 Seeds
  "UVA":   { adjOE: 113.2, adjDE: 93.2, tempo: 60, rank: 13, ppg: 68.1, oppg: 57.2 },
  "NEB":   { adjOE: 106.2, adjDE: 91.1, tempo: 68, rank: 14, ppg: 72.5, oppg: 65.8 },
  "TENN":  { adjOE: 110.1, adjDE: 92.7, tempo: 65, rank: 15, ppg: 71.8, oppg: 63.1 },
  "SJU":   { adjOE: 108.4, adjDE: 91.5, tempo: 66, rank: 16, ppg: 72.1, oppg: 64.2 },
  // 5 Seeds
  "ALA":   { adjOE: 124.7, adjDE: 100.9, tempo: 74, rank: 17, ppg: 91.2, oppg: 76.5 },
  "ARK":   { adjOE: 121.4, adjDE: 98.7, tempo: 73, rank: 18, ppg: 88.1, oppg: 74.2 },
  "LOU":   { adjOE: 114.1, adjDE: 94.5, tempo: 67, rank: 19, ppg: 76.5, oppg: 66.8 },
  "TTU":   { adjOE: 117.7, adjDE: 96.1, tempo: 66, rank: 20, ppg: 77.8, oppg: 67.1 },
  // 6 Seeds
  "KU":    { adjOE: 106.0, adjDE: 91.3, tempo: 67, rank: 21, ppg: 71.2, oppg: 64.5 },
  "WIS":   { adjOE: 118.8, adjDE: 98.1, tempo: 64, rank: 22, ppg: 75.8, oppg: 66.2 },
  "BYU":   { adjOE: 119.5, adjDE: 99.1, tempo: 71, rank: 23, ppg: 84.2, oppg: 72.5 },
  "UNC":   { adjOE: 112.6, adjDE: 96.5, tempo: 70, rank: 29, ppg: 78.8, oppg: 70.2 },
  // 7 Seeds
  "STMR":  { adjOE: 108.5, adjDE: 93.0, tempo: 63, rank: 24, ppg: 68.5, oppg: 60.8 },
  "IOWA":  { adjOE: 112.2, adjDE: 95.0, tempo: 72, rank: 25, ppg: 80.8, oppg: 71.2 },
  "OSU":   { adjOE: 115.2, adjDE: 98.2, tempo: 69, rank: 26, ppg: 79.8, oppg: 70.5 },
  "UCLA":  { adjOE: 114.7, adjDE: 98.8, tempo: 68, rank: 27, ppg: 78.1, oppg: 70.1 },
  // 8 Seeds
  "UK":    { adjOE: 110.9, adjDE: 94.7, tempo: 69, rank: 28, ppg: 76.5, oppg: 68.2 },
  "UTST":  { adjOE: 113.1, adjDE: 97.0, tempo: 66, rank: 30, ppg: 74.8, oppg: 67.5 },
  "MIA":   { adjOE: 112.5, adjDE: 96.5, tempo: 68, rank: 31, ppg: 76.8, oppg: 69.1 },
  "GA":    { adjOE: 115.3, adjDE: 102.9, tempo: 73, rank: 32, ppg: 84.1, oppg: 77.2 },
  "CLEM":  { adjOE: 104.5, adjDE: 93.1, tempo: 64, rank: 36, ppg: 67.1, oppg: 62.5 },
  // 9 Seeds
  "VILL":  { adjOE: 109.7, adjDE: 95.3, tempo: 67, rank: 33, ppg: 73.5, oppg: 66.8 },
  "NCST":  { adjOE: 114.0, adjDE: 103.4, tempo: 71, rank: 34, ppg: 80.8, oppg: 75.2 },
  "TCU":   { adjOE: 103.5, adjDE: 93.3, tempo: 67, rank: 43, ppg: 69.5, oppg: 65.2 },
  "STL":   { adjOE: 107.6, adjDE: 96.8, tempo: 67, rank: 41, ppg: 72.1, oppg: 67.8 },
  // 10 Seeds
  "TEX":   { adjOE: 117.1, adjDE: 104.6, tempo: 71, rank: 37, ppg: 83.1, oppg: 76.8 },
  "AUB":   { adjOE: 116.4, adjDE: 104.1, tempo: 73, rank: 38, ppg: 84.8, oppg: 78.1 },
  "TXAM":  { adjOE: 107.9, adjDE: 96.7, tempo: 66, rank: 39, ppg: 71.2, oppg: 66.5 },
  "UCF":   { adjOE: 109.3, adjDE: 101.6, tempo: 68, rank: 54, ppg: 74.2, oppg: 71.5 },
  "SC":    { adjOE: 108.1, adjDE: 100.6, tempo: 67, rank: 35, ppg: 72.5, oppg: 69.8 },
  // 11 Seeds
  "OKLA":  { adjOE: 114.1, adjDE: 105.2, tempo: 72, rank: 40, ppg: 82.1, oppg: 78.2 },
  "VCU":   { adjOE: 108.2, adjDE: 99.5, tempo: 68, rank: 46, ppg: 73.8, oppg: 70.1 },
  "SMU":   { adjOE: 113.3, adjDE: 103.8, tempo: 69, rank: 42, ppg: 78.2, oppg: 74.5 },
  // 12 Seeds
  "CIN":   { adjOE: 100.2, adjDE: 91.1, tempo: 63, rank: 44, ppg: 63.2, oppg: 60.1 },
  "IND":   { adjOE: 109.6, adjDE: 99.7, tempo: 68, rank: 45, ppg: 74.5, oppg: 70.2 },
  "SDSU":  { adjOE: 102.1, adjDE: 92.9, tempo: 63, rank: 47, ppg: 64.5, oppg: 61.8 },
  "HP":    { adjOE: 105.1, adjDE: 103.4, tempo: 71, rank: 92, ppg: 74.8, oppg: 76.1 },
  "UNI":   { adjOE: 97.9, adjDE: 93.4, tempo: 64, rank: 71, ppg: 62.8, oppg: 60.2 },
  // 13 Seeds
  "BAY":   { adjOE: 113.4, adjDE: 106.7, tempo: 70, rank: 48, ppg: 79.2, oppg: 77.1 },
  "USF":   { adjOE: 105.9, adjDE: 97.3, tempo: 66, rank: 49, ppg: 70.1, oppg: 67.2 },
  "UNM":   { adjOE: 104.3, adjDE: 97.0, tempo: 69, rank: 50, ppg: 72.1, oppg: 69.8 },
  "TROY":  { adjOE: 101.2, adjDE: 99.8, tempo: 68, rank: 143, ppg: 68.8, oppg: 70.5 },
  "HOF":   { adjOE: 100.5, adjDE: 100.1, tempo: 69, rank: 88, ppg: 69.2, oppg: 68.8 },
  "CBU":   { adjOE: 96.5, adjDE: 97.4, tempo: 66, rank: 106, ppg: 63.8, oppg: 64.5 },
  // 14 Seeds
  "HALL":  { adjOE: 98.6, adjDE: 91.6, tempo: 64, rank: 51, ppg: 63.1, oppg: 61.2 },
  "KENN":  { adjOE: 101.0, adjDE: 102.1, tempo: 64, rank: 163, ppg: 64.8, oppg: 67.2 },
  "SIE":   { adjOE: 99.2, adjDE: 100.5, tempo: 66, rank: 192, ppg: 65.5, oppg: 68.8 },
  "NDSU":  { adjOE: 101.0, adjDE: 101.3, tempo: 66, rank: 113, ppg: 66.8, oppg: 68.5 },
  "AKRN":  { adjOE: 106.3, adjDE: 102.5, tempo: 67, rank: 64, ppg: 71.2, oppg: 70.1 },
  "MCN":   { adjOE: 103.0, adjDE: 97.3, tempo: 68, rank: 68, ppg: 70.1, oppg: 66.5 },
  "MOH":   { adjOE: 104.7, adjDE: 103.0, tempo: 67, rank: 93, ppg: 70.2, oppg: 71.5 },
  // 15 Seeds
  "IDHO":  { adjOE: 100.5, adjDE: 101.4, tempo: 67, rank: 145, ppg: 67.5, oppg: 69.1 },
  "LIB":   { adjOE: 105.8, adjDE: 107.9, tempo: 67, rank: 125, ppg: 71.1, oppg: 73.8 },
  "UNCW":  { adjOE: 101.5, adjDE: 100.6, tempo: 66, rank: 110, ppg: 67.1, oppg: 68.2 },
  "YALE":  { adjOE: 110.3, adjDE: 101.8, tempo: 65, rank: 76, ppg: 71.8, oppg: 68.5 },
  "FUR":   { adjOE: 98.5, adjDE: 101.1, tempo: 67, rank: 190, ppg: 68.2, oppg: 70.5 },
  // 16 Seeds
  "UMBC":  { adjOE: 100.7, adjDE: 102.0, tempo: 67, rank: 185, ppg: 67.5, oppg: 69.5 },
  "HOW":   { adjOE: 96.3, adjDE: 101.0, tempo: 69, rank: 207, ppg: 66.5, oppg: 71.2 },
  "AMRC":  { adjOE: 100.8, adjDE: 105.2, tempo: 66, rank: 238, ppg: 66.5, oppg: 72.1 },
  "MSM":   { adjOE: 97.5, adjDE: 105.1, tempo: 68, rank: 220, ppg: 66.1, oppg: 73.8 },
  "PVAM":  { adjOE: 93.5, adjDE: 108.2, tempo: 67, rank: 310, ppg: 62.8, oppg: 74.5 },
  "LIU":   { adjOE: 95.2, adjDE: 106.8, tempo: 68, rank: 275, ppg: 64.5, oppg: 73.2 },
  "QU":    { adjOE: 104.2, adjDE: 102.8, tempo: 68, rank: 181, ppg: 70.8, oppg: 71.2 },
  // First Four / Play-in teams
  "TSU":   { adjOE: 99.8, adjDE: 103.5, tempo: 68, rank: 187, ppg: 67.5, oppg: 72.1 },
  "WRST":  { adjOE: 101.2, adjDE: 102.5, tempo: 67, rank: 140, ppg: 67.8, oppg: 69.8 },
  // Other teams appearing in bracket
  "GMASON":{ adjOE: 101.8, adjDE: 101.8, tempo: 66, rank: 96, ppg: 67.2, oppg: 69.5 },
  "MIZ":   { adjOE: 107.8, adjDE: 101.7, tempo: 68, rank: 52, ppg: 73.2, oppg: 70.5 },
  "WASH":  { adjOE: 105.4, adjDE: 100.9, tempo: 67, rank: 53, ppg: 70.5, oppg: 69.2 },
  "VT":    { adjOE: 105.5, adjDE: 100.1, tempo: 67, rank: 55, ppg: 70.8, oppg: 68.5 },
  "FSU":   { adjOE: 106.1, adjDE: 101.0, tempo: 68, rank: 56, ppg: 72.1, oppg: 70.2 },
  "STAN":  { adjOE: 105.2, adjDE: 100.7, tempo: 66, rank: 57, ppg: 69.5, oppg: 67.8 },
  "NW":    { adjOE: 105.6, adjDE: 101.7, tempo: 66, rank: 58, ppg: 69.8, oppg: 68.5 },
  "WVU":   { adjOE: 97.8, adjDE: 92.9, tempo: 64, rank: 59, ppg: 62.5, oppg: 60.8 },
  "LSU":   { adjOE: 107.5, adjDE: 103.3, tempo: 70, rank: 60, ppg: 75.2, oppg: 73.8 },
  "BSU":   { adjOE: 104.9, adjDE: 100.6, tempo: 66, rank: 61, ppg: 69.2, oppg: 67.5 },
  "GCU":   { adjOE: 99.9, adjDE: 93.3, tempo: 65, rank: 62, ppg: 65.1, oppg: 61.2 },
  "TLSA":  { adjOE: 110.4, adjDE: 103.2, tempo: 69, rank: 63, ppg: 76.1, oppg: 73.5 },
  "MISS":  { adjOE: 103.1, adjDE: 97.1, tempo: 68, rank: 65, ppg: 70.1, oppg: 67.8 },
  "OKST":  { adjOE: 108.3, adjDE: 104.5, tempo: 69, rank: 66, ppg: 74.5, oppg: 73.2 },
};

// All aliases mapping various ESPN/Odds API names to our keys
const ALIASES = {
  "OHIOST": "OSU", "OHIOSTATE": "OSU", "OHIO": "OSU",
  "TEXASTECH": "TTU", "IOWASTATE": "IAST", "IOWAST": "IAST", "ISU": "IAST",
  "MICHIGANSTATE": "MSU", "MICHST": "MSU", "MICHSTATE": "MSU",
  "MICHIGAN": "MICH",
  "NORTHCAROLINA": "UNC", "SAINTMARYS": "STMR", "STMARYS": "STMR", "SMC": "STMR",
  "STJOHNS": "SJU", "SAINTJOHNS": "SJU",
  "UTAHSTATE": "UTST", "UTAHST": "UTST",
  "SAINTLOUIS": "STL", "STLOUIS": "STL", "SLU": "STL",
  "SANDIEGOSTATE": "SDSU", "SANDIEGOST": "SDSU",
  "NCSTATE": "NCST", "NORTHCAROLINAST": "NCST",
  "HIGHPOINT": "HP", "HPU": "HP",
  "KENNESAW": "KENN", "KENNST": "KENN", "KENNEWST": "KENN", "KSU": "KENN",
  "LIBERTY": "LIB", "UNCWILMINGTON": "UNCW",
  "MOUNTSTMARYS": "MSM", "MTSTMARYS": "MSM", "MSMARY": "MSM", "MOUNT": "MSM",
  "MIAMIFLORIDA": "MIA", "MIAMIFL": "MIA",
  "MIAMIOHIO": "MOH", "MIAMIOH": "MOH",
  "SOUTHFLORIDA": "USF", "NEWMEXICO": "UNM",
  "SETONHALL": "HALL", "SHU": "HALL",
  "SANTACLARA": "SC", "SCU": "SC",
  "VIRGINIATECH": "VT", "VATECH": "VT",
  "OKLAHOMASTATE": "OKST", "OKLAHOMAST": "OKST",
  "TEXASAM": "TXAM", "TAMU": "TXAM",
  "AMERICAN": "AMRC", "GEORGEMASON": "GMASON", "GMU": "GMASON",
  "GRANDCANYON": "GCU",
  "BOISESTATE": "BSU", "BOISEST": "BSU",
  "WESTVIRGINIA": "WVU",
  "LOUISVILLE": "LOU",
  "VILLANOVA": "VILL", "NOVA": "VILL",
  "CONNECTICUT": "CONN", "UCONN": "CONN",
  "VANDERBILT": "VAN", "VANDY": "VAN",
  "HOUSTON": "HOU",
  "GONZAGA": "GONZ", "ZAGS": "GONZ",
  "VIRGINIA": "UVA",
  "TENNESSEE": "TENN",
  "ALABAMA": "ALA", "BAMA": "ALA",
  "ARKANSAS": "ARK",
  "KENTUCKY": "UK",
  "GEORGIA": "GA", "UGA": "GA",
  "CLEMSON": "CLEM",
  "AUBURN": "AUB",
  "OKLAHOMA": "OKLA", "OU": "OKLA",
  "INDIANA": "IND",
  "BAYLOR": "BAY",
  "MISSOURI": "MIZ",
  "PURDUE": "PUR",
  "ILLINOIS": "ILL",
  "NEBRASKA": "NEB",
  "WISCONSIN": "WIS",
  "IDAHO": "IDHO",
  "HOWARD": "HOW",
  "SIENA": "SIE",
  "IOWA": "IOWA",
  "KANSAS": "KU",
  "FLORIDA": "FLA",
  "ARIZONA": "ARIZ",
  "DUKE": "DUKE",
  "TEXAS": "TEX",
  "STANFORD": "STAN",
  "NORTHWESTERN": "NW",
  "TULSA": "TLSA",
  "TROY": "TROY",
  "CINCINNATI": "CIN", "CINCY": "CIN",
  "FURMAN": "FUR", "PALADINS": "FUR",
  "TENNESSEESTATE": "TSU", "TENNST": "TSU", "TNST": "TSU",
  "PRAIRIEVIEW": "PVAM", "PRAIRIEVIEWAM": "PVAM", "PRAIRIE": "PVAM",
  "LONGISLAND": "LIU", "LIUSHARKS": "LIU",
  "WRIGHTSTATE": "WRST", "WRIGHTST": "WRST", "WRIGHT": "WRST",
  "NORTHDAKOTASTATE": "NDSU", "NORTHDAKOTAST": "NDSU", "NDAK": "NDSU",
  "HOFSTRA": "HOF",
  "MCNEESE": "MCN", "MCNEESESTATE": "MCN", "MCNEESEST": "MCN",
  "QUEENS": "QU",
  "CALBAPTIST": "CBU", "CALIFORNIABAPTIST": "CBU", "CALBAP": "CBU",
  "NORTHERNIOWA": "UNI", "NORTIOWA": "UNI",
  "CENTRALFLORIDA": "UCF",
  "FLORIDASTATE": "FSU", "FLORIDAST": "FSU",
  "AKRON": "AKRN", "AKRONZIPS": "AKRN",
  "OLEMISS": "MISS", "MISSISSIPPI": "MISS",
};

function getTeamStats(abbr) {
  if (!abbr) return null;
  const key = abbr.toUpperCase().replace(/[^A-Z]/g, "");
  if (TEAM_STATS[key]) return { ...TEAM_STATS[key], abbr: key };
  if (ALIASES[key] && TEAM_STATS[ALIASES[key]]) return { ...TEAM_STATS[ALIASES[key]], abbr: ALIASES[key] };
  // Partial match
  for (const [k, v] of Object.entries(TEAM_STATS)) {
    if (key.includes(k) || k.includes(key)) return { ...v, abbr: k };
  }
  for (const [alias, target] of Object.entries(ALIASES)) {
    if (key.includes(alias) || alias.includes(key)) {
      if (TEAM_STATS[target]) return { ...TEAM_STATS[target], abbr: target };
    }
  }
  return null;
}

function kenpomPredict(awayAbbr, homeAbbr) {
  const away = getTeamStats(awayAbbr);
  const home = getTeamStats(homeAbbr);
  if (!away || !home) return null;

  const D1_AVG = 100;
  const projPace = Math.min(away.tempo, home.tempo) * 0.6 + Math.max(away.tempo, home.tempo) * 0.4;
  const awayPPP = (away.adjOE * (home.adjDE / D1_AVG)) / 100;
  const homePPP = (home.adjOE * (away.adjDE / D1_AVG)) / 100;
  const awayPts = Math.round(awayPPP * projPace * 10) / 10;
  const homePts = Math.round(homePPP * projPace * 10) / 10;
  const tourneyFactor = 0.97;
  const awayFinal = Math.round(awayPts * tourneyFactor * 10) / 10;
  const homeFinal = Math.round(homePts * tourneyFactor * 10) / 10;
  const projTotal = Math.round((awayFinal + homeFinal) * 10) / 10;
  const projSpread = Math.round((homeFinal - awayFinal) * 10) / 10;

  return {
    awayPts: awayFinal, homePts: homeFinal,
    total: projTotal, spread: projSpread,
    pace: projPace, awayStats: away, homeStats: home,
    method: "KenPom efficiency model"
  };
}

export { getTeamStats, kenpomPredict };
