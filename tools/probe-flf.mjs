// Einmalig: Felder der FLF-Schnittstelle über die Vorschläge in Fehlermeldungen finden.
const API = "https://extranet.flf.lu/api/graphql";
const q = async (query, variables) => { const r = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }) }); return (await r.text()); };
const W = ["name","id","code","address","street","city","town","zip","postalCode","locality","country","latitude","longitude","lat","lng","gps","surface","type","capacity","email","phone","telephone","website","url","logo","picture","photo","image","colors","color","shirt","founded","foundation","president","secretary","contact","shortName","longName","description","comment","number","label","category","age","gender","sex","division","club","clubId","team","teams","season","seasonId","date","matchDate","time","referee","referees","official","officials","player","players","lineup","lineups","events","event","goal","goals","card","cards","scorer","scorers","substitution","spectators","attendance","report","sheet","status","isPlayed","isForfait","homeScore","halfTime","halfTimeHomeScore","firstHalf","result","results","order","sortOrder","active","isActive","matchType","ageCategory","sportField","field","group","serie","series","level","promotion","relegation","ranking","rankings","points","penalty","penalties","extraTime","stadium","venue","matchNumber","gameday","round","weather","createdAt","updatedAt","lastUpdate","modified"];
const sug = t => [...t.matchAll(/Did you mean ([^?]+)\?/g)].map(m => m[1]).join(" | ");
async function typ(name, wrap, vars) {
  const gefunden = new Set();
  for (const w of W) { const t = await q(wrap(w), vars); const s = sug(t); if (!t.includes("Cannot query field")) gefunden.add(w + "✓"); if (s) s.split(/[|,]|\bor\b/).forEach(x => gefunden.add(x.trim().replace(/"/g, ""))); }
  console.log("TYP", name, "→", [...gefunden].filter(Boolean).sort().join(", "));
}
const crit = { c: { seasonId: "20262027", clubId: 500062, startDate: "2026-11-01", endDate: "2026-11-02", matchTypeId: "ALL", ageCategoryId: 4 } };
const mq = sel => `query($c: MatchCriteria){ matches(criteria:$c){ ${sel} } }`;
await typ("Club", w => `{ clubs { ${w} } }`);
await typ("SportField", w => `{ sportFields { ${w} } }`);
await typ("Division", w => `{ divisions { ${w} } }`);
await typ("AgeCategory", w => `{ ageCategories { ${w} } }`);
await typ("Season", w => `{ seasons { ${w} } }`);
await typ("MatchWrapper", w => mq(w), crit);
await typ("Match", w => mq(`match{ ${w} }`), crit);
await typ("Team", w => mq(`homeTeam{ ${w} }`), crit);
await typ("MatchSportField", w => mq(`sportField{ ${w} }`), crit);
await typ("MatchDivision", w => mq(`division{ ${w} }`), crit);
for (const a of ["id","matchId","request"]) console.log("ARG match", a, "→", (await q(`{ match(${a}: 1) { id } }`)).slice(0, 300));
console.log("ARG match req →", (await q(`{ match(request:{ xyz: 1 }) { id } }`)).slice(0, 400));
console.log("ARG teams req →", (await q(`{ teams(request:{ xyz: 1 }) { id } }`)).slice(0, 400));
console.log("Q ageCategories names →", (await q(`{ ageCategories { id name } }`)).slice(0, 900));
